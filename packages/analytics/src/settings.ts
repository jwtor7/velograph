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

export const ANALYTICS_SETTING_KEYS = [
  'hrZoneBounds',
  'movingSpeedThresholdMs',
  'minCoverageForEfficiency',
  'elevationHysteresisM',
] as const;

export class InvalidAnalyticsSettingsError extends Error {
  readonly code = 'invalid_analytics_settings';

  constructor() {
    super('invalid_analytics_settings');
    this.name = 'InvalidAnalyticsSettingsError';
  }
}

function failSettings(): never {
  throw new InvalidAnalyticsSettingsError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumberInRange(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return failSettings();
  }
  return value;
}

/**
 * Exact runtime boundary for deterministic analytics settings. Error details
 * are deliberately value-free because stored/request values may be sensitive.
 */
export function parseAnalyticsSettings(value: unknown): AnalyticsSettings {
  if (!isRecord(value)) return failSettings();
  const keys = Object.keys(value);
  if (
    keys.length !== ANALYTICS_SETTING_KEYS.length ||
    keys.some((key) => !ANALYTICS_SETTING_KEYS.includes(key as never))
  ) {
    return failSettings();
  }

  const rawBounds = value['hrZoneBounds'];
  let hrZoneBounds: number[] | null;
  if (rawBounds === null) {
    hrZoneBounds = null;
  } else {
    if (
      !Array.isArray(rawBounds) ||
      rawBounds.length !== 5 ||
      rawBounds.some(
        (bound) =>
          typeof bound !== 'number' ||
          !Number.isFinite(bound) ||
          !Number.isInteger(bound) ||
          bound < 40 ||
          bound > 230,
      ) ||
      rawBounds.some((bound, index) => index > 0 && bound <= rawBounds[index - 1]!)
    ) {
      return failSettings();
    }
    hrZoneBounds = [...rawBounds];
  }

  const minCoverageForEfficiency = finiteNumberInRange(value['minCoverageForEfficiency'], 0, 1);
  if (minCoverageForEfficiency <= 0) return failSettings();

  return {
    hrZoneBounds,
    movingSpeedThresholdMs: finiteNumberInRange(value['movingSpeedThresholdMs'], 0, 30),
    minCoverageForEfficiency,
    elevationHysteresisM: finiteNumberInRange(value['elevationHysteresisM'], 0, 100),
  };
}

export const ZONE_LABELS = [
  'Z1 Recovery',
  'Z2 Endurance',
  'Z3 Tempo',
  'Z4 Threshold',
  'Z5 VO2 Max',
  'Z6 Anaerobic',
];
