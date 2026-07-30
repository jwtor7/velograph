import type { TrendsResponse } from './api.ts';
import { speedChartValue, type DisplayUnits } from './display-units.ts';

export type RideTrendMetric = 'avgHr' | 'avgSpeedKmh' | 'efficiency';

export interface NullableBarItem {
  label: string;
  value: number | null;
}

/**
 * Preserve analytics unavailability through the chart boundary. `null` is a
 * gap; numeric zero remains a recorded value.
 */
export function buildRideTrendItems(
  rides: TrendsResponse['rides'],
  metric: RideTrendMetric,
  displayUnits: DisplayUnits = 'metric',
): NullableBarItem[] {
  return rides.map((ride) => {
    let value: number | null;
    if (metric === 'avgHr') {
      value = ride.avgHr;
    } else if (metric === 'avgSpeedKmh') {
      value = ride.avgSpeedMs == null ? null : speedChartValue(ride.avgSpeedMs, displayUnits);
    } else {
      value = ride.efficiency;
    }
    return {
      label: new Date(ride.startUtc).toISOString().slice(5, 10),
      value,
    };
  });
}

export function unavailableItemCount(items: readonly NullableBarItem[]): number {
  return items.reduce((count, item) => count + (item.value == null ? 1 : 0), 0);
}
