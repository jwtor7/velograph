import type {
  MetricKind,
  MetricSample,
  ParsedFile,
  QuarantineCode,
  WorkoutType,
} from '@velograph/shared';
import { parseInstant } from '@velograph/shared';
import { parseCsv } from './csv.ts';
import { parseGpx, GpxError } from './gpx.ts';

/**
 * Versioned Health Auto Export adapters (IMP-004). ADAPTER_VERSION is stored
 * on every source_files row so files can be reprocessed after upgrades
 * (IMP-010). Header matching is tolerant of spacing/case but never guesses:
 * unrecognized headers quarantine the file rather than half-importing it.
 */
export const ADAPTER_VERSION = 'hae-csv-v1';

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
  /** Best-effort filename timestamp — a HINT only, never the association key (IMP-005). */
  stampHint: string | null;
  label: string;
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

const norm = (h: string) => h.toLowerCase().replace(/\s+|\(|\)/g, '');

interface CsvShape {
  metric: MetricKind;
  /** normalized header → canonical field */
  value: string[];
  min?: string[];
  max?: string[];
  toCanonical: (v: number) => number;
}

const CSV_SHAPES: CsvShape[] = [
  {
    metric: 'heart_rate',
    value: ['avgbpm', 'avg', 'heartratebpm', 'bpm'],
    min: ['minbpm', 'min'],
    max: ['maxbpm', 'max'],
    toCanonical: (v) => v,
  },
  { metric: 'cadence', value: ['cadencerpm', 'cadence', 'rpm'], toCanonical: (v) => v },
  {
    metric: 'distance',
    value: ['distancekm', 'distance'],
    toCanonical: (v) => v * 1000, // km → m
  },
  {
    metric: 'energy',
    value: ['activeenergykj', 'energykj', 'activeenergy', 'energy'],
    toCanonical: (v) => v * 1000, // kJ → J
  },
];

const ROUTE_CSV_HEADERS = ['timestamp', 'latitude', 'longitude'];

/** Parse a Health Auto Export CSV (metric or route) into normalized form. */
export function parseHaeCsv(name: string, text: string): ParsedFile {
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
    return parseRouteCsvRows(info, rows, header);
  }

  const shape = CSV_SHAPES.find((s) => idx(s.value) !== -1);
  if (!shape) throw new AdapterError('unrecognized_headers', 'no known metric column');
  const vIdx = idx(shape.value);
  const minIdx = shape.min ? idx(shape.min) : -1;
  const maxIdx = shape.max ? idx(shape.max) : -1;
  const srcIdx = idx(['source']);
  const ctxIdx = idx(['context']);

  const samples: MetricSample[] = [];
  let source: string | null = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const t = parseInstant(row[tIdx] ?? '');
    const v = Number(row[vIdx]);
    if (t == null || !Number.isFinite(v)) continue;
    const s: MetricSample = { t, value: shape.toCanonical(v) };
    if (minIdx !== -1 && row[minIdx] !== '' && Number.isFinite(Number(row[minIdx]))) {
      s.min = shape.toCanonical(Number(row[minIdx]));
    }
    if (maxIdx !== -1 && row[maxIdx] !== '' && Number.isFinite(Number(row[maxIdx]))) {
      s.max = shape.toCanonical(Number(row[maxIdx]));
    }
    if (ctxIdx !== -1 && row[ctxIdx]) s.context = row[ctxIdx];
    if (srcIdx !== -1 && row[srcIdx]) source = row[srcIdx]!;
    samples.push(s);
  }
  if (samples.length === 0) throw new AdapterError('no_valid_samples', 'no parseable rows');
  samples.sort((a, b) => a.t - b.t);
  return { kind: 'metric', metric: shape.metric, workoutType: info.workoutType, source, samples };
}

function parseRouteCsvRows(info: FilenameInfo, rows: string[][], header: string[]): ParsedFile {
  const col = (n: string) => header.indexOf(n);
  const tIdx = col('timestamp');
  const latIdx = col('latitude');
  const lonIdx = col('longitude');
  const altIdx = header.findIndex((h) => h.startsWith('altitude'));
  const spdIdx = header.findIndex((h) => h.startsWith('speed'));
  const crsIdx = header.findIndex((h) => h.startsWith('course'));
  const haIdx = header.findIndex((h) => h.startsWith('horizontalaccuracy'));
  const vaIdx = header.findIndex((h) => h.startsWith('verticalaccuracy'));

  const points = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const t = parseInstant(row[tIdx] ?? '');
    const lat = Number(row[latIdx]);
    const lon = Number(row[lonIdx]);
    if (t == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const p: Record<string, number> = { t, lat, lon };
    const opt = (idx: number, key: string) => {
      if (idx !== -1) {
        const v = Number(row[idx]);
        if (Number.isFinite(v)) p[key] = v;
      }
    };
    opt(altIdx, 'ele');
    opt(spdIdx, 'speed');
    opt(crsIdx, 'course');
    opt(haIdx, 'hAcc');
    opt(vaIdx, 'vAcc');
    points.push(p as unknown as import('@velograph/shared').RoutePoint);
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

/** Parse a GPX file into the same normalized route form. */
export function parseHaeGpx(name: string, text: string): ParsedFile {
  const info = parseHaeFilename(name);
  const workoutType: WorkoutType = info?.workoutType ?? 'outdoor_cycling';
  try {
    const { segments } = parseGpx(text);
    if (segments.length === 0) throw new AdapterError('no_valid_samples', 'no track points');
    return { kind: 'route', format: 'gpx', workoutType, segments };
  } catch (err) {
    if (err instanceof GpxError) throw new AdapterError(err.code, err.message);
    throw err;
  }
}
