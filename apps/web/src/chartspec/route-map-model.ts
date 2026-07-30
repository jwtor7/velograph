import type { RoutePoint } from '../api.ts';
import type { DisplayUnits } from '../display-units.ts';

export const MAX_RENDER_POINTS = 30_000;
export const MAX_RENDER_SEGMENTS = MAX_RENDER_POINTS / 2;
export const MAX_GRADIENT_CHUNKS = 384;

const EARTH_RADIUS_M = 6_371_000;

export interface RouteMapPoint {
  lat: number;
  lon: number;
}

interface LocatedRouteMapPoint extends RouteMapPoint {
  cumulativeM: number;
}

interface RouteEdge {
  from: LocatedRouteMapPoint;
  to: LocatedRouteMapPoint;
  startM: number;
  endM: number;
}

export interface RouteMapMarker {
  position: RouteMapPoint;
  label: string;
}

export interface RouteMapDirectionMarker extends RouteMapMarker {
  bearingDeg: number;
}

export interface RouteGradientChunk {
  points: RouteMapPoint[];
  progress: number;
}

export interface RouteMapModel {
  bounds: [[number, number], [number, number]];
  start: RouteMapMarker;
  finish: RouteMapMarker;
  distanceMarkers: RouteMapMarker[];
  directionMarkers: RouteMapDirectionMarker[];
  renderRuns: RouteMapPoint[][];
  gradientChunks: RouteGradientChunk[];
  timedIndex: { t: number; position: RouteMapPoint }[];
  totalDistanceM: number;
  recordingGapCount: number;
  sourcePointCount: number;
  renderPointCount: number;
  simplified: boolean;
}

const isValidCoordinate = (point: RoutePoint): boolean =>
  Number.isFinite(point.lat) &&
  point.lat >= -90 &&
  point.lat <= 90 &&
  Number.isFinite(point.lon) &&
  point.lon >= -180 &&
  point.lon <= 180;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

function distanceM(a: RouteMapPoint, b: RouteMapPoint): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function bearingDeg(a: RouteMapPoint, b: RouteMapPoint): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLon = toRadians(((((b.lon - a.lon) % 360) + 540) % 360) - 180);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function compassPoint(bearing: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(bearing / 45) % points.length]!;
}

function niceDistance(targetM: number): number {
  if (!Number.isFinite(targetM) || targetM <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(targetM));
  const normalized = targetM / power;
  const factors = [1, 2, 5, 10];
  const factor = factors.reduce((best, candidate) =>
    Math.abs(candidate - normalized) < Math.abs(best - normalized) ? candidate : best,
  );
  return factor * power;
}

function distanceLabel(meters: number, units: DisplayUnits): string {
  if (units === 'imperial') {
    const miles = meters / 1_609.344;
    if (miles < 0.1) return `${Math.round(meters * 3.280_839_895)} ft`;
    return `${Number.isInteger(miles) ? miles : miles.toFixed(1)} mi`;
  }
  if (meters < 1_000) return `${Math.round(meters)} m`;
  const kilometers = meters / 1_000;
  return `${Number.isInteger(kilometers) ? kilometers : kilometers.toFixed(1)} km`;
}

function pointAtDistance(
  edges: RouteEdge[],
  targetM: number,
): {
  position: RouteMapPoint;
  bearingDeg: number;
} | null {
  if (edges.length === 0) return null;
  let low = 0;
  let high = edges.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (edges[middle]!.endM < targetM) low = middle + 1;
    else high = middle;
  }
  const edge = edges[low]!;
  const edgeM = edge.endM - edge.startM;
  const fraction = edgeM > 0 ? Math.max(0, Math.min(1, (targetM - edge.startM) / edgeM)) : 0;
  return {
    position: {
      lat: edge.from.lat + (edge.to.lat - edge.from.lat) * fraction,
      lon: edge.from.lon + (edge.to.lon - edge.from.lon) * fraction,
    },
    bearingDeg: bearingDeg(edge.from, edge.to),
  };
}

function evenlySpaced<T>(values: T[], count: number): T[] {
  if (count >= values.length) return values;
  if (count <= 1) return values.length > 0 ? [values[0]!] : [];
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index * (values.length - 1)) / (count - 1));
    return values[sourceIndex]!;
  });
}

function allocateBudget(capacities: number[], budget: number): number[] {
  const allocations = capacities.map(() => 0);
  let remaining = Math.max(
    0,
    Math.min(
      budget,
      capacities.reduce((sum, value) => sum + value, 0),
    ),
  );
  let capacityLeft = capacities.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < capacities.length && remaining > 0; index++) {
    const capacity = capacities[index]!;
    const share =
      index === capacities.length - 1
        ? Math.min(capacity, remaining)
        : Math.min(capacity, Math.floor((remaining * capacity) / Math.max(1, capacityLeft)));
    allocations[index] = share;
    remaining -= share;
    capacityLeft -= capacity;
  }
  for (let index = 0; remaining > 0; index = (index + 1) % capacities.length) {
    if (allocations[index]! >= capacities[index]!) continue;
    allocations[index]! += 1;
    remaining -= 1;
  }
  return allocations;
}

function downsampleRuns(runs: LocatedRouteMapPoint[][]): LocatedRouteMapPoint[][] {
  let drawable = runs.filter((run) => run.length >= 2);
  if (drawable.length > MAX_RENDER_SEGMENTS) {
    drawable = evenlySpaced(drawable, MAX_RENDER_SEGMENTS);
  }
  const pointCount = drawable.reduce((sum, run) => sum + run.length, 0);
  if (pointCount <= MAX_RENDER_POINTS) return drawable;

  const base = drawable.length * 2;
  const extras = allocateBudget(
    drawable.map((run) => Math.max(0, run.length - 2)),
    Math.max(0, MAX_RENDER_POINTS - base),
  );
  return drawable.map((run, index) => evenlySpaced(run, 2 + extras[index]!));
}

function buildGradientChunks(renderRuns: LocatedRouteMapPoint[][], totalDistanceM: number) {
  const gradientRuns =
    renderRuns.length > MAX_GRADIENT_CHUNKS
      ? evenlySpaced(renderRuns, MAX_GRADIENT_CHUNKS)
      : renderRuns;
  const baseChunks = gradientRuns.length;
  const extraChunks = allocateBudget(
    gradientRuns.map((run) => Math.max(0, run.length - 2)),
    Math.max(0, MAX_GRADIENT_CHUNKS - baseChunks),
  );
  const chunks: RouteGradientChunk[] = [];

  for (let runIndex = 0; runIndex < gradientRuns.length; runIndex++) {
    const run = gradientRuns[runIndex]!;
    const edgeCount = run.length - 1;
    const chunkCount = Math.min(edgeCount, 1 + extraChunks[runIndex]!);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const firstEdge = Math.floor((chunkIndex * edgeCount) / chunkCount);
      const lastEdgeExclusive = Math.floor(((chunkIndex + 1) * edgeCount) / chunkCount);
      const points = run.slice(firstEdge, lastEdgeExclusive + 1);
      const first = points[0]!;
      const last = points[points.length - 1]!;
      chunks.push({
        points: points.map(({ lat, lon }) => ({ lat, lon })),
        progress:
          totalDistanceM > 0
            ? Math.max(0, Math.min(1, (first.cumulativeM + last.cumulativeM) / 2 / totalDistanceM))
            : 0,
      });
    }
  }
  return chunks;
}

/**
 * Builds a bounded, deterministic map model in linear time. Invalid coordinates
 * split runs instead of being bridged; route source segments remain separate.
 */
export function buildRouteMapModel(
  segments: { points: RoutePoint[] }[],
  displayUnits: DisplayUnits = 'metric',
): RouteMapModel | null {
  const validRuns: RoutePoint[][] = [];
  let currentRun: RoutePoint[] = [];
  let sourcePointCount = 0;
  let lonMin = Infinity;
  let lonMax = -Infinity;

  const closeRun = () => {
    if (currentRun.length > 0) validRuns.push(currentRun);
    currentRun = [];
  };

  for (const segment of segments) {
    for (const point of segment.points) {
      if (!isValidCoordinate(point)) {
        closeRun();
        continue;
      }
      currentRun.push(point);
      sourcePointCount += 1;
      lonMin = Math.min(lonMin, point.lon);
      lonMax = Math.max(lonMax, point.lon);
    }
    closeRun();
  }

  if (sourcePointCount < 2) return null;

  const crossesAntimeridian = lonMax - lonMin > 180;
  const locatedRuns: LocatedRouteMapPoint[][] = [];
  const edges: RouteEdge[] = [];
  const timedIndex: RouteMapModel['timedIndex'] = [];
  let lastTime = -Infinity;
  let totalDistanceM = 0;
  let latMin = Infinity;
  let latMax = -Infinity;
  lonMin = Infinity;
  lonMax = -Infinity;

  for (const run of validRuns) {
    const locatedRun: LocatedRouteMapPoint[] = [];
    for (const point of run) {
      const position = {
        lat: point.lat,
        lon: crossesAntimeridian && point.lon < 0 ? point.lon + 360 : point.lon,
      };
      const previous = locatedRun[locatedRun.length - 1];
      if (previous) {
        const edgeM = distanceM(previous, position);
        if (Number.isFinite(edgeM) && edgeM > 0) {
          const nextDistanceM = totalDistanceM + edgeM;
          const located = { ...position, cumulativeM: nextDistanceM };
          edges.push({
            from: previous,
            to: located,
            startM: totalDistanceM,
            endM: nextDistanceM,
          });
          totalDistanceM = nextDistanceM;
          locatedRun.push(located);
        } else {
          locatedRun.push({ ...position, cumulativeM: totalDistanceM });
        }
      } else {
        locatedRun.push({ ...position, cumulativeM: totalDistanceM });
      }

      latMin = Math.min(latMin, position.lat);
      latMax = Math.max(latMax, position.lat);
      lonMin = Math.min(lonMin, position.lon);
      lonMax = Math.max(lonMax, position.lon);
      if (typeof point.t === 'number' && Number.isFinite(point.t) && point.t >= lastTime) {
        timedIndex.push({ t: point.t, position });
        lastTime = point.t;
      }
    }
    if (locatedRun.length > 0) locatedRuns.push(locatedRun);
  }

  const first = locatedRuns[0]?.[0];
  const finalRun = locatedRuns[locatedRuns.length - 1];
  const last = finalRun?.[finalRun.length - 1];
  if (!first || !last || edges.length === 0) return null;

  const distanceMarkers: RouteMapMarker[] = [];
  if (totalDistanceM > 0) {
    const stepM = niceDistance(totalDistanceM / 4);
    for (
      let distance = stepM, markerCount = 0;
      distance < totalDistanceM && markerCount < 8;
      distance += stepM, markerCount++
    ) {
      const located = pointAtDistance(edges, distance);
      // Keep the finish label legible when the last rounded interval lands
      // almost on top of the endpoint.
      if (located && distance / totalDistanceM <= 0.92) {
        distanceMarkers.push({
          position: located.position,
          label: distanceLabel(distance, displayUnits),
        });
      }
    }
  }

  const directionMarkers: RouteMapDirectionMarker[] = [];
  for (const fraction of [0.25, 0.5, 0.75]) {
    const located = pointAtDistance(edges, totalDistanceM * fraction);
    if (!located) continue;
    const roundedBearing = Math.round(located.bearingDeg);
    directionMarkers.push({
      position: located.position,
      bearingDeg: located.bearingDeg,
      label: compassPoint(roundedBearing),
    });
  }

  const renderRuns = downsampleRuns(locatedRuns);
  const renderPointCount = renderRuns.reduce((sum, run) => sum + run.length, 0);
  return {
    bounds: [
      [latMin, lonMin],
      [latMax, lonMax],
    ],
    start: { position: { lat: first.lat, lon: first.lon }, label: 'Start' },
    finish: { position: { lat: last.lat, lon: last.lon }, label: 'Finish' },
    distanceMarkers,
    directionMarkers,
    renderRuns: renderRuns.map((run) => run.map(({ lat, lon }) => ({ lat, lon }))),
    gradientChunks: buildGradientChunks(renderRuns, totalDistanceM),
    timedIndex,
    totalDistanceM,
    recordingGapCount: Math.max(0, validRuns.length - 1),
    sourcePointCount,
    renderPointCount,
    simplified:
      renderPointCount < sourcePointCount ||
      locatedRuns.filter((run) => run.length >= 2).length > renderRuns.length,
  };
}

/** Find the nearest timed route position in O(log n). */
export function routePositionAtTime(model: RouteMapModel, time: number): RouteMapPoint | null {
  const index = model.timedIndex;
  if (index.length === 0 || !Number.isFinite(time)) return null;
  if (time <= index[0]!.t) return index[0]!.position;
  if (time >= index[index.length - 1]!.t) return index[index.length - 1]!.position;

  let low = 0;
  let high = index.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (index[middle]!.t <= time) low = middle;
    else high = middle;
  }
  return time - index[low]!.t <= index[high]!.t - time
    ? index[low]!.position
    : index[high]!.position;
}
