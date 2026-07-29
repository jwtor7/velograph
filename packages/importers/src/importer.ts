import type { ImportCounts, ImportSkipCode, ParsedFile, QuarantineCode } from '@velograph/shared';
import { CANONICAL_UNITS, sha256Hex } from '@velograph/shared';
import { Repository, type Database } from '@velograph/db';
import {
  AdapterError,
  ADAPTER_VERSION,
  classifyImportFileName,
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
import { assertGpxByteLength, GPX_PARSER_VERSION, GpxError } from './gpx.ts';
import {
  createZipDecodedBudget,
  DEFAULT_ZIP_LIMITS,
  extractZip,
  ZIP_PARSER_VERSION,
  ZipError,
  type ZipLimits,
} from './zip.ts';

export const IMPORTER_VERSION = 'importer-v4';

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
  /**
   * Cooperative cancellation for browser/API imports. Every observed abort
   * escapes the SQLite transaction so no partial batch can commit.
   */
  signal?: AbortSignal;
}

interface PreparedImportFile extends ImportFile {
  expansionError?: QuarantineCode;
}

export class ImportAbortedError extends Error {
  readonly code = 'import_cancelled';

  constructor() {
    super('import cancelled');
    this.name = 'ImportAbortedError';
  }
}

export function throwIfImportAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportAbortedError();
}

/**
 * Run one confirmed import as a single atomic transaction (IMP-007): either
 * the whole batch commits or nothing does. Individual malformed files are
 * quarantined (a source_files row with an error code and no data rows —
 * IMP-008) without aborting the batch; a storage-level failure rolls back
 * everything including the batch row.
 *
 * Idempotency (IMP-003/010): files whose SHA-256 and parser version already
 * exist are skipped. When that version changes, the hash-unique inventory row
 * is reused and its normalized rows are transactionally replaced only after a
 * complete replacement parse succeeds. Failed attempts are recorded separately
 * without mutating last-known-good source, workout, or user-authored data.
 *
 * GPX is preferred for route geometry; a route CSV is only used when the
 * workout has no GPX route, and a GPX arriving later replaces a CSV route.
 * workout_source_files preserves every successfully associated source even
 * when its geometry is superseded or fallback-only (IMP-006).
 */
export function runImport(
  db: Database,
  inputFiles: ImportFile[],
  opts: RunImportOptions = {},
): ImportResult {
  return runImportGroups(db, [() => inputFiles], opts);
}

/**
 * Import lazily loaded association groups inside the same atomic transaction.
 * Only the current group's bytes and ZIP expansion budget are retained. A
 * loose-file import is one group, so every selected archive still shares one
 * decoded-byte cap; path import resets that cap only after releasing the prior
 * bounded ride group.
 */
export function runImportGroups(
  db: Database,
  inputGroups: ImportFileGroups,
  opts: RunImportOptions = {},
): ImportResult {
  const steps = runImportSteps(db, inputGroups, opts);
  return new Repository(db).transaction(() => consumeImportSteps(steps));
}

/**
 * Cancellable variant for the loopback API. The same atomic transaction stays
 * open while bounded checkpoints yield to the Node event loop, allowing a
 * disconnected browser request to update its AbortSignal before the next file
 * or group is processed.
 */
export async function runImportCancellable(
  db: Database,
  inputFiles: ImportFile[],
  opts: RunImportOptions = {},
): Promise<ImportResult> {
  return runImportGroupsCancellable(db, [() => inputFiles], opts);
}

export async function runImportGroupsCancellable(
  db: Database,
  inputGroups: ImportFileGroups,
  opts: RunImportOptions = {},
): Promise<ImportResult> {
  throwIfImportAborted(opts.signal);
  db.exec('BEGIN IMMEDIATE');
  try {
    const steps = runImportSteps(db, inputGroups, opts);
    for (;;) {
      const step = steps.next();
      if (step.done) {
        db.exec('COMMIT');
        return step.value;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

function consumeImportSteps(steps: Generator<void, ImportResult>): ImportResult {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

function* importCheckpoint(signal: AbortSignal | undefined): Generator<void, void> {
  throwIfImportAborted(signal);
  yield;
  throwIfImportAborted(signal);
}

function* runImportSteps(
  db: Database,
  inputGroups: ImportFileGroups,
  opts: RunImportOptions,
): Generator<void, ImportResult> {
  throwIfImportAborted(opts.signal);
  const repo = new Repository(db);
  const now = opts.now ?? Date.now();
  const toleranceMs = opts.toleranceMs ?? DEFAULT_ASSOCIATION_TOLERANCE_MS;

  const zipLimits = opts.zipLimits ?? DEFAULT_ZIP_LIMITS;

  const counts: ImportCounts = {
    imported: 0,
    skippedDuplicates: 0,
    skipped: 0,
    skippedByCode: {
      unmodelled_metric: 0,
      non_cycling_workout: 0,
    },
    quarantined: 0,
    workoutsCreated: 0,
    workoutsUpdated: 0,
  };
  const quarantinedFiles: { name: string; code: QuarantineCode }[] = [];

  yield* importCheckpoint(opts.signal);
  const id = repo.createBatch(IMPORTER_VERSION, now);

  function* processGroup(inputFiles: readonly ImportFile[]): Generator<void, void> {
    yield* importCheckpoint(opts.signal);
    // A malformed archive remains an inventory item so valid siblings can
    // continue. Sorting makes processing deterministic across selection
    // order and keeps each folder group bounded in memory.
    const files: PreparedImportFile[] = [];
    const zipDecodedBudget = createZipDecodedBudget(zipLimits.maxTotalBytes);
    const orderedInputFiles = [...inputFiles].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const f of orderedInputFiles) {
      yield* importCheckpoint(opts.signal);
      if (f.name.toLowerCase().endsWith('.zip')) {
        try {
          files.push(...extractZip(f.data, zipLimits, zipDecodedBudget));
          yield* importCheckpoint(opts.signal);
        } catch (err) {
          if (err instanceof ImportAbortedError) throw err;
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
      yield* importCheckpoint(opts.signal);
      const candidate = classifyImportFileName(file.name);
      if (candidate.kind === 'unmodelled_metric' || candidate.kind === 'non_cycling_workout') {
        const code: ImportSkipCode = candidate.kind;
        counts.skipped++;
        counts.skippedByCode[code]++;
        continue;
      }
      const hash = sha256Hex(file.data);
      const existing = repo.findSourceFileByHash(hash);
      const safeName = sanitizeName(file.name);
      const currentParserVersion = parserVersionForFile(file.name);
      if (existing?.parserVersion === currentParserVersion) {
        counts.skippedDuplicates++;
        continue;
      }
      const ownedWorkoutIds = existing ? repo.workoutIdsForSourceFile(existing.id) : [];
      const persistSourceFile = (row: {
        detectedType: string;
        parserVersion: string;
        status: 'imported' | 'quarantined';
        errorCode?: QuarantineCode;
      }): number => {
        const source = {
          batchId: id,
          originalName: safeName,
          detectedType: row.detectedType,
          parserVersion: row.parserVersion,
          status: row.status,
          sizeBytes: file.data.length,
          ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
        };
        if (existing) {
          repo.updateSourceFile(existing.id, source);
          return existing.id;
        }
        return repo.insertSourceFile({ ...source, sha256: hash });
      };

      const quarantine = (
        code: QuarantineCode,
        detectedType = 'unknown',
        parserVersion = currentParserVersion,
      ) => {
        if (existing) {
          repo.recordSourceFileReprocessingFailure({
            sourceFileId: existing.id,
            batchId: id,
            attemptedParserVersion: parserVersion,
            errorCode: code,
            createdAt: now,
          });
        } else {
          persistSourceFile({
            detectedType,
            parserVersion,
            status: 'quarantined',
            errorCode: code,
          });
        }
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
          err instanceof AdapterError ? err.code : err instanceof ZipError ? err.code : 'io_error';
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
      let matchedWorkoutId: number | undefined;
      if (existing && ownedWorkoutIds.length > 1) {
        // A source spanning multiple workouts has no unique stable identity.
        // Do not delete or move any of its existing normalized rows.
        quarantine('association_ambiguous', detectedType);
        continue;
      }
      if (existing && ownedWorkoutIds.length === 1) {
        // The source relationship is stronger than corrected parser timestamps:
        // keep the stable workout id, while still requiring the file's own
        // filename/internal timestamps and workout type to agree.
        const fileEvidence = associateWorkout([], range, filenameTimestamps, toleranceMs);
        const ownedWorkout = repo.getWorkout(ownedWorkoutIds[0]!);
        if (
          fileEvidence.status === 'conflict' ||
          !ownedWorkout ||
          ownedWorkout.type !== parsed.workoutType
        ) {
          quarantine('association_conflict', detectedType);
          continue;
        }
        matchedWorkoutId = ownedWorkout.id;
      } else {
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
        if (association.status === 'matched') matchedWorkoutId = association.workout.id;
      }

      // All parsing, validation, and ownership resolution has succeeded. Only
      // now may this transaction remove the old parser-owned rows.
      const detachedWorkoutIds = existing ? repo.detachSourceFileData(existing.id) : [];
      const sourceFileId = persistSourceFile({
        detectedType,
        parserVersion: currentParserVersion,
        status: 'imported',
      });

      let workoutId: number;
      if (matchedWorkoutId !== undefined) {
        workoutId = matchedWorkoutId;
        repo.invalidateWorkoutDerivedOutputs(workoutId);
        repo.extendWorkoutSpan(workoutId, range.start, range.end);
        counts.workoutsUpdated++;
      } else {
        workoutId = repo.createWorkout(parsed.workoutType, range.start, range.end, 'import');
        counts.workoutsCreated++;
      }
      repo.linkSourceFileToWorkout(workoutId, sourceFileId);

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
        // preferred geometry; the independent workout ownership preserves
        // provenance for the source whose geometry is not active.
      }
      if (existing) repo.finalizeSourceFileReprocessing(detachedWorkoutIds);
      counts.imported++;
      yield* importCheckpoint(opts.signal);
    }
  }

  for (const loadGroup of inputGroups) {
    yield* importCheckpoint(opts.signal);
    const group = loadGroup();
    yield* importCheckpoint(opts.signal);
    yield* processGroup(group);
  }

  yield* importCheckpoint(opts.signal);
  repo.finishBatch(id, 'committed', counts);
  yield* importCheckpoint(opts.signal);
  return { batchId: id, ...counts, quarantinedFiles };
}

function parseFile(file: ImportFile, timeZone?: string): ParsedFile {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.gpx')) {
    let text: string;
    try {
      assertGpxByteLength(file.data.byteLength);
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.data);
    } catch (err) {
      if (err instanceof GpxError) throw new AdapterError(err.code, err.message);
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
