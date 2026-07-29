import type { ImportCounts, ParsedFile, QuarantineCode } from '@velograph/shared';
import { CANONICAL_UNITS, sha256Hex } from '@velograph/shared';
import { Repository, type Database } from '@velograph/db';
import {
  AdapterError,
  ADAPTER_VERSION,
  parseHaeCsv,
  parseHaeGpx,
  parseHaeFilename,
} from './adapters.ts';
import { DEFAULT_ASSOCIATION_TOLERANCE_MS, sampleTimeRange } from './association.ts';
import { extractZip, ZipError } from './zip.ts';

export const IMPORTER_VERSION = 'importer-v1';

export interface ImportFile {
  name: string;
  data: Uint8Array;
}

export interface ImportResult extends ImportCounts {
  batchId: number;
  quarantinedFiles: { name: string; code: QuarantineCode }[];
}

/**
 * Run one confirmed import as a single atomic transaction (IMP-007): either
 * the whole batch commits or nothing does. Individual malformed files are
 * quarantined (a source_files row with an error code and no data rows —
 * IMP-008) without aborting the batch; a storage-level failure rolls back
 * everything including the batch row.
 *
 * Idempotency (IMP-003): files whose SHA-256 already exists are recorded as
 * skipped duplicates and contribute no workouts, samples, or route points.
 *
 * GPX is preferred for route geometry; a route CSV is only used when the
 * workout has no GPX route, and a GPX arriving later replaces a CSV route
 * (IMP-006, provenance preserved via routes.source_format + source_file_id).
 */
export function runImport(
  db: Database,
  inputFiles: ImportFile[],
  opts: { now?: number; toleranceMs?: number; timeZone?: string } = {},
): ImportResult {
  const repo = new Repository(db);
  const now = opts.now ?? Date.now();
  const toleranceMs = opts.toleranceMs ?? DEFAULT_ASSOCIATION_TOLERANCE_MS;

  // Expand ZIPs before the transaction; a broken ZIP fails the whole request.
  const files: ImportFile[] = [];
  for (const f of inputFiles) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      files.push(...extractZip(f.data));
    } else {
      files.push(f);
    }
  }
  // Deterministic processing order regardless of selection order; GPX before
  // route CSV within the same instant-window so CSV fallback logic is stable.
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const counts: ImportCounts = {
    imported: 0,
    skippedDuplicates: 0,
    quarantined: 0,
    workoutsCreated: 0,
    workoutsUpdated: 0,
  };
  const quarantinedFiles: { name: string; code: QuarantineCode }[] = [];

  const batchId = repo.transaction(() => {
    const id = repo.createBatch(IMPORTER_VERSION, now);

    for (const file of files) {
      const hash = sha256Hex(file.data);
      const existing = repo.findSourceFileByHash(hash);
      const safeName = sanitizeName(file.name);
      if (existing) {
        counts.skippedDuplicates++;
        continue;
      }

      let parsed: ParsedFile;
      try {
        parsed = parseFile(file, opts.timeZone);
      } catch (err) {
        const code: QuarantineCode =
          err instanceof AdapterError ? err.code : err instanceof ZipError ? err.code : 'io_error';
        repo.insertSourceFile({
          batchId: id,
          sha256: hash,
          originalName: safeName,
          detectedType: 'unknown',
          parserVersion: ADAPTER_VERSION,
          status: 'quarantined',
          errorCode: code,
          sizeBytes: file.data.length,
        });
        counts.quarantined++;
        quarantinedFiles.push({ name: safeName, code });
        continue;
      }

      const range = sampleTimeRange(parsed);
      if (!range) {
        repo.insertSourceFile({
          batchId: id,
          sha256: hash,
          originalName: safeName,
          detectedType: 'unknown',
          parserVersion: ADAPTER_VERSION,
          status: 'quarantined',
          errorCode: 'timestamps_invalid',
          sizeBytes: file.data.length,
        });
        counts.quarantined++;
        quarantinedFiles.push({ name: safeName, code: 'timestamps_invalid' });
        continue;
      }

      const detectedType =
        parsed.kind === 'metric' ? `metric:${parsed.metric}` : `route:${parsed.format}`;
      const sourceFileId = repo.insertSourceFile({
        batchId: id,
        sha256: hash,
        originalName: safeName,
        detectedType,
        parserVersion: ADAPTER_VERSION,
        status: 'imported',
        sizeBytes: file.data.length,
      });

      // Associate by type + internal sample times + tolerance (IMP-005).
      const candidate = repo.findCandidateWorkout(
        parsed.workoutType,
        range.start,
        range.end,
        toleranceMs,
      );
      let workoutId: number;
      if (candidate) {
        workoutId = candidate.id;
        repo.extendWorkoutSpan(workoutId, range.start, range.end);
        counts.workoutsUpdated++;
      } else {
        workoutId = repo.createWorkout(parsed.workoutType, range.start, range.end, 'import');
        counts.workoutsCreated++;
      }

      if (parsed.kind === 'metric') {
        repo.insertMetricSeries({
          workoutId,
          sourceFileId,
          metric: parsed.metric,
          unit: CANONICAL_UNITS[parsed.metric],
          source: parsed.source,
          samples: parsed.samples,
        });
      } else {
        const existingFormat = repo.workoutRouteFormat(workoutId);
        if (existingFormat === undefined) {
          repo.insertRoute({
            workoutId,
            sourceFileId,
            format: parsed.format,
            segments: parsed.segments,
            distanceM: null,
          });
        } else if (existingFormat === 'csv' && parsed.format === 'gpx') {
          repo.deleteRoutesForWorkout(workoutId);
          repo.insertRoute({
            workoutId,
            sourceFileId,
            format: 'gpx',
            segments: parsed.segments,
            distanceM: null,
          });
        }
        // gpx already present, or csv arriving when a route exists: keep the
        // preferred geometry; the source file row preserves provenance.
      }
      counts.imported++;
    }

    repo.finishBatch(id, 'committed', counts);
    return id;
  });

  return { batchId, ...counts, quarantinedFiles };
}

function parseFile(file: ImportFile, timeZone?: string): ParsedFile {
  const lower = file.name.toLowerCase();
  const text = new TextDecoder('utf-8', { fatal: false }).decode(file.data);
  if (lower.endsWith('.gpx')) return parseHaeGpx(file.name, text);
  if (lower.endsWith('.csv')) {
    if (!parseHaeFilename(file.name)) {
      throw new AdapterError('unsupported_file_type', 'filename not recognized');
    }
    return parseHaeCsv(file.name, text, timeZone ? { timeZone } : {});
  }
  throw new AdapterError('unsupported_file_type', 'extension not supported');
}

/** Keep only the base name; never store user directory structure. */
function sanitizeName(name: string): string {
  return name.split(/[\\/]/).filter(Boolean).pop() ?? 'unnamed';
}
