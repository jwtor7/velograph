import type { MetricSample, RouteSegment } from '@velograph/shared';
import type {
  AnalyticsInput,
  AnalyticsSettings,
  MetricStat,
  RideAnalytics,
  Split,
  ZoneTime,
} from './types.ts';
import { ZONE_LABELS } from './settings.ts';

/**
 * Deterministic analytics engine (ANA-001..005). Every formula here is
 * versioned by FORMULA_VERSION and documented in docs/formulas.md. The same
 * input + settings + version produce byte-identical output: iteration order
 * is fixed, all rounding goes through round3/round1, and no clock, locale,
 * randomness, or I/O is consulted.
 */
export const FORMULA_VERSION = 'analytics-v2';

/** Gap cap: a sample "covers" at most this much time (ms). */
const COVERAGE_GAP_CAP_MS = 90_000;
const SINGLE_SAMPLE_COVERAGE_MS = 60_000;
const MIN_DECOUPLING_BASELINE = 0.01;
const MAX_ABS_DECOUPLING_PCT = 100;

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round1 = (v: number) => Math.round(v * 10) / 10;

export function computeRideAnalytics(
  input: AnalyticsInput,
  settings: AnalyticsSettings,
): RideAnalytics {
  const { startUtc, endUtc } = input.workout;
  const durationS = Math.max(0, Math.round((endUtc - startUtc) / 1000));
  const unavailable: Record<string, string> = {};

  const hrSamples = input.metrics.heart_rate ?? [];
  const cadSamples = input.metrics.cadence ?? [];
  const distSamples = input.metrics.distance ?? [];
  const energySamples = input.metrics.energy ?? [];

  const heartRate = metricStat(hrSamples, startUtc, endUtc);
  const cadence = metricStat(cadSamples, startUtc, endUtc);

  const distanceM = distSamples.length
    ? round3(distSamples.reduce((acc, s) => acc + s.value, 0))
    : null;
  if (distanceM == null) unavailable['distance'] = 'no_distance_samples';

  const energyKj = energySamples.length
    ? round3(energySamples.reduce((acc, s) => acc + s.value, 0) / 1000)
    : null;
  if (energyKj == null) unavailable['energy'] = 'no_energy_samples';

  const routeSpeeds = collectRouteSpeeds(input.route);
  const routeTiming = routeWindowStats(
    input.route,
    settings.movingSpeedThresholdMs,
    startUtc,
    endUtc,
  );
  const movingTimeS = routeTiming.coveredMs > 0 ? round3(routeTiming.movingMs / 1000) : null;
  if (movingTimeS == null) unavailable['moving_time'] = 'no_route_timing';

  const avgSpeedMs =
    distanceM != null && movingTimeS != null && movingTimeS > 0
      ? round3(distanceM / movingTimeS)
      : distanceM != null && durationS > 0
        ? round3(distanceM / durationS)
        : null;
  if (avgSpeedMs == null) unavailable['avg_speed'] = 'no_distance_or_duration';

  const maxSpeedMs = routeSpeeds.length
    ? round3(routeSpeeds.reduce((maximum, speed) => Math.max(maximum, speed), -Infinity))
    : null;
  if (maxSpeedMs == null) unavailable['max_speed'] = 'no_route_speeds';

  const elevation = elevationProfile(input.route, settings.elevationHysteresisM);
  if (elevation.gainM == null) unavailable['elevation'] = 'no_elevation_data';

  const zones = settings.hrZoneBounds
    ? zoneTimes(hrSamples, settings.hrZoneBounds, startUtc, endUtc)
    : null;
  if (!settings.hrZoneBounds) unavailable['zones'] = 'zones_not_configured';

  const efficiency = efficiencyRatio(avgSpeedMs, heartRate, settings.minCoverageForEfficiency);
  if (efficiency == null) unavailable['efficiency'] = 'insufficient_coverage_or_inputs';

  const decouplingResult = decoupling(input, settings);
  const decouplingPct = decouplingResult.value;
  if (decouplingPct == null) {
    unavailable['decoupling'] = decouplingResult.reason ?? 'insufficient_half_data';
  }

  const pacingVariability = pacing(distSamples);
  if (pacingVariability == null)
    unavailable['pacing_variability'] = 'insufficient_distance_samples';

  return {
    formulaVersion: FORMULA_VERSION,
    workoutId: input.workout.id,
    durationS,
    movingTimeS,
    distanceM,
    avgSpeedMs,
    maxSpeedMs,
    heartRate,
    cadence,
    energyKj,
    elevation,
    zones,
    efficiency,
    decouplingPct,
    pacingVariability,
    splits: computeSplits(input),
    unavailable,
  };
}

/** Interval-weighted mean/extremes + coverage for an explicit [from, to) window. */
function metricStat(samples: MetricSample[], from: number, to: number): MetricStat {
  if (samples.length === 0) {
    return { avg: null, max: null, min: null, coverage: null, sampleCount: 0 };
  }
  const weights = intervalWeights(samples, from, to);
  let wSum = 0;
  let vSum = 0;
  let max = -Infinity;
  let min = Infinity;
  samples.forEach((s, i) => {
    const w = weights[i]!;
    if (w <= 0) return;
    wSum += w;
    vSum += s.value * w;
    const hi = s.max ?? s.value;
    const lo = s.min ?? s.value;
    if (hi > max) max = hi;
    if (lo < min) min = lo;
  });
  const windowMs = Math.max(0, to - from);
  const coverage = windowMs > 0 ? Math.min(1, wSum / windowMs) : null;
  return {
    avg: wSum > 0 ? round3(vSum / wSum) : null,
    max: max === -Infinity ? null : round3(max),
    min: min === Infinity ? null : round3(min),
    coverage: coverage != null ? round3(coverage) : null,
    sampleCount: samples.length,
  };
}

/**
 * Forward sample coverage intersected with [from, to). The final sample gets
 * the stream's median positive interval (60 s for a singleton), still capped
 * and clipped. A sample at `to` therefore has zero weight.
 */
function intervalWeights(samples: MetricSample[], from: number, to: number): number[] {
  const n = samples.length;
  const gaps: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const gap = samples[i + 1]!.t - samples[i]!.t;
    if (gap > 0) gaps.push(Math.min(gap, COVERAGE_GAP_CAP_MS));
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? SINGLE_SAMPLE_COVERAGE_MS;

  return samples.map((sample, index) => {
    const next = samples[index + 1];
    const forwardMs = next ? Math.min(Math.max(0, next.t - sample.t), COVERAGE_GAP_CAP_MS) : median;
    const coveredFrom = Math.max(from, sample.t);
    const coveredTo = Math.min(to, sample.t + forwardMs);
    return Math.max(0, coveredTo - coveredFrom);
  });
}

/**
 * Recorded point speeds; when none are recorded, speeds derived from
 * successive positions (haversine / dt, intervals ≤ the gap cap only).
 */
function collectRouteSpeeds(route: RouteSegment[]): number[] {
  const speeds: number[] = [];
  for (const seg of route) {
    for (const p of seg.points) {
      if (p.speed != null && Number.isFinite(p.speed)) speeds.push(p.speed);
    }
  }
  if (speeds.length > 0) return speeds;
  for (const seg of route) {
    for (let i = 0; i < seg.points.length - 1; i++) {
      const a = seg.points[i]!;
      const b = seg.points[i + 1]!;
      if (a.t == null || b.t == null || b.t <= a.t) continue;
      const dtS = (b.t - a.t) / 1000;
      if (dtS * 1000 > COVERAGE_GAP_CAP_MS) continue;
      speeds.push(haversineM(a.lat, a.lon, b.lat, b.lon) / dtS);
    }
  }
  return speeds;
}

/** Great-circle distance in metres (haversine, spherical earth R = 6371008.8 m). */
export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

interface TimeInterval {
  from: number;
  to: number;
}

function unionDuration(intervals: TimeInterval[]): number {
  if (intervals.length === 0) return 0;
  const ordered = [...intervals].sort((a, b) => a.from - b.from || a.to - b.to);
  let total = 0;
  let from = ordered[0]!.from;
  let to = ordered[0]!.to;
  for (let index = 1; index < ordered.length; index++) {
    const interval = ordered[index]!;
    if (interval.from > to) {
      total += to - from;
      from = interval.from;
      to = interval.to;
    } else if (interval.to > to) {
      to = interval.to;
    }
  }
  return total + (to - from);
}

/**
 * Route coverage and moving time within [from, to). Every source/segment is a
 * hard boundary, intervals are capped before clipping, and overlapping route
 * files are unioned so duplicate geometry cannot double-count time.
 */
function routeWindowStats(
  route: RouteSegment[],
  thresholdMs: number,
  from: number,
  to: number,
): { coveredMs: number; movingMs: number } {
  const covered: TimeInterval[] = [];
  const moving: TimeInterval[] = [];
  for (const seg of route) {
    for (let i = 0; i < seg.points.length - 1; i++) {
      const a = seg.points[i]!;
      const b = seg.points[i + 1]!;
      if (a.t == null || b.t == null || b.t <= a.t) continue;
      const interval = {
        from: Math.max(from, a.t),
        to: Math.min(to, a.t + Math.min(b.t - a.t, COVERAGE_GAP_CAP_MS)),
      };
      if (interval.to <= interval.from) continue;
      covered.push(interval);
      const speed = a.speed ?? haversineM(a.lat, a.lon, b.lat, b.lon) / ((b.t - a.t) / 1000);
      if (Number.isFinite(speed) && speed >= thresholdMs) moving.push(interval);
    }
  }
  return { coveredMs: unionDuration(covered), movingMs: unionDuration(moving) };
}

/** Elevation gain/loss after a symmetric hysteresis noise filter (versioned). */
function elevationProfile(route: RouteSegment[], hysteresisM: number): RideAnalytics['elevation'] {
  const eles: number[] = [];
  let gain = 0;
  let loss = 0;
  for (const seg of route) {
    const segmentEles: number[] = [];
    for (const p of seg.points) {
      if (p.ele != null) {
        eles.push(p.ele);
        segmentEles.push(p.ele);
      }
    }
    if (segmentEles.length < 2) continue;
    let anchor = segmentEles[0]!;
    for (const elevation of segmentEles.slice(1)) {
      const delta = elevation - anchor;
      if (delta >= hysteresisM) {
        gain += delta;
        anchor = elevation;
      } else if (delta <= -hysteresisM) {
        loss += -delta;
        anchor = elevation;
      }
    }
  }
  if (eles.length < 2) return { gainM: null, lossM: null, minM: null, maxM: null };
  return {
    gainM: round1(gain),
    lossM: round1(loss),
    minM: round1(eles.reduce((minimum, elevation) => Math.min(minimum, elevation), Infinity)),
    maxM: round1(eles.reduce((maximum, elevation) => Math.max(maximum, elevation), -Infinity)),
  };
}

/** Interval-weighted time in user-configured zones (ANA-002) — never row counts. */
function zoneTimes(
  samples: MetricSample[],
  bounds: number[],
  from: number,
  to: number,
): ZoneTime[] {
  const zoneCount = bounds.length + 1;
  const ms = new Array<number>(zoneCount).fill(0);
  if (samples.length > 0) {
    const weights = intervalWeights(samples, from, to);
    samples.forEach((s, i) => {
      if (weights[i]! <= 0) return;
      let z = 0;
      while (z < bounds.length && s.value >= bounds[z]!) z++;
      ms[z]! += weights[i]!;
    });
  }
  const windowMs = Math.max(0, to - from);
  const totalMs = ms.reduce((a, b) => a + b, 0);
  const targetSeconds = Math.min(Math.floor(windowMs / 1000), Math.round(totalMs / 1000));
  const seconds = ms.map((value) => Math.floor(value / 1000));
  let remaining = Math.max(0, targetSeconds - seconds.reduce((sum, value) => sum + value, 0));
  const remainderOrder = ms
    .map((value, index) => ({ index, remainder: value / 1000 - Math.floor(value / 1000) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of remainderOrder) {
    if (remaining === 0) break;
    seconds[entry.index]! += 1;
    remaining--;
  }
  return ms.map((m, i) => ({
    zone: i + 1,
    label: ZONE_LABELS[i] ?? `Z${i + 1}`,
    seconds: seconds[i]!,
    share: windowMs > 0 ? round3(m / windowMs) : 0,
  }));
}

/** Efficiency: avg speed (km/h) / avg HR (bpm), coverage-gated (ANA-003). */
function efficiencyRatio(
  avgSpeedMs: number | null,
  hr: MetricStat,
  minCoverage: number,
): number | null {
  if (avgSpeedMs == null || hr.avg == null || hr.coverage == null) return null;
  if (hr.coverage < minCoverage || hr.avg <= 0) return null;
  return round3((avgSpeedMs * 3.6) / hr.avg);
}

interface DistanceInterval {
  from: number;
  to: number;
  meters: number;
}

/**
 * Distance rows are interval increments ending at their timestamp. The prior
 * row timestamp is the interval start; the workout start anchors the first
 * row. Zero-duration increments remain part of total distance but provide no
 * timing evidence and are not assigned to a split or half.
 */
function distanceIntervals(samples: MetricSample[], workoutStart: number): DistanceInterval[] {
  const intervals: DistanceInterval[] = [];
  let previous = workoutStart;
  for (const sample of samples) {
    intervals.push({ from: previous, to: sample.t, meters: sample.value });
    if (sample.t > previous) previous = sample.t;
  }
  return intervals;
}

function distanceInWindow(
  intervals: DistanceInterval[],
  from: number,
  to: number,
): { meters: number; coverage: number } {
  const windowMs = Math.max(0, to - from);
  if (windowMs === 0) return { meters: 0, coverage: 0 };
  let meters = 0;
  const coverageIntervals: TimeInterval[] = [];
  for (const interval of intervals) {
    const duration = interval.to - interval.from;
    if (duration <= 0 || !Number.isFinite(interval.meters)) continue;
    const overlapFrom = Math.max(from, interval.from);
    const overlapTo = Math.min(to, interval.to);
    if (overlapTo > overlapFrom) {
      meters += interval.meters * ((overlapTo - overlapFrom) / duration);
    }

    // Because the increment ends at `to`, sparse coverage is end-aligned.
    const covered = {
      from: Math.max(from, interval.from, interval.to - COVERAGE_GAP_CAP_MS),
      to: Math.min(to, interval.to),
    };
    if (covered.to > covered.from) coverageIntervals.push(covered);
  }
  return {
    meters,
    coverage: Math.min(1, unionDuration(coverageIntervals) / windowMs),
  };
}

interface DecouplingResult {
  value: number | null;
  reason?: string;
}

/** First-half vs second-half moving-time efficiency decline (ANA-004). */
function decoupling(input: AnalyticsInput, settings: AnalyticsSettings): DecouplingResult {
  const hr = input.metrics.heart_rate ?? [];
  const dist = input.metrics.distance ?? [];
  if (hr.length === 0 || dist.length === 0) {
    return { value: null, reason: 'insufficient_half_samples' };
  }
  const mid = input.workout.startUtc + (input.workout.endUtc - input.workout.startUtc) / 2;
  const distance = distanceIntervals(dist, input.workout.startUtc);

  const halfEff = (from: number, to: number): { value: number | null; reason?: string } => {
    const stat = metricStat(hr, from, to);
    if (
      stat.avg == null ||
      stat.avg <= 0 ||
      stat.coverage == null ||
      stat.coverage < settings.minCoverageForEfficiency
    ) {
      return { value: null, reason: 'insufficient_half_hr_coverage' };
    }
    const distanceHalf = distanceInWindow(distance, from, to);
    if (distanceHalf.coverage < settings.minCoverageForEfficiency) {
      return { value: null, reason: 'insufficient_half_distance_coverage' };
    }
    const routeHalf = routeWindowStats(input.route, settings.movingSpeedThresholdMs, from, to);
    const routeCoverage = routeHalf.coveredMs / Math.max(1, to - from);
    if (routeCoverage < settings.minCoverageForEfficiency) {
      return { value: null, reason: 'insufficient_half_route_coverage' };
    }
    if (routeHalf.movingMs <= 0 || distanceHalf.meters <= 0) {
      return { value: null, reason: 'no_half_moving_time_or_distance' };
    }
    const speedKmh = (distanceHalf.meters / (routeHalf.movingMs / 1000)) * 3.6;
    const value = speedKmh / stat.avg;
    return Number.isFinite(value) ? { value } : { value: null, reason: 'unstable_half_efficiency' };
  };

  const first = halfEff(input.workout.startUtc, mid);
  const second = halfEff(mid, input.workout.endUtc);
  if (first.value == null) {
    return { value: null, reason: first.reason ?? 'insufficient_first_half_data' };
  }
  if (second.value == null) {
    return { value: null, reason: second.reason ?? 'insufficient_second_half_data' };
  }
  if (first.value < MIN_DECOUPLING_BASELINE) {
    return { value: null, reason: 'unstable_first_half_efficiency' };
  }
  const value = ((first.value - second.value) / first.value) * 100;
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_DECOUPLING_PCT) {
    return { value: null, reason: 'implausible_decoupling' };
  }
  return { value: round3(value) };
}

/** Coefficient of variation of per-sample distance rates (ANA-005). */
function pacing(dist: MetricSample[]): number | null {
  if (dist.length < 4) return null;
  const values = dist.map((s) => s.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return round3(Math.sqrt(variance) / mean);
}

/** Fixed splits: 1 km by cumulative distance and 5-minute by time (ANA-005). */
function computeSplits(input: AnalyticsInput): Split[] {
  const splits: Split[] = [];
  const dist = input.metrics.distance ?? [];
  const hr = input.metrics.heart_rate ?? [];
  const start = input.workout.startUtc;
  const distance = distanceIntervals(dist, start);

  // 1 km splits. Every threshold is interpolated within its ending increment.
  let cum = 0;
  let thresholdM = 1000;
  let previousCrossingT: number | null = start;
  let splitHasCompleteTiming = true;
  for (const interval of distance) {
    const increment = Number.isFinite(interval.meters) ? Math.max(0, interval.meters) : 0;
    const before = cum;
    cum += increment;
    if (increment > 0 && interval.to <= interval.from) splitHasCompleteTiming = false;
    while (thresholdM <= cum && increment > 0) {
      const fraction = (thresholdM - before) / increment;
      const crossingT =
        interval.to > interval.from && fraction >= 0 && fraction <= 1
          ? interval.from + fraction * (interval.to - interval.from)
          : null;
      const index = thresholdM / 1000;
      if (
        splitHasCompleteTiming &&
        crossingT != null &&
        previousCrossingT != null &&
        crossingT > previousCrossingT
      ) {
        const durationMs = crossingT - previousCrossingT;
        splits.push({
          index,
          kind: 'km',
          startOffsetS: round3((previousCrossingT - start) / 1000),
          durationS: round3(durationMs / 1000),
          distanceM: 1000,
          avgSpeedMs: round3(1_000_000 / durationMs),
          avgHr: avgInWindow(hr, previousCrossingT, crossingT),
        });
      }
      previousCrossingT = crossingT;
      splitHasCompleteTiming = crossingT != null;
      thresholdM += 1000;
    }
  }

  // 5-minute time splits allocate interval increments proportionally to overlap.
  const windowMs = 5 * 60 * 1000;
  let idx = 0;
  for (let t = start; t < input.workout.endUtc; t += windowMs) {
    idx++;
    const to = Math.min(t + windowMs, input.workout.endUtc);
    const meters = distanceInWindow(distance, t, to).meters;
    const durationS = round3((to - t) / 1000);
    splits.push({
      index: idx,
      kind: 'time',
      startOffsetS: round3((t - start) / 1000),
      durationS,
      distanceM: meters > 0 ? round3(meters) : null,
      avgSpeedMs: meters > 0 && durationS > 0 ? round3(meters / durationS) : null,
      avgHr: avgInWindow(hr, t, to),
    });
  }
  return splits;
}

function avgInWindow(samples: MetricSample[], from: number, to: number): number | null {
  return metricStat(samples, from, to).avg;
}
