import type { RideAnalytics } from '@velograph/analytics';
import type { ContextAvailability } from './context.ts';
import { DEFAULT_CONTEXT_AVAILABILITY } from './context.ts';

/**
 * Versioned, minimized AI payload (AI-003). Omission of route coordinates,
 * raw time-series rows, source file names/paths, device/source strings,
 * route names, and local notes is STRUCTURAL: `RideAnalytics` never carries
 * any of those fields, and the payload is built exclusively from
 * `METRIC_ALLOW_LIST` below plus a bounded zone-share summary — there is no
 * separate "strip sensitive fields" pass to fall out of sync. A reviewer can
 * audit everything the model can ever see by reading this one file.
 */
export const PAYLOAD_VERSION = 'insight-payload-v1';

export interface InsightMetric {
  /** Stable metric ID, cited by findings as evidence (AI-007). */
  id: string;
  value: number | null;
  unit: string;
}

export interface InsightZoneShare {
  /** Zone ID matching the evidence ID `hr_zone_<zone>_share` (see zoneMetricId). */
  zone: number;
  label: string;
  shareOfTime: number;
}

export interface InsightPayload {
  payloadVersion: typeof PAYLOAD_VERSION;
  /** Analytics formula version the metrics were computed with (ANA provenance). */
  formulaVersion: string;
  metrics: InsightMetric[];
  /** Heart-rate zone time shares, or null when zones are not configured. */
  zones: InsightZoneShare[] | null;
  /** IDs from `metrics` whose value is null — flags gaps instead of omitting them silently. */
  unavailableMetricIds: string[];
  context: ContextAvailability;
}

type MetricExtractor = (analytics: RideAnalytics) => number | null;

interface MetricSpec {
  id: string;
  unit: string;
  extract: MetricExtractor;
}

/**
 * The complete allow-list of scalars that may ever leave this package.
 * Every entry here is a single derived number from the deterministic
 * analytics engine — never a raw sample, coordinate, or string field.
 */
export const METRIC_ALLOW_LIST: readonly MetricSpec[] = [
  { id: 'duration_s', unit: 's', extract: (a) => a.durationS },
  { id: 'moving_time_s', unit: 's', extract: (a) => a.movingTimeS },
  { id: 'distance_m', unit: 'm', extract: (a) => a.distanceM },
  { id: 'avg_speed_ms', unit: 'm/s', extract: (a) => a.avgSpeedMs },
  { id: 'max_speed_ms', unit: 'm/s', extract: (a) => a.maxSpeedMs },
  { id: 'heart_rate_avg_bpm', unit: 'bpm', extract: (a) => a.heartRate.avg },
  { id: 'heart_rate_max_bpm', unit: 'bpm', extract: (a) => a.heartRate.max },
  { id: 'heart_rate_min_bpm', unit: 'bpm', extract: (a) => a.heartRate.min },
  { id: 'heart_rate_coverage_ratio', unit: 'ratio', extract: (a) => a.heartRate.coverage },
  { id: 'cadence_avg_rpm', unit: 'rpm', extract: (a) => a.cadence.avg },
  { id: 'cadence_max_rpm', unit: 'rpm', extract: (a) => a.cadence.max },
  { id: 'cadence_coverage_ratio', unit: 'ratio', extract: (a) => a.cadence.coverage },
  { id: 'energy_kj', unit: 'kJ', extract: (a) => a.energyKj },
  { id: 'elevation_gain_m', unit: 'm', extract: (a) => a.elevation.gainM },
  { id: 'elevation_loss_m', unit: 'm', extract: (a) => a.elevation.lossM },
  { id: 'efficiency_kmh_per_bpm', unit: 'km/h/bpm', extract: (a) => a.efficiency },
  { id: 'decoupling_pct', unit: '%', extract: (a) => a.decouplingPct },
  { id: 'pacing_variability_ratio', unit: 'ratio', extract: (a) => a.pacingVariability },
] as const;

/** Evidence ID for a heart-rate zone's time share — shared by builder and validator. */
export function zoneMetricId(zone: number): string {
  return `hr_zone_${zone}_share`;
}

function buildZoneShares(analytics: RideAnalytics): InsightZoneShare[] | null {
  if (!analytics.zones) return null;
  return analytics.zones.map((z) => ({
    zone: z.zone,
    label: z.label,
    shareOfTime: z.share,
  }));
}

/**
 * Pure builder: `RideAnalytics` + context flags -> versioned minimized
 * payload. No I/O, no clock, no randomness.
 */
export function buildInsightPayload(
  analytics: RideAnalytics,
  context: ContextAvailability = DEFAULT_CONTEXT_AVAILABILITY,
): InsightPayload {
  const metrics: InsightMetric[] = METRIC_ALLOW_LIST.map((spec) => ({
    id: spec.id,
    unit: spec.unit,
    value: spec.extract(analytics),
  }));
  return {
    payloadVersion: PAYLOAD_VERSION,
    formulaVersion: analytics.formulaVersion,
    metrics,
    zones: buildZoneShares(analytics),
    unavailableMetricIds: metrics.filter((m) => m.value === null).map((m) => m.id),
    context,
  };
}

/** All metric IDs a finding may legally cite as evidence for this payload. */
export function evidenceIdsForPayload(payload: InsightPayload): Set<string> {
  const ids = new Set(payload.metrics.map((m) => m.id));
  for (const z of payload.zones ?? []) ids.add(zoneMetricId(z.zone));
  return ids;
}
