import type {
  MetricKind,
  MetricSample,
  ParsedFile,
  QuarantineCode,
  RoutePoint,
  WorkoutType,
} from '@velograph/shared';
import { parseInstant } from '@velograph/shared';
import { parseCsv } from './csv.ts';
import { parseGpx, GpxError } from './gpx.ts';
import { parseStrictNumber, type NumericBounds } from './numeric.ts';

/**
 * Versioned Health Auto Export adapters (IMP-004). ADAPTER_VERSION is stored
 * on every source_files row so files can be reprocessed after upgrades
 * (IMP-010). Header matching is tolerant of spacing/case but never guesses:
 * unrecognized headers quarantine the file rather than half-importing it.
 */
export const ADAPTER_VERSION = 'hae-csv-v3';

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

/** Parse a Health Auto Export CSV (metric or route) into normalized form. */
export function parseHaeCsv(name: string, text: string, options: AdapterOptions = {}): ParsedFile {
  const info = parseHaeFilename(name);
  if (!info) throw new AdapterError('unsupported_file_type', 'filename not recognized');
  if (text.trim() === '') throw new AdapterError('empty_file', 'file is empty');

  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch {
    throw new AdapterError('malformed_csv', 'CSV structure invalid');
  }
  if (rows.length < 2) throw new AdapterError('no_valid_samples', 'no data rows');
  const header = rows[0]!.map(norm);
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));

  const tIdx = idx(['date/time', 'datetime', 'date', 'timestamp']);
  if (tIdx === -1) throw new AdapterError('unrecognized_headers', 'no timestamp column');

  if (ROUTE_CSV_HEADERS.every((h) => header.includes(h))) {
    return parseRouteCsvRows(info, rows, header, options);
  }

  const shape = CSV_SHAPES.find((s) => idx(s.value) !== -1);
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
  const vIdx = idx(shape.value);
  const minIdx = shape.min ? idx(shape.min) : -1;
  const maxIdx = shape.max ? idx(shape.max) : -1;
  const srcIdx = idx(['source']);
  const ctxIdx = idx(['context']);

  const samples: MetricSample[] = [];
  let source: string | null = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const t = parseRequiredInstant(row[tIdx], options);
    const v = parseRequiredNumber(row[vIdx], shape.bounds);
    const value = shape.toCanonical(v);
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new AdapterError('numeric_value_invalid', 'canonical numeric value invalid');
    }
    const s: MetricSample = { t, value };
    if (minIdx !== -1) {
      const min = parseStrictNumber(row[minIdx], shape.bounds);
      if (min != null) s.min = shape.toCanonical(min);
    }
    if (maxIdx !== -1) {
      const max = parseStrictNumber(row[maxIdx], shape.bounds);
      if (max != null) s.max = shape.toCanonical(max);
    }
    if (ctxIdx !== -1 && row[ctxIdx]) s.context = row[ctxIdx];
    if (srcIdx !== -1 && row[srcIdx]) source = row[srcIdx]!;
    samples.push(s);
  }
  if (samples.length === 0) throw new AdapterError('no_valid_samples', 'no parseable rows');
  samples.sort((a, b) => a.t - b.t);
  return { kind: 'metric', metric: shape.metric, workoutType: info.workoutType, source, samples };
}

function parseRouteCsvRows(
  info: FilenameInfo,
  rows: string[][],
  header: string[],
  options: AdapterOptions,
): ParsedFile {
  const col = (n: string) => header.indexOf(n);
  const tIdx = col('timestamp');
  const latIdx = col('latitude');
  const lonIdx = col('longitude');
  const altitude = resolveUnitColumn(header, 'altitude', {
    altitudem: 1,
    altitudeft: 0.3048,
  });
  const speed = resolveUnitColumn(header, 'speed', {
    'speedm/s': 1,
    'speedkm/h': 1 / 3.6,
  });
  const course = resolveUnitColumn(header, 'course', {
    coursedeg: 1,
  });
  const horizontalAccuracy = resolveUnitColumn(header, 'horizontalaccuracy', {
    horizontalaccuracym: 1,
    horizontalaccuracyft: 0.3048,
  });
  const verticalAccuracy = resolveUnitColumn(header, 'verticalaccuracy', {
    verticalaccuracym: 1,
    verticalaccuracyft: 0.3048,
  });

  const points: RoutePoint[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const t = parseRequiredInstant(row[tIdx], options);
    const lat = parseRequiredNumber(row[latIdx], { min: -90, max: 90 });
    const lon = parseRequiredNumber(row[lonIdx], { min: -180, max: 180 });
    const p: RoutePoint = { t, lat, lon };
    const opt = (
      column: UnitColumn | null,
      key: 'ele' | 'speed' | 'course' | 'hAcc' | 'vAcc',
      bounds: NumericBounds,
    ) => {
      if (column) {
        const raw = parseStrictNumber(row[column.index]);
        if (raw != null) {
          const value = raw * column.toCanonicalFactor;
          if (Number.isFinite(value) && isWithinBounds(value, bounds)) {
            p[key] = value;
          }
        }
      }
    };
    opt(altitude, 'ele', { minExclusive: -500, maxExclusive: 10_000 });
    opt(speed, 'speed', { min: 0, maxExclusive: 150 });
    opt(course, 'course', { min: 0, maxExclusive: 360 });
    opt(horizontalAccuracy, 'hAcc', { min: 0, max: Number.MAX_SAFE_INTEGER });
    opt(verticalAccuracy, 'vAcc', { min: 0, max: Number.MAX_SAFE_INTEGER });
    points.push(p);
  }
  if (points.length === 0) throw new AdapterError('no_valid_samples', 'no valid route rows');
  points.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

  // Split into segments on recording gaps > 60 s (ROUTE-004: preserve gaps).
  const segments = [];
  let seg: (typeof points)[number][] = [];
  let prev: number | null = null;
  for (const p of points) {
    if (prev != null && p.t != null && p.t - prev > 60_000 && seg.length) {
      segments.push({ points: seg });
      seg = [];
    }
    seg.push(p);
    if (p.t != null) prev = p.t;
  }
  if (seg.length) segments.push({ points: seg });
  return { kind: 'route', format: 'csv', workoutType: info.workoutType, segments };
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
  const looseCycling =
    /^(Outdoor|Indoor) Cycling-(?:Heart Rate|Cycling Cadence|Cycling Distance|Active Energy|Route)-.+\.gpx$/i.exec(
      name.trim(),
    );
  if ((!info || classifyImportFileName(name).kind !== 'supported') && !looseCycling) {
    throw new AdapterError('unsupported_file_type', 'filename not recognized');
  }
  const workoutType: WorkoutType =
    info?.workoutType ??
    (looseCycling![1]!.toLowerCase() === 'indoor' ? 'indoor_cycling' : 'outdoor_cycling');
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
