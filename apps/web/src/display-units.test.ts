import { describe, expect, it } from 'vitest';
import {
  displayDistanceToMetres,
  distanceChartValue,
  formatDistance,
  formatElevation,
  formatSpeed,
  speedChartValue,
} from './display-units.ts';

describe('display unit conversion', () => {
  it('keeps metric presentation compatible with canonical SI storage', () => {
    expect(formatDistance(10_000, 'metric')).toEqual({ value: '10.0', unit: 'km' });
    expect(formatSpeed(5, 'metric')).toEqual({ value: '18.0', unit: 'km/h' });
    expect(formatElevation(100, 'metric')).toEqual({ value: '100', unit: 'm' });
    expect(displayDistanceToMetres(10, 'metric')).toBe(10_000);
    expect(distanceChartValue(10_000, 'metric')).toBe(10);
    expect(speedChartValue(5, 'metric')).toBe(18);
  });

  it('converts only at the imperial display boundary', () => {
    expect(formatDistance(1_609.344, 'imperial')).toEqual({ value: '1.0', unit: 'mi' });
    expect(formatSpeed(10, 'imperial')).toEqual({ value: '22.4', unit: 'mph' });
    expect(formatElevation(304.8, 'imperial')).toEqual({ value: '1000', unit: 'ft' });
    expect(displayDistanceToMetres(1, 'imperial')).toBeCloseTo(1_609.344);
    expect(distanceChartValue(1_609.344, 'imperial')).toBeCloseTo(1);
    expect(speedChartValue(10, 'imperial')).toBeCloseTo(22.369_362_92);
  });

  it('preserves missing values without inventing measurements', () => {
    expect(formatDistance(null, 'imperial')).toEqual({ value: '–', unit: 'mi' });
    expect(formatSpeed(undefined, 'metric')).toEqual({ value: '–', unit: 'km/h' });
    expect(formatElevation(null, 'imperial')).toEqual({ value: '–', unit: 'ft' });
  });
});
