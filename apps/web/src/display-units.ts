export type DisplayUnits = 'metric' | 'imperial';

const METRES_PER_MILE = 1_609.344;
const FEET_PER_METRE = 3.280_839_895;
const MILES_PER_METRE = 1 / METRES_PER_MILE;
const MILES_PER_HOUR_PER_METRE_PER_SECOND = 2.236_936_292;

export interface FormattedMeasurement {
  value: string;
  unit: string;
}

export function formatDistance(
  metres: number | null | undefined,
  units: DisplayUnits,
): FormattedMeasurement {
  if (metres == null) return { value: '–', unit: units === 'imperial' ? 'mi' : 'km' };
  return units === 'imperial'
    ? { value: (metres * MILES_PER_METRE).toFixed(1), unit: 'mi' }
    : { value: (metres / 1_000).toFixed(1), unit: 'km' };
}

export function formatSpeed(
  metresPerSecond: number | null | undefined,
  units: DisplayUnits,
): FormattedMeasurement {
  if (metresPerSecond == null) {
    return { value: '–', unit: units === 'imperial' ? 'mph' : 'km/h' };
  }
  return units === 'imperial'
    ? {
        value: (metresPerSecond * MILES_PER_HOUR_PER_METRE_PER_SECOND).toFixed(1),
        unit: 'mph',
      }
    : { value: (metresPerSecond * 3.6).toFixed(1), unit: 'km/h' };
}

export function formatElevation(
  metres: number | null | undefined,
  units: DisplayUnits,
): FormattedMeasurement {
  if (metres == null) return { value: '–', unit: units === 'imperial' ? 'ft' : 'm' };
  return units === 'imperial'
    ? { value: String(Math.round(metres * FEET_PER_METRE)), unit: 'ft' }
    : { value: String(Math.round(metres)), unit: 'm' };
}

export function displayDistanceToMetres(value: number, units: DisplayUnits): number {
  return units === 'imperial' ? value * METRES_PER_MILE : value * 1_000;
}

export function distanceChartValue(metres: number, units: DisplayUnits): number {
  return units === 'imperial' ? metres * MILES_PER_METRE : metres / 1_000;
}

export function speedChartValue(metresPerSecond: number, units: DisplayUnits): number {
  return units === 'imperial'
    ? metresPerSecond * MILES_PER_HOUR_PER_METRE_PER_SECOND
    : metresPerSecond * 3.6;
}
