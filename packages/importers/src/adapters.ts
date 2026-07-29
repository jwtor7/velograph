import type {
  MetricKind,
  MetricSample,
  ParsedFile,
  QuarantineCode,
  RoutePoint,
  WorkoutType,
} from '@velograph/shared';
import { parseInstant } from '@velograph/shared';
import { CsvError, CsvStreamParser, DEFAULT_CSV_LIMITS } from './csv.ts';
import { parseGpx, GpxError } from './gpx.ts';
import { parseStrictNumber, type NumericBounds } from './numeric.ts';

/**
 * Versioned Health Auto Export adapters (IMP-004). ADAPTER_VERSION is stored
 * on every source_files row so files can be reprocessed after upgrades
 * (IMP-010). Header matching is tolerant of spacing/case but never guesses:
 * unrecognized headers quarantine the file rather than half-importing it.
 */
export const ADAPTER_VERSION = 'hae-csv-v4';

export class AdapterError extends Error {
  readonly code: QuarantineCode;

  constructor(code: QuarantineCode, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export interface FilenameInfo {
  workoutType: WorkoutType;
  /** Filename timestamp is corroborating evidence, never the sole association key (IMP-005). */
  stampHint: string | null;
  label: string;
}

export interface AdapterOptions {
  /** IANA timezone for Health Auto Export CSV wall times that omit an offset. */
  timeZone?: string;
}

type CandidateKind =
  'supported' | 'unmodelled_metric' | 'non_cycling_workout' | 'archive' | 'unsupported';

export interface ImportCandidateClassification {
  kind: CandidateKind;
  detectedType: string | null;
}

const SUPPORTED_CYCLING_LABELS = new Set([
  'heartrate',
  'cyclingcadence',
  'cyclingdistance',
  'activeenergy',
  'route',
]);

const normalizeLabel = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, '');

function expectedKindForLabel(label: string): MetricKind | 'route' | null {
  const normalized = normalizeLabel(label);
  if (normalized === 'heartrate') return 'heart_rate';
  if (normalized === 'cyclingcadence') return 'cadence';
  if (normalized === 'cyclingdistance') return 'distance';
  if (normalized === 'activeenergy') return 'energy';
  if (normalized === 'route') return 'route';
  return null;
}

/**
 * Classify only from the value-free filename before parsing or persistence.
 * Well-formed but out-of-scope HAE files are normal aggregate skips; malformed
 * or unrelated filenames still flow to quarantine.
 */
export function classifyImportFileName(name: string): ImportCandidateClassification {
  const trimmed = name.trim();
  if (/\.zip$/i.test(trimmed)) {
    return { kind: 'archive', detectedType: 'archive:zip' };
  }
  const match = /^(.+?)-(.+?)-(\d{8}_\d{6})\.(csv|gpx)$/i.exec(trimmed);
  if (!match) return { kind: 'unsupported', detectedType: null };

  const workoutLabel = match[1]!.trim().toLowerCase();
  const metricLabel = match[2]!.trim();
  const format = match[4]!.toLowerCase();
  const cycling =
    workoutLabel === 'outdoor cycling'
      ? 'outdoor_cycling'
      : workoutLabel === 'indoor cycling'
        ? 'indoor_cycling'
        : null;
  if (!cycling) {
    return { kind: 'non_cycling_workout', detectedType: 'skip:non_cycling_workout' };
  }
  if (!SUPPORTED_CYCLING_LABELS.has(normalizeLabel(metricLabel))) {
    return { kind: 'unmodelled_metric', detectedType: 'skip:unmodelled_metric' };
  }
  if (format === 'gpx' && normalizeLabel(metricLabel) !== 'route') {
    return { kind: 'unsupported', detectedType: 'unsupported:gpx_filename' };
  }
  return {
    kind: 'supported',
    detectedType: `${cycling}:${normalizeLabel(metricLabel)}:${format}`,
  };
}

/** Classify a Health Auto Export-shaped filename. Returns null when unrecognized. */
export function parseHaeFilename(name: string): FilenameInfo | null {
  const m = /^(Outdoor|Indoor) Cycling-(.+?)-(\d{8}_\d{6})\.(csv|gpx)$/i.exec(name.trim());
  if (!m) return null;
  return {
    workoutType: m[1]!.toLowerCase() === 'indoor' ? 'indoor_cycling' : 'outdoor_cycling',
    label: m[2]!,
    stampHint: m[3]!,
  };
}

/**
 * Resolve the timestamp carried by a supported HAE filename. It is returned as
 * corroborating evidence only; the association engine must also have internal
 * sample times. A syntactically matching but impossible stamp fails closed.
 */
export function parseHaeFilenameTimestamp(
  name: string,
  options: AdapterOptions = {},
): number | null {
  return parseHaeFilenameTimestamps(name, options)[0] ?? null;
}

/**
 * HAE filename stamps have appeared as both local wall time and UTC across
 * exporter configurations. Return both viable interpretations (deduplicated)
 * so internal sample times can corroborate one; neither interpretation is
 * independently sufficient to associate a workout.
 */
export function parseHaeFilenameTimestamps(name: string, options: AdapterOptions = {}): number[] {
  const info = parseHaeFilename(name);
  if (!info?.stampHint) return [];
  const stamp = info.stampHint;
  const isoLike = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(
    9,
    11,
  )}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
  const utc = parseInstant(isoLike);
  if (utc == null) {
    throw new AdapterError('timestamps_invalid', 'filename timestamp invalid');
  }
  const candidates: number[] = [];
  if (options.timeZone) {
    const zoned = parseInstant(isoLike, { defaultTimeZone: options.timeZone });
    if (zoned != null) candidates.push(zoned);
  }
  if (!candidates.includes(utc)) candidates.push(utc);
  return candidates;
}

const norm = (h: string) => h.toLowerCase().replace(/\s+|\(|\)/g, '');

interface CsvShape {
  metric: MetricKind;
  /** normalized header → canonical field */
  value: string[];
  min?: string[];
  max?: string[];
  bounds: NumericBounds;
  toCanonical: (v: number) => number;
}

const CSV_SHAPES: CsvShape[] = [
  {
    metric: 'heart_rate',
    value: ['avgbpm', 'avgcount/min', 'avg', 'heartratebpm', 'bpm'],
    min: ['minbpm', 'mincount/min', 'min'],
    max: ['maxbpm', 'maxcount/min', 'max'],
    bounds: { minExclusive: 0, max: 300 },
    toCanonical: (v) => v,
  },
  {
    metric: 'cadence',
    value: ['cadencerpm', 'cyclingcadencecount/min', 'cadence', 'rpm'],
    bounds: { min: 0, max: 300 },
    toCanonical: (v) => v,
  },
  {
    metric: 'distance',
    value: ['cyclingdistancekm', 'distancekm'],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER / 1000 },
    toCanonical: (v) => v * 1000, // km → m
  },
  {
    metric: 'distance',
    value: ['cyclingdistancem', 'distancem'],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER },
    toCanonical: (v) => v,
  },
  {
    metric: 'energy',
    value: ['activeenergykj', 'energykj'],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER / 1000 },
    toCanonical: (v) => v * 1000, // kJ → J
  },
  {
    metric: 'energy',
    value: ['activeenergyj', 'energyj'],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER },
    toCanonical: (v) => v,
  },
  {
    metric: 'energy',
    value: ['activeenergykcal', 'energykcal'],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER / 4184 },
    toCanonical: (v) => v * 4184, // thermochemical kcal → J
  },
];

const ROUTE_CSV_HEADERS = ['timestamp', 'latitude', 'longitude'];
const CSV_PARSE_CHUNK_CHARS = 64 * 1024;
export const MAX_HAE_CSV_SAMPLES = DEFAULT_CSV_LIMITS.maxRows - 1;
export const CSV_NORMALIZATION_CHUNK_ROWS = 2_048;

interface MetricCsvSpec {
  kind: 'metric';
  shape: CsvShape;
  tIdx: number;
  vIdx: number;
  minIdx: number;
  maxIdx: number;
  srcIdx: number;
  ctxIdx: number;
}

interface RouteCsvSpec {
  kind: 'route';
  tIdx: number;
  latIdx: number;
  lonIdx: number;
  altitude: UnitColumn | null;
  speed: UnitColumn | null;
  course: UnitColumn | null;
  horizontalAccuracy: UnitColumn | null;
  verticalAccuracy: UnitColumn | null;
}

type CsvSpec = MetricCsvSpec | RouteCsvSpec;

/** Parse a Health Auto Export CSV (metric or route) into normalized form. */
export function parseHaeCsv(name: string, text: string, options: AdapterOptions = {}): ParsedFile {
  const steps = parseHaeCsvSteps(name, text, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * Incrementally parse and normalize a CSV without retaining a second
 * `string[][]` copy. Cancellable API imports yield between bounded text
 * chunks; synchronous CLI/tests consume the same generator immediately.
 */
export function* parseHaeCsvSteps(
  name: string,
  text: string,
  options: AdapterOptions = {},
): Generator<void, ParsedFile> {
  const info = parseHaeFilename(name);
  if (!info) throw new AdapterError('unsupported_file_type', 'filename not recognized');
  if (!expectedKindForLabel(info.label)) {
    throw new AdapterError('unsupported_file_type', 'filename metric not supported');
  }
  if (text.length === 0) {
    throw new AdapterError('empty_file', 'file is empty');
  }

  let spec: CsvSpec | null = null;
  const samples: MetricSample[] = [];
  const points: RoutePoint[] = [];
  let source: string | null = null;
  const parser = new CsvStreamParser((row) => {
    if (!spec) {
      if (row.every((field) => field.trim() === '')) return;
      spec = parseCsvHeader(info, row);
      return;
    }
    if (spec.kind === 'metric') {
      if (samples.length >= MAX_HAE_CSV_SAMPLES) {
        throw new AdapterError('csv_limits_exceeded', 'CSV sample limit exceeded');
      }
      const sample = parseMetricCsvRow(spec, row, options);
      const context = spec.ctxIdx === -1 ? undefined : row[spec.ctxIdx];
      if (context) sample.context = context;
      if (spec.srcIdx !== -1 && row[spec.srcIdx]) source = row[spec.srcIdx]!;
      samples.push(sample);
      return;
    }
    if (points.length >= MAX_HAE_CSV_SAMPLES) {
      throw new AdapterError('csv_limits_exceeded', 'CSV sample limit exceeded');
    }
    points.push(parseRouteCsvRow(spec, row, options));
  }, DEFAULT_CSV_LIMITS);

  try {
    for (let offset = 0; offset < text.length; offset += CSV_PARSE_CHUNK_CHARS) {
      parser.push(text.slice(offset, offset + CSV_PARSE_CHUNK_CHARS));
      yield;
    }
    parser.end();
  } catch (err) {
    if (err instanceof CsvError) {
      throw new AdapterError(err.code, 'CSV structure or limits invalid');
    }
    throw err;
  }

  // The parser callback initializes this from the header. TypeScript cannot
  // observe assignments made inside that callback, so narrow the post-parse
  // value explicitly after `end()` has delivered all rows.
  const finalSpec = spec as CsvSpec | null;
  if (!finalSpec) throw new AdapterError('empty_file', 'file is empty');
  if (samples.length === 0 && points.length === 0) {
    throw new AdapterError('no_valid_samples', 'no data rows');
  }
  if (finalSpec.kind === 'metric') {
    const sortedSamples = yield* sortInBoundedSteps(samples, (a, b) => a.t - b.t);
    return {
      kind: 'metric',
      metric: finalSpec.shape.metric,
      workoutType: info.workoutType,
      source,
      samples: sortedSamples,
    };
  }
  const sortedPoints = yield* sortInBoundedSteps(points, (a, b) => (a.t ?? 0) - (b.t ?? 0));
  return {
    kind: 'route',
    format: 'csv',
    workoutType: info.workoutType,
    segments: yield* splitRouteSegmentsSteps(sortedPoints),
  };
}

function parseCsvHeader(info: FilenameInfo, rawHeader: string[]): CsvSpec {
  const expectedKind = expectedKindForLabel(info.label);
  if (!expectedKind) {
    throw new AdapterError('unsupported_file_type', 'filename metric not supported');
  }
  const header = rawHeader.map(norm);
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const tIdx = idx(['date/time', 'datetime', 'date', 'timestamp']);
  if (tIdx === -1) throw new AdapterError('unrecognized_headers', 'no timestamp column');

  if (ROUTE_CSV_HEADERS.every((h) => header.includes(h))) {
    if (expectedKind !== 'route') {
      throw new AdapterError('metric_kind_mismatch', 'filename and route headers disagree');
    }
    return {
      kind: 'route',
      tIdx: header.indexOf('timestamp'),
      latIdx: header.indexOf('latitude'),
      lonIdx: header.indexOf('longitude'),
      altitude: resolveUnitColumn(header, 'altitude', {
        altitudem: 1,
        altitudeft: 0.3048,
      }),
      speed: resolveUnitColumn(header, 'speed', {
        'speedm/s': 1,
        'speedkm/h': 1 / 3.6,
      }),
      course: resolveUnitColumn(header, 'course', {
        coursedeg: 1,
      }),
      horizontalAccuracy: resolveUnitColumn(header, 'horizontalaccuracy', {
        horizontalaccuracym: 1,
        horizontalaccuracyft: 0.3048,
      }),
      verticalAccuracy: resolveUnitColumn(header, 'verticalaccuracy', {
        verticalaccuracym: 1,
        verticalaccuracyft: 0.3048,
      }),
    };
  }

  const matchingShapes = CSV_SHAPES.filter((shape) => idx(shape.value) !== -1);
  const shape = matchingShapes.length === 1 ? matchingShapes[0] : undefined;
  if (!shape) {
    const unitSensitiveHeader = header.some(
      (h) =>
        h === 'distance' ||
        h.startsWith('distance') ||
        h === 'cyclingdistance' ||
        h.startsWith('cyclingdistance') ||
        h === 'energy' ||
        h.startsWith('energy') ||
        h === 'activeenergy' ||
        h.startsWith('activeenergy'),
    );
    if (unitSensitiveHeader) {
      throw new AdapterError('unit_unsupported', 'metric unit unsupported or missing');
    }
    throw new AdapterError('unrecognized_headers', 'no known metric column');
  }
  if (expectedKind === 'route' || shape.metric !== expectedKind) {
    throw new AdapterError('metric_kind_mismatch', 'filename and metric headers disagree');
  }
  return {
    kind: 'metric',
    shape,
    tIdx,
    vIdx: idx(shape.value),
    minIdx: shape.min ? idx(shape.min) : -1,
    maxIdx: shape.max ? idx(shape.max) : -1,
    srcIdx: idx(['source']),
    ctxIdx: idx(['context']),
  };
}

function parseMetricCsvRow(
  spec: MetricCsvSpec,
  row: string[],
  options: AdapterOptions,
): MetricSample {
  const t = parseRequiredInstant(row[spec.tIdx], options);
  const v = parseRequiredNumber(row[spec.vIdx], spec.shape.bounds);
  const value = spec.shape.toCanonical(v);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new AdapterError('numeric_value_invalid', 'canonical numeric value invalid');
  }
  const sample: MetricSample = { t, value };
  if (spec.minIdx !== -1) {
    const min = parseStrictNumber(row[spec.minIdx], spec.shape.bounds);
    if (min != null) sample.min = spec.shape.toCanonical(min);
  }
  if (spec.maxIdx !== -1) {
    const max = parseStrictNumber(row[spec.maxIdx], spec.shape.bounds);
    if (max != null) sample.max = spec.shape.toCanonical(max);
  }
  return sample;
}

function parseRouteCsvRow(spec: RouteCsvSpec, row: string[], options: AdapterOptions): RoutePoint {
  const t = parseRequiredInstant(row[spec.tIdx], options);
  const lat = parseRequiredNumber(row[spec.latIdx], { min: -90, max: 90 });
  const lon = parseRequiredNumber(row[spec.lonIdx], { min: -180, max: 180 });
  const point: RoutePoint = { t, lat, lon };
  parseOptionalRouteField(point, row, spec.altitude, 'ele', {
    minExclusive: -500,
    maxExclusive: 10_000,
  });
  parseOptionalRouteField(point, row, spec.speed, 'speed', { min: 0, maxExclusive: 150 });
  parseOptionalRouteField(point, row, spec.course, 'course', { min: 0, maxExclusive: 360 });
  parseOptionalRouteField(point, row, spec.horizontalAccuracy, 'hAcc', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  parseOptionalRouteField(point, row, spec.verticalAccuracy, 'vAcc', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  return point;
}

function parseOptionalRouteField(
  point: RoutePoint,
  row: string[],
  column: UnitColumn | null,
  key: 'ele' | 'speed' | 'course' | 'hAcc' | 'vAcc',
  bounds: NumericBounds,
): void {
  if (!column) return;
  const raw = parseStrictNumber(row[column.index]);
  if (raw == null) return;
  const value = raw * column.toCanonicalFactor;
  if (Number.isFinite(value) && isWithinBounds(value, bounds)) {
    point[key] = value;
  }
}

function* splitRouteSegmentsSteps(
  points: RoutePoint[],
): Generator<void, { points: RoutePoint[] }[]> {
  const segments: { points: RoutePoint[] }[] = [];
  let segment: RoutePoint[] = [];
  let previous: number | null = null;
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    if (previous != null && point.t != null && point.t - previous > 60_000 && segment.length) {
      segments.push({ points: segment });
      segment = [];
    }
    segment.push(point);
    if (point.t != null) previous = point.t;
    if ((index + 1) % CSV_NORMALIZATION_CHUNK_ROWS === 0) yield;
  }
  if (segment.length) segments.push({ points: segment });
  return segments;
}

/**
 * Sort bounded runs with the native stable sorter, then merge those runs in
 * cooperative chunks. This avoids one uninterruptible sort over the maximum
 * 500,000-sample CSV while preserving deterministic timestamp order.
 */
function* sortInBoundedSteps<T>(
  values: T[],
  compare: (left: T, right: T) => number,
): Generator<void, T[]> {
  if (values.length < 2) return values;

  for (let start = 0; start < values.length; start += CSV_NORMALIZATION_CHUNK_ROWS) {
    const sorted = values.slice(start, start + CSV_NORMALIZATION_CHUNK_ROWS).sort(compare);
    for (let index = 0; index < sorted.length; index++) {
      values[start + index] = sorted[index]!;
    }
    yield;
  }

  let source = values;
  let target = new Array<T>(values.length);
  for (let width = CSV_NORMALIZATION_CHUNK_ROWS; width < values.length; width *= 2) {
    let writtenSinceYield = 0;
    for (let left = 0; left < values.length; left += width * 2) {
      const middle = Math.min(left + width, values.length);
      const right = Math.min(left + width * 2, values.length);
      let leftIndex = left;
      let rightIndex = middle;
      for (let output = left; output < right; output++) {
        if (
          rightIndex >= right ||
          (leftIndex < middle && compare(source[leftIndex]!, source[rightIndex]!) <= 0)
        ) {
          target[output] = source[leftIndex++]!;
        } else {
          target[output] = source[rightIndex++]!;
        }
        writtenSinceYield++;
        if (writtenSinceYield >= CSV_NORMALIZATION_CHUNK_ROWS) {
          writtenSinceYield = 0;
          yield;
        }
      }
    }
    const previousSource = source;
    source = target;
    target = previousSource;
  }

  if (source !== values) {
    for (let start = 0; start < values.length; start += CSV_NORMALIZATION_CHUNK_ROWS) {
      const end = Math.min(start + CSV_NORMALIZATION_CHUNK_ROWS, values.length);
      for (let index = start; index < end; index++) values[index] = source[index]!;
      yield;
    }
  }
  return values;
}

interface UnitColumn {
  index: number;
  toCanonicalFactor: number;
}

/**
 * Resolve exactly one unit-bearing optional route column. A generic or
 * unsupported unit must fail closed because route values are persisted in SI.
 */
function resolveUnitColumn(
  header: string[],
  family: string,
  supported: Readonly<Record<string, number>>,
): UnitColumn | null {
  const candidates = header
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value === family || value.startsWith(family));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new AdapterError('unrecognized_headers', `ambiguous ${family} column`);
  }
  const candidate = candidates[0]!;
  const factor = supported[candidate.value];
  if (factor === undefined) {
    throw new AdapterError('unit_unsupported', `${family} unit unsupported or missing`);
  }
  return { index: candidate.index, toCanonicalFactor: factor };
}

function isWithinBounds(value: number, bounds: NumericBounds): boolean {
  if (bounds.min != null && value < bounds.min) return false;
  if (bounds.max != null && value > bounds.max) return false;
  if (bounds.minExclusive != null && value <= bounds.minExclusive) return false;
  if (bounds.maxExclusive != null && value >= bounds.maxExclusive) return false;
  return true;
}

/** Parse a GPX file into the same normalized route form. */
export function parseHaeGpx(name: string, text: string): ParsedFile {
  const info = parseHaeFilename(name);
  if (
    !info ||
    expectedKindForLabel(info.label) !== 'route' ||
    classifyImportFileName(name).kind !== 'supported' ||
    !/\.gpx$/i.test(name.trim())
  ) {
    throw new AdapterError('unsupported_file_type', 'filename not recognized');
  }
  const workoutType: WorkoutType = info.workoutType;
  try {
    const { segments } = parseGpx(text);
    if (segments.length === 0) throw new AdapterError('no_valid_samples', 'no track points');
    return { kind: 'route', format: 'gpx', workoutType, segments };
  } catch (err) {
    if (err instanceof GpxError) throw new AdapterError(err.code, err.message);
    throw err;
  }
}

function parseRequiredInstant(raw: string | undefined, options: AdapterOptions): number {
  const parsed = parseInstant(raw ?? '', { defaultTimeZone: options.timeZone ?? null });
  if (parsed == null) {
    throw new AdapterError('timestamps_invalid', 'required timestamp invalid');
  }
  return parsed;
}

function parseRequiredNumber(raw: string | undefined, bounds: NumericBounds): number {
  const parsed = parseStrictNumber(raw, bounds);
  if (parsed == null) {
    throw new AdapterError('numeric_value_invalid', 'required numeric value invalid');
  }
  return parsed;
}
