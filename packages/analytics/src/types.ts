import type { MetricSample, RouteSegment } from '@velograph/shared';

/** Input to the engine: normalized data already read from storage. */
export interface AnalyticsInput {
  workout: {
    id: number;
    type: string;
    startUtc: number;
    endUtc: number;
  };
  /** Metric samples in canonical units, sorted by time. */
  metrics: Partial<Record<'heart_rate' | 'cadence' | 'distance' | 'energy', MetricSample[]>>;
  /** Route segments (gaps preserved), possibly empty. */
  route: RouteSegment[];
}

export interface AnalyticsSettings {
  /** User-configured zone boundaries in bpm, ascending; null = not configured. */
  hrZoneBounds: number[] | null;
  /** Speed below this (m/s) counts as stopped for moving time. Provisional default pending PRD §20.3. */
  movingSpeedThresholdMs: number;
  /** Minimum coverage for efficiency/decoupling metrics. Provisional default pending PRD §20.5. */
  minCoverageForEfficiency: number;
  /** Elevation noise filter hysteresis in metres (versioned formula input). */
  elevationHysteresisM: number;
}

export interface MetricStat {
  avg: number | null;
  max: number | null;
  min: number | null;
  coverage: number | null;
  sampleCount: number;
}

export interface ZoneTime {
  zone: number;
  label: string;
  seconds: number;
  share: number;
}

export interface Split {
  index: number;
  /** 'km' for 1 km distance splits, 'time' for 5-minute splits. */
  kind: 'km' | 'time';
  startOffsetS: number;
  durationS: number;
  distanceM: number | null;
  avgSpeedMs: number | null;
  avgHr: number | null;
}

export interface RideAnalytics {
  formulaVersion: string;
  workoutId: number;
  durationS: number;
  movingTimeS: number | null;
  distanceM: number | null;
  avgSpeedMs: number | null;
  maxSpeedMs: number | null;
  heartRate: MetricStat;
  cadence: MetricStat;
  energyKj: number | null;
  elevation: {
    gainM: number | null;
    lossM: number | null;
    minM: number | null;
    maxM: number | null;
  };
  zones: ZoneTime[] | null;
  /** km/h per bpm; null when coverage below threshold or inputs missing. */
  efficiency: number | null;
  /**
   * Relative efficiency decline second half vs first half (positive = slower
   * per beat late in the ride). Terrain- and wind-sensitive proxy.
   */
  decouplingPct: number | null;
  pacingVariability: number | null;
  splits: Split[];
  /** Reasons metrics are unavailable, keyed by metric id (RIDE-006). */
  unavailable: Record<string, string>;
}
