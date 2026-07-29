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
export const FORMULA_VERSION = 'analytics-v1';

/** Gap cap: a sample "covers" at most this much time (ms). */
const COVERAGE_GAP_CAP_MS = 90_000;

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round1 = (v: number) => Math.round(v * 10) / 10;

export function computeRideAnalytics(
  input: AnalyticsInput,
  settings: AnalyticsSettings,
): RideAnalytics {
  const durationS = Math.round((input.workout.endUtc - input.workout.startUtc) / 1000);
  const unavailable: Record<string, string> = {};

  const hrSamples = input.metrics.heart_rate ?? [];
  const cadSamples = input.metrics.cadence ?? [];
  const distSamples = input.metrics.distance ?? [];
  const energySamples = input.metrics.energy ?? [];

  const heartRate = metricStat(hrSamples, durationS);
  const cadence = metricStat(cadSamples, durationS);

  const distanceM = distSamples.length
    ? round3(distSamples.reduce((acc, s) => acc + s.value, 0))
    : null;
  if (distanceM == null) unavailable['distance'] = 'no_distance_samples';

  const energyKj = energySamples.length
    ? round3(energySamples.reduce((acc, s) => acc + s.value, 0) / 1000)
    : null;
  if (energyKj == null) unavailable['energy'] = 'no_energy_samples';

  const routeSpeeds = collectRouteSpeeds(input.route);
  const movingTimeS = movingTime(input.route, settings.movingSpeedThresholdMs);
  if (movingTimeS == null) unavailable['moving_time'] = 'no_route_timing';

  const avgSpeedMs =
    distanceM != null && movingTimeS != null && movingTimeS > 0
      ? round3(distanceM / movingTimeS)
      : distanceM != null && durationS > 0
        ? round3(distanceM / durationS)
        : null;
  if (avgSpeedMs == null) unavailable['avg_speed'] = 'no_distance_or_duration';

  const maxSpeedMs = routeSpeeds.length ? round3(Math.max(...routeSpeeds)) : null;
  if (maxSpeedMs == null) unavailable['max_speed'] = 'no_route_speeds';

  const elevation = elevationProfile(input.route, settings.elevationHysteresisM);
  if (elevation.gainM == null) unavailable['elevation'] = 'no_elevation_data';

  const zones = settings.hrZoneBounds
    ? zoneTimes(hrSamples, settings.hrZoneBounds, durationS)
    : null;
  if (!settings.hrZoneBounds) unavailable['zones'] = 'zones_not_configured';

  const efficiency = efficiencyRatio(avgSpeedMs, heartRate, settings.minCoverageForEfficiency);
  if (efficiency == null) unavailable['efficiency'] = 'insufficient_coverage_or_inputs';

  const decouplingPct = decoupling(input, settings);
  if (decouplingPct == null) unavailable['decoupling'] = 'insufficient_half_data';

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

/** Interval-weighted mean/extremes + coverage for a sample stream. */
function metricStat(samples: MetricSample[], durationS: number): MetricStat {
  if (samples.length === 0) {
    return { avg: null, max: null, min: null, coverage: null, sampleCount: 0 };
  }
  const weights = intervalWeights(samples);
  let wSum = 0;
  let vSum = 0;
  let max = -Infinity;
  let min = Infinity;
  samples.forEach((s, i) => {
    const w = weights[i]!;
    wSum += w;
    vSum += s.value * w;
    const hi = s.max ?? s.value;
    const lo = s.min ?? s.value;
    if (hi > max) max = hi;
    if (lo < min) min = lo;
  });
  const coverage = durationS > 0 ? Math.min(1, wSum / 1000 / durationS) : null;
  return {
    avg: wSum > 0 ? round3(vSum / wSum) : null,
    max: round3(max),
    min: round3(min),
    coverage: coverage != null ? round3(coverage) : null,
    sampleCount: samples.length,
  };
}

/** Weight per sample: time to next sample, capped (ms). Last sample gets the median interval. */
function intervalWeights(samples: MetricSample[]): number[] {
  const n = samples.length;
  if (n === 1) return [60_000];
  const gaps: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    gaps.push(Math.min(samples[i + 1]!.t - samples[i]!.t, COVERAGE_GAP_CAP_MS));
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)]!;
  return [...gaps, median];
}

function collectRouteSpeeds(route: RouteSegment[]): number[] {
  const speeds: number[] = [];
  for (const seg of route) {
    for (const p of seg.points) {
      if (p.speed != null && Number.isFinite(p.speed)) speeds.push(p.speed);
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

/**
 * Moving time: time in route intervals whose recorded — or, when unrecorded,
 * geometry-derived — speed exceeds the threshold (ANA-001, §8.3 definitions).
 */
function movingTime(route: RouteSegment[], thresholdMs: number): number | null {
  let ms = 0;
  let sawTiming = false;
  for (const seg of route) {
    for (let i = 0; i < seg.points.length - 1; i++) {
      const a = seg.points[i]!;
      const b = seg.points[i + 1]!;
      if (a.t == null || b.t == null || b.t <= a.t) continue;
      sawTiming = true;
      const dt = Math.min(b.t - a.t, COVERAGE_GAP_CAP_MS);
      const speed = a.speed ?? haversineM(a.lat, a.lon, b.lat, b.lon) / ((b.t - a.t) / 1000);
      if (speed >= thresholdMs) ms += dt;
    }
  }
  return sawTiming ? Math.round(ms / 1000) : null;
}

/** Elevation gain/loss after a symmetric hysteresis noise filter (versioned). */
function elevationProfile(route: RouteSegment[], hysteresisM: number): RideAnalytics['elevation'] {
  const eles: number[] = [];
  for (const seg of route) {
    for (const p of seg.points) {
      if (p.ele != null) eles.push(p.ele);
    }
  }
  if (eles.length < 2) return { gainM: null, lossM: null, minM: null, maxM: null };
  let gain = 0;
  let loss = 0;
  let anchor = eles[0]!;
  for (const e of eles) {
    const delta = e - anchor;
    if (delta >= hysteresisM) {
      gain += delta;
      anchor = e;
    } else if (delta <= -hysteresisM) {
      loss += -delta;
      anchor = e;
    }
  }
  return {
    gainM: round1(gain),
    lossM: round1(loss),
    minM: round1(Math.min(...eles)),
    maxM: round1(Math.max(...eles)),
  };
}

/** Interval-weighted time in user-configured zones (ANA-002) — never row counts. */
function zoneTimes(samples: MetricSample[], bounds: number[], durationS: number): ZoneTime[] {
  const zoneCount = bounds.length + 1;
  const ms = new Array<number>(zoneCount).fill(0);
  if (samples.length > 0) {
    const weights = intervalWeights(samples);
    samples.forEach((s, i) => {
      let z = 0;
      while (z < bounds.length && s.value >= bounds[z]!) z++;
      ms[z]! += weights[i]!;
    });
  }
  const totalS = Math.max(durationS, ms.reduce((a, b) => a + b, 0) / 1000);
  return ms.map((m, i) => ({
    zone: i + 1,
    label: ZONE_LABELS[i] ?? `Z${i + 1}`,
    seconds: Math.round(m / 1000),
    share: totalS > 0 ? round3(m / 1000 / totalS) : 0,
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

/** First-half vs second-half efficiency decline percentage (ANA-004). */
function decoupling(input: AnalyticsInput, settings: AnalyticsSettings): number | null {
  const hr = input.metrics.heart_rate ?? [];
  const dist = input.metrics.distance ?? [];
  if (hr.length < 4 || dist.length < 4) return null;
  const mid = input.workout.startUtc + (input.workout.endUtc - input.workout.startUtc) / 2;

  const halfEff = (from: number, to: number): number | null => {
    const hrHalf = hr.filter((s) => s.t >= from && s.t < to);
    const distHalf = dist.filter((s) => s.t >= from && s.t < to);
    if (hrHalf.length < 2 || distHalf.length < 2) return null;
    const stat = metricStat(hrHalf, (to - from) / 1000);
    if (stat.avg == null || stat.coverage == null) return null;
    if (stat.coverage < settings.minCoverageForEfficiency) return null;
    const meters = distHalf.reduce((a, s) => a + s.value, 0);
    const speedKmh = (meters / ((to - from) / 1000)) * 3.6;
    return speedKmh / stat.avg;
  };

  const first = halfEff(input.workout.startUtc, mid);
  const second = halfEff(mid, input.workout.endUtc);
  if (first == null || second == null || first <= 0) return null;
  return round3(((first - second) / first) * 100);
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

  // 1 km distance splits from cumulative distance samples.
  let cum = 0;
  let kmIndex = 0;
  let splitStartT = start;
  let splitStartCum = 0;
  for (const s of dist) {
    cum += s.value;
    while (cum - splitStartCum >= 1000) {
      kmIndex++;
      const durationS = Math.max(1, Math.round((s.t - splitStartT) / 1000));
      splits.push({
        index: kmIndex,
        kind: 'km',
        startOffsetS: Math.round((splitStartT - start) / 1000),
        durationS,
        distanceM: 1000,
        avgSpeedMs: round3(1000 / durationS),
        avgHr: avgInWindow(hr, splitStartT, s.t),
      });
      splitStartT = s.t;
      splitStartCum += 1000;
    }
  }

  // 5-minute time splits.
  const windowMs = 5 * 60 * 1000;
  let idx = 0;
  for (let t = start; t < input.workout.endUtc; t += windowMs) {
    idx++;
    const to = Math.min(t + windowMs, input.workout.endUtc);
    const meters = dist.filter((s) => s.t >= t && s.t < to).reduce((a, s) => a + s.value, 0);
    const durationS = Math.round((to - t) / 1000);
    splits.push({
      index: idx,
      kind: 'time',
      startOffsetS: Math.round((t - start) / 1000),
      durationS,
      distanceM: meters > 0 ? round3(meters) : null,
      avgSpeedMs: meters > 0 && durationS > 0 ? round3(meters / durationS) : null,
      avgHr: avgInWindow(hr, t, to),
    });
  }
  return splits;
}

function avgInWindow(samples: MetricSample[], from: number, to: number): number | null {
  const inWin = samples.filter((s) => s.t >= from && s.t < to);
  if (inWin.length === 0) return null;
  const stat = metricStat(inWin, (to - from) / 1000);
  return stat.avg;
}
