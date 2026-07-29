/**
 * Canonical domain types. Storage truth is SI units and absolute instants
 * (epoch milliseconds, UTC); unit/timezone conversion happens only at render.
 */

export type WorkoutType = 'outdoor_cycling' | 'indoor_cycling';

export type MetricKind = 'heart_rate' | 'cadence' | 'distance' | 'energy';

/** Canonical units per metric kind (SI or SI-adjacent counts). */
export const CANONICAL_UNITS: Record<MetricKind, string> = {
  heart_rate: 'bpm',
  cadence: 'rpm',
  distance: 'm',
  energy: 'J',
};

export interface MetricSample {
  /** Absolute instant, epoch ms UTC. */
  t: number;
  /** Canonical-unit value (avg for aggregated rows). */
  value: number;
  min?: number;
  max?: number;
  context?: string;
}

export interface RoutePoint {
  /** Absolute instant, epoch ms UTC, when recorded. */
  t?: number | null;
  lat: number;
  lon: number;
  /** Elevation in metres, when recorded. */
  ele?: number;
  /** Speed in m/s, when recorded. */
  speed?: number;
  /** Course in degrees, when recorded. */
  course?: number;
  hAcc?: number;
  vAcc?: number;
}

export interface RouteSegment {
  points: RoutePoint[];
}

export type SourceFileKind =
  { kind: 'metric'; metric: MetricKind } | { kind: 'route_csv' } | { kind: 'route_gpx' };

export interface ParsedMetricFile {
  kind: 'metric';
  metric: MetricKind;
  workoutType: WorkoutType;
  /** Source string from the export rows (device name); data, never code. */
  source: string | null;
  samples: MetricSample[];
}

export interface ParsedRouteFile {
  kind: 'route';
  format: 'gpx' | 'csv';
  workoutType: WorkoutType;
  segments: RouteSegment[];
}

export type ParsedFile = ParsedMetricFile | ParsedRouteFile;

/**
 * Stable, value-free error codes for quarantined files (IMP-008): safe to log
 * and display without exposing sample values.
 */
export type QuarantineCode =
  | 'unsupported_file_type'
  | 'unrecognized_headers'
  | 'empty_file'
  | 'malformed_csv'
  | 'malformed_xml'
  | 'xml_doctype_rejected'
  | 'gpx_limits_exceeded'
  | 'no_valid_samples'
  | 'timestamps_invalid'
  | 'numeric_value_invalid'
  | 'association_conflict'
  | 'association_ambiguous'
  | 'zip_entry_rejected'
  | 'zip_limits_exceeded'
  | 'io_error';

export interface ImportCounts {
  imported: number;
  skippedDuplicates: number;
  quarantined: number;
  workoutsCreated: number;
  workoutsUpdated: number;
}
