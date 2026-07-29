import type { ImportCounts, ParsedFile, QuarantineCode } from '@velograph/shared';
import { CANONICAL_UNITS, sha256Hex } from '@velograph/shared';
import { Repository, type Database } from '@velograph/db';
import {
  AdapterError,
  ADAPTER_VERSION,
  parseHaeCsv,
  parseHaeFilenameTimestamps,
  parseHaeGpx,
  parseHaeFilename,
} from './adapters.ts';
import {
  associateWorkout,
  DEFAULT_ASSOCIATION_TOLERANCE_MS,
  sampleTimeRange,
} from './association.ts';
import { GPX_PARSER_VERSION } from './gpx.ts';
import { extractZip, ZIP_PARSER_VERSION, ZipError, type ZipLimits } from './zip.ts';

export const IMPORTER_VERSION = 'importer-v2';

export interface ImportFile {
  name: string;
  data: Uint8Array;
}

export interface ImportResult extends ImportCounts {
  batchId: number;
  quarantinedFiles: { name: string; code: QuarantineCode }[];
}

export type ImportFileGroupLoader = () => readonly ImportFile[];
export type ImportFileGroups = Iterable<ImportFileGroupLoader>;
export interface RunImportOptions {
  now?: number;
  toleranceMs?: number;
  timeZone?: string;
  zipLimits?: ZipLimits;
}

interface PreparedImportFile extends ImportFile {
  expansionError?: QuarantineCode;
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
  opts: RunImportOptions = {},
): ImportResult {
  return runImportGroups(db, [() => inputFiles], opts);
}

/**
 * Import a lazily produced sequence of file groups as one atomic batch.
 *
 * The iterable is consumed inside the transaction and only the current
 * association group's buffers are retained. This lets path-based imports
 * walk metadata first, then read/process one bounded ride group at a time
 * without weakening IMP-007: an I/O or parser-infrastructure failure in a
 * later group rolls back every earlier group in the confirmed import.
 */
export function runImportGroups(
  db: Database,
  inputGroups: ImportFileGroups,
  opts: RunImportOptions = {},
): ImportResult {
  const repo = new Repository(db);
  const now = opts.now ?? Date.now();
  const toleranceMs = opts.toleranceMs ?? DEFAULT_ASSOCIATION_TOLERANCE_MS;

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

    const processGroup = (inputFiles: readonly ImportFile[]): void => {
      // Expand each selected ZIP independently. A malformed outer archive
      // remains an inventory item while valid sibling selections continue.
      const files: PreparedImportFile[] = [];
      for (const f of inputFiles) {
        if (f.name.toLowerCase().endsWith('.zip')) {
          try {
            files.push(...extractZip(f.data, opts.zipLimits));
          } catch (err) {
            files.push({
              ...f,
              expansionError: err instanceof ZipError ? err.code : 'io_error',
            });
          }
        } else {
          files.push(f);
        }
      }
      files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const file of files) {
        const hash = sha256Hex(file.data);
        const existing = repo.findSourceFileByHash(hash);
        const safeName = sanitizeName(file.name);
        if (existing) {
          counts.skippedDuplicates++;
          continue;
        }

        const quarantine = (
          code: QuarantineCode,
          detectedType = 'unknown',
          parserVersion = parserVersionForFile(file.name),
        ) => {
          repo.insertSourceFile({
            batchId: id,
            sha256: hash,
            originalName: safeName,
            detectedType,
            parserVersion,
            status: 'quarantined',
            errorCode: code,
            sizeBytes: file.data.length,
          });
          counts.quarantined++;
          quarantinedFiles.push({ name: safeName, code });
        };

        if (file.expansionError) {
          quarantine(file.expansionError, 'archive:zip', ZIP_PARSER_VERSION);
          continue;
        }

        let parsed: ParsedFile;
        let filenameTimestamps: number[];
        try {
          parsed = parseFile(file, opts.timeZone);
          filenameTimestamps = parseHaeFilenameTimestamps(
            file.name,
            opts.timeZone ? { timeZone: opts.timeZone } : {},
          );
        } catch (err) {
          const code: QuarantineCode =
            err instanceof AdapterError
              ? err.code
              : err instanceof ZipError
                ? err.code
                : 'io_error';
          quarantine(code);
          continue;
        }

        const range = sampleTimeRange(parsed);
        if (!range) {
          quarantine('timestamps_invalid');
          continue;
        }

        const detectedType =
          parsed.kind === 'metric' ? `metric:${parsed.metric}` : `route:${parsed.format}`;
        const candidates = repo.findCandidateWorkouts(
          parsed.workoutType,
          range.start,
          range.end,
          toleranceMs,
        );
        const association = associateWorkout(candidates, range, filenameTimestamps, toleranceMs);
        if (association.status === 'ambiguous') {
          quarantine('association_ambiguous', detectedType);
          continue;
        }
        if (association.status === 'conflict') {
          quarantine('association_conflict', detectedType);
          continue;
        }

        const sourceFileId = repo.insertSourceFile({
          batchId: id,
          sha256: hash,
          originalName: safeName,
          detectedType,
          parserVersion: parserVersionForFile(file.name),
          status: 'imported',
          sizeBytes: file.data.length,
        });

        let workoutId: number;
        if (association.status === 'matched') {
          workoutId = association.workout.id;
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
    };

    for (const loadGroup of inputGroups) {
      // Once processGroup returns, no importer reference keeps that group's
      // source buffers alive while the next loader runs.
      processGroup(loadGroup());
    }

    repo.finishBatch(id, 'committed', counts);
    return id;
  });

  return { batchId, ...counts, quarantinedFiles };
}

function parseFile(file: ImportFile, timeZone?: string): ParsedFile {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.gpx')) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.data);
    } catch {
      throw new AdapterError('malformed_xml', 'GPX is not valid UTF-8');
    }
    return parseHaeGpx(file.name, text);
  }
  if (lower.endsWith('.csv')) {
    if (!parseHaeFilename(file.name)) {
      throw new AdapterError('unsupported_file_type', 'filename not recognized');
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(file.data);
    return parseHaeCsv(file.name, text, timeZone ? { timeZone } : {});
  }
  throw new AdapterError('unsupported_file_type', 'extension not supported');
}

function parserVersionForFile(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.gpx')) return GPX_PARSER_VERSION;
  if (lower.endsWith('.zip')) return ZIP_PARSER_VERSION;
  return ADAPTER_VERSION;
}

/** Keep only the base name; never store user directory structure. */
function sanitizeName(name: string): string {
  return name.split(/[\\/]/).filter(Boolean).pop() ?? 'unnamed';
}
