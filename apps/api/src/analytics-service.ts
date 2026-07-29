import type { Database } from '@velograph/db';
import { getAnalyticsSnapshot, loadWorkoutData, saveAnalyticsSnapshot } from '@velograph/db';
import {
  computeRideAnalytics,
  DEFAULT_ANALYTICS_SETTINGS,
  FORMULA_VERSION,
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

export function loadSettings(db: Database): AppSettings {
  const stored = new Repository(db).getSetting<Partial<AppSettings>>(SETTINGS_KEY);
  const requestedZone = stored?.timeZone;
  const timeZone =
    typeof requestedZone === 'string' && isValidTimeZone(requestedZone)
      ? requestedZone
      : systemTimeZone();
  return { ...DEFAULT_ANALYTICS_SETTINGS, ...(stored ?? {}), timeZone };
}

export function saveSettings(db: Database, settings: AppSettings): void {
  if (!isValidTimeZone(settings.timeZone)) throw new Error('invalid_time_zone');
  new Repository(db).setSetting(SETTINGS_KEY, settings);
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
 * retention default), drop analytics snapshots left over from a previous
 * `FORMULA_VERSION`, and force a fresh snapshot under the current formula
 * version. Returns null when the workout does not exist.
 */
export function repairWorkout(db: Database, workoutId: number, now: number): RideAnalytics | null {
  const repo = new Repository(db);
  return repo.transaction(() => {
    if (!repo.getWorkout(workoutId)) return null;
    repo.recomputeWorkoutSpan(workoutId);
    repo.deleteStaleAnalyticsSnapshots(workoutId, FORMULA_VERSION);

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
