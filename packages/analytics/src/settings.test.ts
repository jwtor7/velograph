import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANALYTICS_SETTINGS,
  InvalidAnalyticsSettingsError,
  parseAnalyticsSettings,
} from './settings.ts';

const validSettings = {
  ...DEFAULT_ANALYTICS_SETTINGS,
  hrZoneBounds: [90, 110, 130, 150, 170],
};

describe('parseAnalyticsSettings', () => {
  it('returns a validated copy of complete settings', () => {
    const parsed = parseAnalyticsSettings(validSettings);
    expect(parsed).toEqual(validSettings);
    expect(parsed.hrZoneBounds).not.toBe(validSettings.hrZoneBounds);
  });

  it('accepts any finite positive coverage threshold up to one', () => {
    expect(
      parseAnalyticsSettings({
        ...validSettings,
        minCoverageForEfficiency: Number.MIN_VALUE,
      }).minCoverageForEfficiency,
    ).toBe(Number.MIN_VALUE);
  });

  it.each([
    null,
    'settings',
    [],
    { ...validSettings, unexpected: true },
    { ...validSettings, movingSpeedThresholdMs: null },
    { ...validSettings, movingSpeedThresholdMs: '1' },
    { ...validSettings, movingSpeedThresholdMs: Number.NaN },
    { ...validSettings, movingSpeedThresholdMs: Number.POSITIVE_INFINITY },
    { ...validSettings, movingSpeedThresholdMs: -1 },
    { ...validSettings, movingSpeedThresholdMs: 31 },
    { ...validSettings, minCoverageForEfficiency: 0 },
    { ...validSettings, minCoverageForEfficiency: 1.01 },
    { ...validSettings, elevationHysteresisM: -0.1 },
    { ...validSettings, elevationHysteresisM: 101 },
    { ...validSettings, hrZoneBounds: [90, 110, 130, 150] },
    { ...validSettings, hrZoneBounds: [39, 110, 130, 150, 170] },
    { ...validSettings, hrZoneBounds: [90, 110.5, 130, 150, 170] },
    { ...validSettings, hrZoneBounds: [90, 130, 130, 150, 170] },
    { ...validSettings, hrZoneBounds: [90, 140, 130, 150, 170] },
  ])('rejects an invalid value with one value-free error type', (value) => {
    expect(() => parseAnalyticsSettings(value)).toThrow(InvalidAnalyticsSettingsError);
    try {
      parseAnalyticsSettings(value);
    } catch (error) {
      expect(error).toMatchObject({ message: 'invalid_analytics_settings' });
      expect(String(error)).not.toContain(JSON.stringify(value));
    }
  });
});
