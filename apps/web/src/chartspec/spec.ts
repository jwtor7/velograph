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

/**
 * Build one line specification from independently recorded segments. Every
 * segment gets its own SVG subpath while sharing one time/value domain, so
 * recording gaps are never drawn as data.
 */
export function buildSegmentedLineSpec(
  segments: Pt[][],
  w: number,
  h: number,
  opts: { tMin?: number; tMax?: number; zeroBase?: boolean; maxPoints?: number } = {},
): LineSpec | null {
  const drawable = segments
    .filter((points) => points.length >= 2)
    .map((points) => downsample(points, opts.maxPoints ?? 400));
  if (drawable.length === 0) return null;

  let observedTMin = Infinity;
  let observedTMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const points of drawable) {
    for (const p of points) {
      if (p.t < observedTMin) observedTMin = p.t;
      if (p.t > observedTMax) observedTMax = p.t;
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
  }

  const tMin = opts.tMin ?? observedTMin;
  const tMax = opts.tMax ?? observedTMax;
  if (tMax <= tMin) return null;
  const pad = (vMax - vMin) * 0.08 || Math.abs(vMax) * 0.08 || 1;
  vMax += pad;
  vMin = opts.zeroBase ? Math.min(0, vMin) : vMin - pad;

  const x = (t: number) => r2(((t - tMin) / (tMax - tMin)) * w);
  const y = (v: number) => r2(h - ((v - vMin) / (vMax - vMin)) * h);
  const paths = drawable.map((points) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t)} ${y(p.v)}`).join(''),
  );
  const area = drawable
    .map((points, i) => {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      return `${paths[i]}L${x(last.t)} ${h}L${x(first.t)} ${h}Z`;
    })
    .join('');
  return { path: paths.join(''), area, tMin, tMax, vMin, vMax, w, h };
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
  /** Cumulative-distance labels sampled along recorded segments only. */
  distanceMarkers: { distanceM: number; label: string; position: [number, number] }[];
  /** Direction chevrons sampled along recorded segments only. */
  directionMarkers: { position: [number, number]; angleDeg: number }[];
  /** A geographic scale bar derived from the route projection. */
  scaleBar: { distanceM: number; label: string; widthPx: number };
  totalDistanceM: number;
  w: number;
  h: number;
  /** Map a route point index (flat) to projected coordinates. */
  project: (lat: number, lon: number) => [number, number];
}

const EARTH_RADIUS_M = 6_371_000;

function routeDistanceM(a: RoutePointIn, b: RoutePointIn): number {
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function niceDistance(targetM: number, mode: 'nearest' | 'floor' = 'nearest'): number {
  if (!Number.isFinite(targetM) || targetM <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(targetM));
  const normalized = targetM / power;
  const choices = [1, 2, 5, 10];
  if (mode === 'floor') {
    const factor = [...choices].reverse().find((choice) => choice <= normalized) ?? 1;
    return factor * power;
  }
  const factor = choices.reduce((best, choice) =>
    Math.abs(choice - normalized) < Math.abs(best - normalized) ? choice : best,
  );
  return factor * power;
}

interface LocatedRoutePoint {
  point: RoutePointIn;
  previous: RoutePointIn;
}

function locateAtDistance(
  segments: { points: RoutePointIn[] }[],
  targetM: number,
): LocatedRoutePoint | null {
  let traversedM = 0;
  for (const segment of segments) {
    for (let i = 1; i < segment.points.length; i++) {
      const a = segment.points[i - 1]!;
      const b = segment.points[i]!;
      const edgeM = routeDistanceM(a, b);
      if (edgeM > 0 && traversedM + edgeM >= targetM) {
        const ratio = Math.max(0, Math.min(1, (targetM - traversedM) / edgeM));
        return {
          previous: a,
          point: {
            lat: a.lat + (b.lat - a.lat) * ratio,
            lon: a.lon + (b.lon - a.lon) * ratio,
          },
        };
      }
      traversedM += edgeM;
    }
  }
  return null;
}

function totalRecordedDistanceM(segments: { points: RoutePointIn[] }[]): number {
  let total = 0;
  for (const segment of segments) {
    for (let i = 1; i < segment.points.length; i++) {
      total += routeDistanceM(segment.points[i - 1]!, segment.points[i]!);
    }
  }
  return total;
}

const distanceLabel = (distanceM: number): string =>
  distanceM >= 1000 ? `${r2(distanceM / 1000)} km` : `${Math.round(distanceM)} m`;

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
  let pointCount = 0;
  let latMin = Infinity;
  let latMax = -Infinity;
  let lonMin = Infinity;
  let lonMax = -Infinity;
  for (const segment of segments) {
    for (const point of segment.points) {
      pointCount++;
      if (point.lat < latMin) latMin = point.lat;
      if (point.lat > latMax) latMax = point.lat;
      if (point.lon < lonMin) lonMin = point.lon;
      if (point.lon > lonMax) lonMax = point.lon;
    }
  }
  if (
    pointCount < 2 ||
    !Number.isFinite(latMin) ||
    !Number.isFinite(latMax) ||
    !Number.isFinite(lonMin) ||
    !Number.isFinite(lonMax)
  ) {
    return null;
  }
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
  const totalDistanceM = totalRecordedDistanceM(segments);
  const markerStepM = niceDistance(totalDistanceM / 4);
  const distanceMarkers: RouteSpec['distanceMarkers'] = [];
  for (let distanceM = markerStepM; distanceM < totalDistanceM; distanceM += markerStepM) {
    const located = locateAtDistance(segments, distanceM);
    if (!located) continue;
    distanceMarkers.push({
      distanceM,
      label: distanceLabel(distanceM),
      position: project(located.point.lat, located.point.lon),
    });
  }

  const directionMarkers: RouteSpec['directionMarkers'] = [];
  if (totalDistanceM > 0) {
    for (const fraction of [0.25, 0.5, 0.75]) {
      const located = locateAtDistance(segments, totalDistanceM * fraction);
      if (!located) continue;
      const from = project(located.previous.lat, located.previous.lon);
      const to = project(located.point.lat, located.point.lon);
      directionMarkers.push({
        position: to,
        angleDeg: r2((Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI),
      });
    }
  }

  const metersPerPixel = 111_320 / scale;
  const scaleDistanceM = niceDistance(metersPerPixel * 90, 'floor');
  const scaleBar = {
    distanceM: scaleDistanceM,
    label: distanceLabel(scaleDistanceM),
    widthPx: r2(scaleDistanceM / metersPerPixel),
  };
  return {
    segmentPaths,
    start: first ? project(first.lat, first.lon) : null,
    finish: last ? project(last.lat, last.lon) : null,
    distanceMarkers,
    directionMarkers,
    scaleBar,
    totalDistanceM,
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
