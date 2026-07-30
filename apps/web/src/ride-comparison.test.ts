import { describe, expect, it } from 'vitest';
import type { WorkoutSummary } from './api.ts';
import { priorWorkouts, selectRideComparison } from './ride-comparison.ts';

function ride(
  id: number,
  startUtc: number,
  distanceM: number | null,
  avgSpeedMs: number | null,
  avgHr: number | null,
  qualityState = 'ok',
): WorkoutSummary {
  return {
    id,
    type: 'outdoor_cycling',
    startUtc,
    endUtc: startUtc + 1_000,
    durationS: 1,
    qualityState,
    distanceM,
    avgSpeedMs,
    avgHr,
    elevationGainM: null,
    hasRoute: false,
  };
}

describe('ride comparisons', () => {
  const workouts = [
    ride(4, 4_000, 14_000, 7, 140),
    ride(2, 2_000, null, 5, 120, 'partial'),
    ride(1, 1_000, 8_000, 4, 110),
    ride(3, 3_000, 12_000, 6, 130),
  ];

  it('orders prior rides deterministically and defaults to the immediate previous ride', () => {
    expect(priorWorkouts(workouts, 4).map((candidate) => candidate.id)).toEqual([1, 2, 3]);
    expect(selectRideComparison(workouts, 4, 'previous')?.ride?.id).toBe(3);
  });

  it('supports an explicit user-selected ride', () => {
    const selected = selectRideComparison(workouts, 4, 'ride:1');
    expect(selected?.kind).toBe('ride');
    expect(selected?.ride?.id).toBe(1);
    expect(selected?.distanceM).toBe(8_000);
  });

  it('uses recent prior rides and ignores unavailable values per metric', () => {
    const comparison = selectRideComparison(workouts, 4, 'recent_median');
    expect(comparison).toMatchObject({
      kind: 'recent_median',
      distanceM: 10_000,
      avgSpeedMs: 5,
      avgHr: 120,
      windowSize: 3,
      sampleSizes: { distanceM: 2, avgSpeedMs: 3, avgHr: 3 },
      qualityStates: ['ok', 'partial'],
    });
  });

  it('falls back to previous when a selected ride no longer exists', () => {
    expect(selectRideComparison(workouts, 4, 'ride:99')?.ride?.id).toBe(3);
  });
});
