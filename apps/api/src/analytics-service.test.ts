import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYTICS_SETTINGS } from '@velograph/analytics';
import { openDatabase, Repository } from '@velograph/db';
import {
  InvalidAppSettingsError,
  loadSettings,
  mergeAppSettings,
  parseAppSettings,
  saveSettings,
  SETTINGS_KEY,
} from './analytics-service.ts';

const validSettings = {
  ...DEFAULT_ANALYTICS_SETTINGS,
  hrZoneBounds: [90, 110, 130, 150, 170],
  timeZone: 'Etc/UTC',
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
});
