import { describe, expect, it } from 'vitest';
import type { TrendsResponse } from './api.ts';
import { buildRideTrendItems, unavailableItemCount, type RideTrendMetric } from './trends-model.ts';

const rides: TrendsResponse['rides'] = [
  {
    id: 1,
    startUtc: Date.UTC(2032, 2, 1),
    durationS: 1200,
    distanceM: 0,
    avgHr: 0,
    avgSpeedMs: 0,
    efficiency: 0,
    zones: null,
    elevationGainM: null,
  },
  {
    id: 2,
    startUtc: Date.UTC(2032, 2, 2),
    durationS: 1800,
    distanceM: null,
    avgHr: null,
    avgSpeedMs: null,
    efficiency: null,
    zones: null,
    elevationGainM: null,
  },
  {
    id: 3,
    startUtc: Date.UTC(2032, 2, 3),
    durationS: 2400,
    distanceM: 12_000,
    avgHr: 140,
    avgSpeedMs: 5,
    efficiency: 0.13,
    zones: null,
    elevationGainM: null,
  },
];

describe('nullable ride trend model', () => {
  it.each([
    ['avgHr', [0, null, 140]],
    ['avgSpeedKmh', [0, null, 18]],
    ['efficiency', [0, null, 0.13]],
  ] satisfies [RideTrendMetric, (number | null)[]][])(
    'preserves real zero and unavailable gaps for %s',
    (metric, expected) => {
      const items = buildRideTrendItems(rides, metric);
      expect(items.map((item) => item.value)).toEqual(expected);
      expect(unavailableItemCount(items)).toBe(1);
    },
  );

  it('converts speed trends at the imperial display boundary', () => {
    const items = buildRideTrendItems(rides, 'avgSpeedKmh', 'imperial');
    expect(items.map((item) => item.value)).toEqual([0, null, expect.closeTo(11.18468146)]);
  });
});
