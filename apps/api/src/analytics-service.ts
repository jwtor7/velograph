import type { Database } from '@velograph/db';
import { getAnalyticsSnapshot, loadWorkoutData, saveAnalyticsSnapshot } from '@velograph/db';
import {
  computeRideAnalytics,
  DEFAULT_ANALYTICS_SETTINGS,
  FORMULA_VERSION,
  InvalidAnalyticsSettingsError,
  parseAnalyticsSettings,
  type AnalyticsSettings,
  type RideAnalytics,
} from '@velograph/analytics';
import { isValidTimeZone, sha256Hex, stableStringify, systemTimeZone } from '@velograph/shared';
import { Repository } from '@velograph/db';

export const SETTINGS_KEY = 'analytics';

export interface AppSettings extends AnalyticsSettings {
  /** IANA timezone for offset-less imports and local date/time display. */
  timeZone: string;
}

const APP_SETTING_KEYS = [
  'hrZoneBounds',
  'movingSpeedThresholdMs',
  'minCoverageForEfficiency',
  'elevationHysteresisM',
  'timeZone',
] as const;

export class InvalidAppSettingsError extends Error {
  readonly code = 'invalid_settings';

  constructor() {
    super('invalid_settings');
    this.name = 'InvalidAppSettingsError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failAppSettings(): never {
  throw new InvalidAppSettingsError();
}

/** Exact, value-free runtime parser shared by stored-setting loads and writes. */
export function parseAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return failAppSettings();
  const keys = Object.keys(value);
  if (
    keys.length !== APP_SETTING_KEYS.length ||
    keys.some((key) => !APP_SETTING_KEYS.includes(key as never))
  ) {
    return failAppSettings();
  }
  let analytics: AnalyticsSettings;
  try {
    analytics = parseAnalyticsSettings({
      hrZoneBounds: value['hrZoneBounds'],
      movingSpeedThresholdMs: value['movingSpeedThresholdMs'],
      minCoverageForEfficiency: value['minCoverageForEfficiency'],
      elevationHysteresisM: value['elevationHysteresisM'],
    });
  } catch (error) {
    if (error instanceof InvalidAnalyticsSettingsError) return failAppSettings();
    throw error;
  }
  const timeZone = value['timeZone'];
  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) return failAppSettings();
  return { ...analytics, timeZone };
}

export function mergeAppSettings(current: AppSettings, patch: unknown): AppSettings {
  if (!isRecord(patch)) return failAppSettings();
  if (Object.keys(patch).some((key) => !APP_SETTING_KEYS.includes(key as never))) {
    return failAppSettings();
  }
  return parseAppSettings({ ...current, ...patch });
}

export function loadSettings(db: Database): AppSettings {
  const stored = new Repository(db).getSetting<unknown>(SETTINGS_KEY);
  const defaults = { ...DEFAULT_ANALYTICS_SETTINGS, timeZone: systemTimeZone() };
  if (stored === undefined) return parseAppSettings(defaults);
  if (!isRecord(stored)) return failAppSettings();
  return parseAppSettings({ ...defaults, ...stored });
}

export function saveSettings(db: Database, settings: unknown): AppSettings {
  const parsed = parseAppSettings(settings);
  new Repository(db).setSetting(SETTINGS_KEY, parsed);
  return parsed;
}

/**
 * Snapshot-cached deterministic analytics (ANA-009/ANA-010): recompute only
 * when input, settings, or formula version changes; otherwise return the
 * stored byte-identical result.
 */
export function getOrComputeAnalytics(
  db: Database,
  workoutId: number,
  now: number,
): RideAnalytics | null {
  const input = loadWorkoutData(db, workoutId);
  if (!input) return null;
  const settings = loadSettings(db);
  const settingsHash = sha256Hex(stableStringify(settings));
  const inputHash = sha256Hex(stableStringify(input));
  const cached = getAnalyticsSnapshot(db, workoutId, FORMULA_VERSION, settingsHash, inputHash);
  if (cached) return JSON.parse(cached) as RideAnalytics;
  const result = computeRideAnalytics(input, settings);
  saveAnalyticsSnapshot(db, {
    workoutId,
    formulaVersion: FORMULA_VERSION,
    settingsHash,
    inputHash,
    resultJson: stableStringify(result),
    createdAt: now,
  });
  return result;
}

/**
 * Repair a workout (issue #38): re-derive its span from the normalized data
 * it already owns (metric_series/route_points — re-running full association
 * from raw source bytes isn't possible once a file is hash-only, PRD IMP
 * retention default), and force a fresh snapshot under the current formula
 * version. Prior formula snapshots remain immutable provenance records.
 * Returns null when the workout does not exist.
 */
export function repairWorkout(db: Database, workoutId: number, now: number): RideAnalytics | null {
  const repo = new Repository(db);
  return repo.transaction(() => {
    if (!repo.getWorkout(workoutId)) return null;
    repo.recomputeWorkoutSpan(workoutId);

    const input = loadWorkoutData(db, workoutId);
    if (!input) return null;
    const settings = loadSettings(db);
    const settingsHash = sha256Hex(stableStringify(settings));
    const inputHash = sha256Hex(stableStringify(input));
    const result = computeRideAnalytics(input, settings);
    saveAnalyticsSnapshot(db, {
      workoutId,
      formulaVersion: FORMULA_VERSION,
      settingsHash,
      inputHash,
      resultJson: stableStringify(result),
      createdAt: now,
    });
    return result;
  });
}
