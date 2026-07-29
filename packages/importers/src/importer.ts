import type {
  ImportCounts,
  ImportSkipCode,
  MetricKind,
  MetricSample,
  ParsedFile,
  QuarantineCode,
  RouteSegment,
} from '@velograph/shared';
import { CANONICAL_UNITS, sha256Hex } from '@velograph/shared';
import { Repository, type Database } from '@velograph/db';
import {
  AdapterError,
  ADAPTER_VERSION,
  classifyImportFileName,
  parseHaeCsvSteps,
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
import { assertCsvByteLength, CsvError } from './csv.ts';
import {
  createZipDecodedBudget,
  DEFAULT_ZIP_LIMITS,
  extractZip,
  ZIP_PARSER_VERSION,
  ZipError,
  type ZipLimits,
} from './zip.ts';

export const IMPORTER_VERSION = 'importer-v4';
export const IMPORT_DB_CHUNK_ROWS = 2_048;

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
  /** Top-level loose file or archive selected by the user. */
  origin: ImportFile;
}

export type ImportPreflightClassification =
  'recognized' | 'duplicate' | 'ambiguous' | 'invalid' | 'unsupported' | ImportSkipCode;

export interface ImportPreflightOutcome {
  classification: ImportPreflightClassification;
  code: QuarantineCode | ImportSkipCode | null;
  detectedType: string | null;
  count: number;
}

export interface ImportPreflightItem {
  name: string;
  sizeBytes: number;
  classification: ImportPreflightClassification | 'mixed';
  detectedType: string | null;
  outcomes: ImportPreflightOutcome[];
}

interface ObservedImportOutcome {
  origin: ImportFile;
  classification: ImportPreflightClassification;
  code: QuarantineCode | ImportSkipCode | null;
  detectedType: string | null;
}

interface RunImportInternalOptions extends RunImportOptions {
  onFileOutcome?: (outcome: ObservedImportOutcome) => void;
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

/**
 * Run the exact import engine as a rollback-only preflight. The live database
 * supplies duplicate and workout-association evidence, while the unconditional
 * rollback guarantees that review creates no batches, source rows, workouts,
 * or normalized samples. Cooperative checkpoints and ZIP limits are identical
 * to confirmed import.
 */
export async function preflightImportCancellable(
  db: Database,
  inputFiles: readonly ImportFile[],
  opts: RunImportOptions = {},
): Promise<ImportPreflightItem[]> {
  return preflightImportGroupsCancellable(db, [() => inputFiles], opts);
}

/**
 * Lazy-group variant used by folder-path review. Only the current bounded
 * association group is retained while the rollback-only simulation runs.
 */
export async function preflightImportGroupsCancellable(
  db: Database,
  inputGroups: ImportFileGroups,
  opts: RunImportOptions = {},
): Promise<ImportPreflightItem[]> {
  throwIfImportAborted(opts.signal);
  const records: {
    name: string;
    sizeBytes: number;
    outcomes: ObservedImportOutcome[];
  }[] = [];
  const recordByOrigin = new WeakMap<
    ImportFile,
    { name: string; sizeBytes: number; outcomes: ObservedImportOutcome[] }
  >();
  function* observedGroups(): ImportFileGroups {
    for (const loadGroup of inputGroups) {
      yield () =>
        loadGroup().map((file) => {
          // Unique wrappers keep repeated references independently attributable.
          const wrapped = { name: file.name, data: file.data };
          const record = {
            name: wrapped.name,
            sizeBytes: wrapped.data.byteLength,
            outcomes: [],
          };
          records.push(record);
          recordByOrigin.set(wrapped, record);
          return wrapped;
        });
    }
  }
  const internalOptions: RunImportInternalOptions = {
    ...opts,
    onFileOutcome: (outcome) => {
      recordByOrigin.get(outcome.origin)?.outcomes.push(outcome);
    },
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    const steps = runImportSteps(db, observedGroups(), internalOptions);
    for (;;) {
      const step = steps.next();
      if (step.done) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    db.exec('ROLLBACK');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }

  return records.map((record) =>
    summarizePreflightItem(record.name, record.sizeBytes, record.outcomes),
  );
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
  opts: RunImportInternalOptions,
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
          const expanded = extractZip(f.data, zipLimits, zipDecodedBudget);
          files.push(...expanded.map((entry) => ({ ...entry, origin: f })));
          if (expanded.length === 0) {
            opts.onFileOutcome?.({
              origin: f,
              classification: 'unsupported',
              code: 'unsupported_file_type',
              detectedType: 'archive:zip',
            });
          }
          yield* importCheckpoint(opts.signal);
        } catch (err) {
          if (err instanceof ImportAbortedError) throw err;
          files.push({
            ...f,
            origin: f,
            expansionError: err instanceof ZipError ? err.code : 'io_error',
          });
        }
      } else {
        files.push({ ...f, origin: f });
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
        opts.onFileOutcome?.({
          origin: file.origin,
          classification: code,
          code,
          detectedType: candidate.detectedType,
        });
        continue;
      }
      const hash = sha256Hex(file.data);
      const existing = repo.findSourceFileByHash(hash);
      const safeName = sanitizeName(file.name);
      const currentParserVersion = parserVersionForFile(file.name);
      if (existing?.parserVersion === currentParserVersion) {
        counts.skippedDuplicates++;
        opts.onFileOutcome?.({
          origin: file.origin,
          classification: 'duplicate',
          code: null,
          detectedType: existing.detectedType,
        });
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
        opts.onFileOutcome?.({
          origin: file.origin,
          classification: preflightClassificationForQuarantine(code),
          code,
          detectedType,
        });
      };

      if (file.expansionError) {
        quarantine(file.expansionError, 'archive:zip', ZIP_PARSER_VERSION);
        continue;
      }

      let parsed: ParsedFile;
      let filenameTimestamps: number[];
      try {
        parsed = yield* parseFileSteps(file, opts.timeZone, opts.signal);
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
        yield* insertMetricSeriesSteps(
          repo,
          {
            workoutId,
            sourceFileId,
            metric: parsed.metric,
            unit: CANONICAL_UNITS[parsed.metric],
            source: parsed.source,
            samples: parsed.samples,
          },
          opts.signal,
        );
      } else {
        const existingFormat = repo.workoutRouteFormat(workoutId);
        if (existingFormat === undefined) {
          yield* insertRouteSteps(
            repo,
            {
              workoutId,
              sourceFileId,
              format: parsed.format,
              segments: parsed.segments,
              distanceM: null,
            },
            opts.signal,
          );
        } else if (existingFormat === 'csv' && parsed.format === 'gpx') {
          repo.deleteRoutesForWorkout(workoutId);
          yield* insertRouteSteps(
            repo,
            {
              workoutId,
              sourceFileId,
              format: 'gpx',
              segments: parsed.segments,
              distanceM: null,
            },
            opts.signal,
          );
        }
        // gpx already present, or csv arriving when a route exists: keep the
        // preferred geometry; the independent workout ownership preserves
        // provenance for the source whose geometry is not active.
      }
      if (existing) repo.finalizeSourceFileReprocessing(detachedWorkoutIds);
      counts.imported++;
      opts.onFileOutcome?.({
        origin: file.origin,
        classification: 'recognized',
        code: null,
        detectedType,
      });
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

function preflightClassificationForQuarantine(code: QuarantineCode): ImportPreflightClassification {
  if (code === 'association_ambiguous') return 'ambiguous';
  if (code === 'unsupported_file_type') return 'unsupported';
  return 'invalid';
}

function summarizePreflightItem(
  name: string,
  sizeBytes: number,
  observed: readonly ObservedImportOutcome[],
): ImportPreflightItem {
  const outcomes = new Map<string, ImportPreflightOutcome>();
  for (const item of observed) {
    const key = `${item.classification}\u0000${item.code ?? ''}\u0000${item.detectedType ?? ''}`;
    const existing = outcomes.get(key);
    if (existing) {
      existing.count++;
    } else {
      outcomes.set(key, {
        classification: item.classification,
        code: item.code,
        detectedType: item.detectedType,
        count: 1,
      });
    }
  }
  if (outcomes.size === 0) {
    outcomes.set('unsupported\u0000unsupported_file_type\u0000', {
      classification: 'unsupported',
      code: 'unsupported_file_type',
      detectedType: null,
      count: 1,
    });
  }
  const summarized = [...outcomes.values()];
  const classifications = new Set(summarized.map((outcome) => outcome.classification));
  const detectedTypes = new Set(
    summarized
      .map((outcome) => outcome.detectedType)
      .filter((value): value is string => value !== null),
  );
  return {
    name,
    sizeBytes,
    classification: classifications.size === 1 ? summarized[0]!.classification : 'mixed',
    detectedType: detectedTypes.size === 1 ? [...detectedTypes][0]! : null,
    outcomes: summarized,
  };
}

function* parseFileSteps(
  file: ImportFile,
  timeZone: string | undefined,
  signal: AbortSignal | undefined,
): Generator<void, ParsedFile> {
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
    let text: string;
    try {
      assertCsvByteLength(file.data.byteLength);
      text = new TextDecoder('utf-8', { fatal: false }).decode(file.data);
    } catch (err) {
      if (err instanceof CsvError) throw new AdapterError(err.code, err.message);
      throw err;
    }
    const parseSteps = parseHaeCsvSteps(file.name, text, timeZone ? { timeZone } : {});
    for (;;) {
      throwIfImportAborted(signal);
      const step = parseSteps.next();
      if (step.done) return step.value;
      yield* importCheckpoint(signal);
    }
  }
  throw new AdapterError('unsupported_file_type', 'extension not supported');
}

function* insertMetricSeriesSteps(
  repo: Repository,
  row: {
    workoutId: number;
    sourceFileId: number;
    metric: MetricKind;
    unit: string;
    source: string | null;
    samples: MetricSample[];
  },
  signal: AbortSignal | undefined,
): Generator<void, number> {
  const first = row.samples[0]!;
  const last = row.samples[row.samples.length - 1]!;
  const seriesId = repo.createMetricSeries({
    workoutId: row.workoutId,
    sourceFileId: row.sourceFileId,
    metric: row.metric,
    unit: row.unit,
    source: row.source,
    startUtc: first.t,
    endUtc: last.t,
    sampleCount: row.samples.length,
  });
  for (let start = 0; start < row.samples.length; start += IMPORT_DB_CHUNK_ROWS) {
    repo.insertMetricSampleChunk(seriesId, row.samples.slice(start, start + IMPORT_DB_CHUNK_ROWS));
    yield* importCheckpoint(signal);
  }
  return seriesId;
}

function* insertRouteSteps(
  repo: Repository,
  row: {
    workoutId: number;
    sourceFileId: number;
    format: 'gpx' | 'csv';
    segments: RouteSegment[];
    distanceM: number | null;
  },
  signal: AbortSignal | undefined,
): Generator<void, number> {
  let pointCount = 0;
  let latMin = Number.POSITIVE_INFINITY;
  let latMax = Number.NEGATIVE_INFINITY;
  let lonMin = Number.POSITIVE_INFINITY;
  let lonMax = Number.NEGATIVE_INFINITY;
  for (const segment of row.segments) {
    for (const point of segment.points) {
      pointCount++;
      if (point.lat < latMin) latMin = point.lat;
      if (point.lat > latMax) latMax = point.lat;
      if (point.lon < lonMin) lonMin = point.lon;
      if (point.lon > lonMax) lonMax = point.lon;
      if (pointCount % IMPORT_DB_CHUNK_ROWS === 0) yield* importCheckpoint(signal);
    }
  }
  if (pointCount === 0) throw new Error('route_has_no_points');

  const routeId = repo.createRoute({
    workoutId: row.workoutId,
    sourceFileId: row.sourceFileId,
    format: row.format,
    pointCount,
    distanceM: row.distanceM,
    bounds: { latMin, latMax, lonMin, lonMax },
  });
  for (let segmentIndex = 0; segmentIndex < row.segments.length; segmentIndex++) {
    const points = row.segments[segmentIndex]!.points;
    for (let start = 0; start < points.length; start += IMPORT_DB_CHUNK_ROWS) {
      repo.insertRoutePointChunk(
        routeId,
        segmentIndex,
        start,
        points.slice(start, start + IMPORT_DB_CHUNK_ROWS),
      );
      yield* importCheckpoint(signal);
    }
  }
  return routeId;
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
