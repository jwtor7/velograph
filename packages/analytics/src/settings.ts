import type { AnalyticsSettings } from './types.ts';

/**
 * Provisional defaults (PRD §20.3/§20.5 are maintainer decisions still open;
 * these are configurable settings, not hard-coded resolutions — see
 * docs/formulas.md).
 */
export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = {
  hrZoneBounds: null,
  movingSpeedThresholdMs: 1.0,
  minCoverageForEfficiency: 0.7,
  elevationHysteresisM: 1.0,
};

export const ZONE_LABELS = [
  'Z1 Recovery',
  'Z2 Endurance',
  'Z3 Tempo',
  'Z4 Threshold',
  'Z5 VO2 Max',
  'Z6 Anaerobic',
];
