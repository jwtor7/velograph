/**
 * Pure chart-specification functions (PRD §9.3): deterministic input → SVG
 * path data and scales. No DOM, no clock, no randomness. Unit tested.
 */

export interface Pt {
  t: number;
  v: number;
}

export interface LineSpec {
  /** SVG path for the line. */
  path: string;
  /** SVG path for the closed area fill. */
  area: string;
  tMin: number;
  tMax: number;
  vMin: number;
  vMax: number;
  w: number;
  h: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Downsample to at most `maxPoints` using min/max bucketing (preserves peaks). */
export function downsample(points: Pt[], maxPoints: number): Pt[] {
  if (points.length <= maxPoints) return points;
  const buckets = Math.ceil(maxPoints / 2);
  const size = points.length / buckets;
  const out: Pt[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(points.length, Math.floor((b + 1) * size));
    if (from >= to) continue;
    let lo = points[from]!;
    let hi = points[from]!;
    for (let i = from; i < to; i++) {
      const p = points[i]!;
      if (p.v < lo.v) lo = p;
      if (p.v > hi.v) hi = p;
    }
    if (lo.t <= hi.t) {
      out.push(lo);
      if (hi !== lo) out.push(hi);
    } else {
      out.push(hi);
      out.push(lo);
    }
  }
  return out.sort((a, b2) => a.t - b2.t);
}

/**
 * Build a line + area spec on a fixed viewport. Domain: exact time extent;
 * value domain padded 8% above/below with deterministic rounding.
 */
export function buildLineSpec(
  points: Pt[],
  w: number,
  h: number,
  opts: { tMin?: number; tMax?: number; zeroBase?: boolean; maxPoints?: number } = {},
): LineSpec | null {
  if (points.length < 2) return null;
  const ds = downsample(points, opts.maxPoints ?? 400);
  const tMin = opts.tMin ?? ds[0]!.t;
  const tMax = opts.tMax ?? ds[ds.length - 1]!.t;
  if (tMax <= tMin) return null;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of ds) {
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  const pad = (vMax - vMin) * 0.08 || Math.abs(vMax) * 0.08 || 1;
  vMax += pad;
  vMin = opts.zeroBase ? Math.min(0, vMin) : vMin - pad;

  const x = (t: number) => r2(((t - tMin) / (tMax - tMin)) * w);
  const y = (v: number) => r2(h - ((v - vMin) / (vMax - vMin)) * h);
  let path = '';
  for (let i = 0; i < ds.length; i++) {
    path += `${i === 0 ? 'M' : 'L'}${x(ds[i]!.t)} ${y(ds[i]!.v)}`;
  }
  const area = `${path}L${x(ds[ds.length - 1]!.t)} ${h}L${x(ds[0]!.t)} ${h}Z`;
  return { path, area, tMin, tMax, vMin, vMax, w, h };
}

export interface RoutePointIn {
  lat: number;
  lon: number;
  t?: number | null;
}

export interface RouteSpec {
  /** One SVG path per segment (gaps are never bridged — ROUTE-004). */
  segmentPaths: string[];
  /** Projected [x, y] for start and finish markers. */
  start: [number, number] | null;
  finish: [number, number] | null;
  w: number;
  h: number;
  /** Map a route point index (flat) to projected coordinates. */
  project: (lat: number, lon: number) => [number, number];
}

/**
 * Equirectangular projection scaled to fit, aspect-corrected by the mean
 * latitude — deterministic and offline (§8.4: tile-free canvas).
 */
export function buildRouteSpec(
  segments: { points: RoutePointIn[] }[],
  w: number,
  h: number,
  margin = 16,
): RouteSpec | null {
  const all = segments.flatMap((s) => s.points);
  if (all.length < 2) return null;
  const lats = all.map((p) => p.lat);
  const lons = all.map((p) => p.lon);
  const latMin = Math.min(...lats);
  const latMax = Math.max(...lats);
  const lonMin = Math.min(...lons);
  const lonMax = Math.max(...lons);
  const meanLat = (latMin + latMax) / 2;
  const kx = Math.cos((meanLat * Math.PI) / 180);
  const spanX = (lonMax - lonMin) * kx || 1e-9;
  const spanY = latMax - latMin || 1e-9;
  const scale = Math.min((w - margin * 2) / spanX, (h - margin * 2) / spanY);
  const ox = (w - spanX * scale) / 2;
  const oy = (h - spanY * scale) / 2;

  const project = (lat: number, lon: number): [number, number] => [
    r2(ox + (lon - lonMin) * kx * scale),
    r2(oy + (latMax - lat) * scale),
  ];

  const segmentPaths = segments
    .filter((s) => s.points.length > 1)
    .map((s) =>
      s.points
        .map((p, i) => {
          const [px, py] = project(p.lat, p.lon);
          return `${i === 0 ? 'M' : 'L'}${px} ${py}`;
        })
        .join(''),
    );

  const first = segments.find((s) => s.points.length > 0)?.points[0] ?? null;
  const lastSeg = [...segments].reverse().find((s) => s.points.length > 0);
  const last = lastSeg ? lastSeg.points[lastSeg.points.length - 1]! : null;
  return {
    segmentPaths,
    start: first ? project(first.lat, first.lon) : null,
    finish: last ? project(last.lat, last.lon) : null,
    w,
    h,
    project,
  };
}

/** Time-position helpers for the synchronized cursor (RIDE-004). */
export function timeAtX(x: number, w: number, tMin: number, tMax: number): number {
  const clamped = Math.max(0, Math.min(w, x));
  return tMin + (clamped / w) * (tMax - tMin);
}

export function valueAt(points: Pt[], t: number): number | null {
  if (points.length === 0) return null;
  if (t <= points[0]!.t) return points[0]!.v;
  if (t >= points[points.length - 1]!.t) return points[points.length - 1]!.v;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  const f = (t - a.t) / (b.t - a.t || 1);
  return a.v + (b.v - a.v) * f;
}

/** Nearest route point (flat index across segments) for a given time. */
export function routeIndexAt(segments: { points: RoutePointIn[] }[], t: number): number | null {
  let best: number | null = null;
  let bestDelta = Infinity;
  let idx = 0;
  for (const seg of segments) {
    for (const p of seg.points) {
      if (p.t != null) {
        const d = Math.abs(p.t - t);
        if (d < bestDelta) {
          bestDelta = d;
          best = idx;
        }
      }
      idx++;
    }
  }
  return best;
}

/* ---------- formatters (render-time unit conversion only) ---------- */

export const fmtKm = (m: number | null | undefined) => (m == null ? '–' : (m / 1000).toFixed(1));

export const fmtDuration = (s: number | null | undefined): string => {
  if (s == null) return '–';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

export const fmtSpeedKmh = (ms: number | null | undefined) =>
  ms == null ? '–' : (ms * 3.6).toFixed(1);

export const fmtInt = (v: number | null | undefined) => (v == null ? '–' : String(Math.round(v)));

export const fmtDate = (t: number, tz = 'UTC'): string =>
  new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  }).format(new Date(t));
