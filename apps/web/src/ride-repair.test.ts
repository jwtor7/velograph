import { describe, expect, it, vi } from 'vitest';
import type { RepairResultBody, WorkoutDetail, WorkoutSummary } from './api.ts';
import { findPreviousWorkout, repairAndReloadRide, type RideRepairClient } from './ride-repair.ts';

const summary = (id: number, startUtc: number, endUtc: number): WorkoutSummary => ({
  id,
  type: 'outdoor_cycling',
  startUtc,
  endUtc,
  durationS: (endUtc - startUtc) / 1000,
  qualityState: 'ok',
  distanceM: 1000,
  avgSpeedMs: 5,
  avgHr: 120,
  elevationGainM: 10,
  hasRoute: true,
});

describe('canonical ride repair refresh', () => {
  it('reloads changed bounds, metrics, route, analytics, and previous-ride comparison', async () => {
    const start = Date.UTC(2033, 4, 1, 10);
    const canonical: WorkoutDetail = {
      workout: {
        id: 8,
        type: 'outdoor_cycling',
        startUtc: start + 60_000,
        endUtc: start + 31 * 60_000,
      },
      metrics: {
        heart_rate: [
          { t: start + 60_000, value: 110 },
          { t: start + 31 * 60_000, value: 130 },
        ],
      },
      route: [
        {
          points: [
            { t: start + 60_000, lat: 1, lon: 1 },
            { t: start + 31 * 60_000, lat: 1, lon: 1 },
          ],
        },
      ],
      analytics: {
        formulaVersion: 'analytics-v2',
        workoutId: 8,
        durationS: 1800,
        movingTimeS: 1700,
        distanceM: 9000,
        avgSpeedMs: 5.294,
        maxSpeedMs: 8,
        heartRate: { avg: 120, min: 110, max: 130, coverage: 1 },
        cadence: { avg: null, min: null, max: null, coverage: null },
        energyKj: null,
        elevation: { gainM: 10, lossM: 8, minM: 20, maxM: 30 },
        zones: null,
        efficiency: 0.159,
        decouplingPct: null,
        pacingVariability: null,
        splits: [],
        unavailable: { decoupling: 'insufficient_half_data' },
      },
    };
    const library = [
      summary(9, start + 60 * 60_000, start + 90 * 60_000),
      summary(7, start - 60 * 60_000, start - 30 * 60_000),
      summary(8, canonical.workout.startUtc, canonical.workout.endUtc),
    ];
    const calls: string[] = [];
    const repairResult: RepairResultBody = {
      repaired: true,
      analytics: canonical.analytics!,
    };
    const client: RideRepairClient = {
      repairWorkout: vi.fn(async (id) => {
        calls.push(`repair:${id}`);
        return repairResult;
      }),
      workout: vi.fn(async (id) => {
        calls.push(`detail:${id}`);
        return canonical;
      }),
      workouts: vi.fn(async () => {
        calls.push('library');
        return { workouts: library };
      }),
    };

    const refreshed = await repairAndReloadRide(client, 8);

    expect(calls[0]).toBe('repair:8');
    expect(calls.slice(1).sort()).toEqual(['detail:8', 'library']);
    expect(refreshed.detail).toBe(canonical);
    expect(refreshed.detail.workout).toEqual(canonical.workout);
    expect(refreshed.detail.metrics.heart_rate).toHaveLength(2);
    expect(refreshed.detail.route).toHaveLength(1);
    expect(refreshed.detail.analytics?.formulaVersion).toBe('analytics-v2');
    expect(refreshed.previous?.id).toBe(7);
  });

  it('uses start time and id as deterministic comparison ordering', () => {
    const workouts = [summary(3, 20, 30), summary(2, 10, 20), summary(1, 10, 20)];
    expect(findPreviousWorkout(workouts, 3)?.id).toBe(2);
    expect(findPreviousWorkout(workouts, 1)).toBeNull();
  });
});
