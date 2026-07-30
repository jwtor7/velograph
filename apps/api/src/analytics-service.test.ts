import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYTICS_SETTINGS, FORMULA_VERSION } from '@velograph/analytics';
import { loadWorkoutData, openDatabase, Repository, saveAnalyticsSnapshot } from '@velograph/db';
import { sha256Hex, stableStringify } from '@velograph/shared';
import {
  getOrComputeAnalytics,
  InvalidAppSettingsError,
  loadSettings,
  mergeAppSettings,
  parseAppSettings,
  repairWorkout,
  saveSettings,
  SETTINGS_KEY,
} from './analytics-service.ts';

const validSettings = {
  ...DEFAULT_ANALYTICS_SETTINGS,
  hrZoneBounds: [90, 110, 130, 150, 170],
  timeZone: 'Etc/UTC',
  displayUnits: 'metric' as const,
};

describe('analytics settings storage boundary', () => {
  it('parses a complete exact app setting object', () => {
    expect(parseAppSettings(validSettings)).toEqual(validSettings);
  });

  it.each([
    null,
    'settings',
    { ...validSettings, unexpected: true },
    { ...validSettings, timeZone: '' },
    { ...validSettings, timeZone: 'Not/A_Zone' },
    { ...validSettings, displayUnits: 'nautical' },
    { ...validSettings, hrZoneBounds: [90, 130, 130, 150, 170] },
  ])('rejects invalid complete settings with a value-free code', (value) => {
    expect(() => parseAppSettings(value)).toThrow(InvalidAppSettingsError);
  });

  it('merges only documented patch keys and validates the complete result', () => {
    expect(
      mergeAppSettings(validSettings, {
        hrZoneBounds: null,
        movingSpeedThresholdMs: 2,
      }),
    ).toEqual({
      ...validSettings,
      hrZoneBounds: null,
      movingSpeedThresholdMs: 2,
    });
    expect(() => mergeAppSettings(validSettings, { unexpected: true })).toThrow(
      InvalidAppSettingsError,
    );
    expect(mergeAppSettings(validSettings, { displayUnits: 'imperial' }).displayUnits).toBe(
      'imperial',
    );
  });

  it('never mutates storage when a replacement is invalid', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    saveSettings(db, validSettings);

    expect(() =>
      saveSettings(db, {
        ...validSettings,
        minCoverageForEfficiency: 'disabled',
      }),
    ).toThrow(InvalidAppSettingsError);
    expect(repo.getSetting(SETTINGS_KEY)).toEqual(validSettings);
    db.close();
  });

  it('fails closed when persisted settings are corrupt', () => {
    const db = openDatabase(':memory:');
    new Repository(db).setSetting(SETTINGS_KEY, {
      ...validSettings,
      elevationHysteresisM: Number.POSITIVE_INFINITY,
    });
    expect(() => loadSettings(db)).toThrow(InvalidAppSettingsError);
    db.close();
  });

  it('computes analytics-v2 separately without overwriting an analytics-v1 snapshot', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const workoutId = repo.createWorkout(
      'outdoor_cycling',
      Date.UTC(2032, 1, 2, 10),
      Date.UTC(2032, 1, 2, 11),
      'synthetic-test',
    );
    const input = loadWorkoutData(db, workoutId)!;
    const settings = loadSettings(db);
    const settingsHash = sha256Hex(stableStringify(settings));
    const inputHash = sha256Hex(stableStringify(input));
    saveAnalyticsSnapshot(db, {
      workoutId,
      formulaVersion: 'analytics-v1',
      settingsHash,
      inputHash,
      resultJson: '{"formulaVersion":"analytics-v1","synthetic":"preserved"}',
      createdAt: 1,
    });

    const result = getOrComputeAnalytics(db, workoutId, 2)!;
    expect(FORMULA_VERSION).toBe('analytics-v2');
    expect(result.formulaVersion).toBe('analytics-v2');
    const snapshots = db
      .prepare(
        `SELECT formula_version, result_json, created_at
         FROM analytics_snapshots WHERE workout_id = ? ORDER BY formula_version`,
      )
      .all(workoutId) as {
      formula_version: string;
      result_json: string;
      created_at: number;
    }[];
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual({
      formula_version: 'analytics-v1',
      result_json: '{"formulaVersion":"analytics-v1","synthetic":"preserved"}',
      created_at: 1,
    });
    expect(snapshots[1]!.formula_version).toBe('analytics-v2');
    expect(repairWorkout(db, workoutId, 3)?.formulaVersion).toBe('analytics-v2');
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM analytics_snapshots WHERE workout_id = ?')
        .get(workoutId),
    ).toEqual({ count: 2 });
    db.close();
  });
});
