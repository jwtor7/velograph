import type { WorkoutSummary } from './api.ts';

export type RideComparisonChoice = 'previous' | 'recent_median' | `ride:${number}`;

export interface RideComparison {
  kind: 'ride' | 'recent_median';
  distanceM: number | null;
  avgSpeedMs: number | null;
  avgHr: number | null;
  windowSize: number;
  sampleSizes: {
    distanceM: number;
    avgSpeedMs: number;
    avgHr: number;
  };
  ride: WorkoutSummary | null;
  qualityStates: string[];
}

function sampleSizes(workouts: readonly WorkoutSummary[]): RideComparison['sampleSizes'] {
  return {
    distanceM: workouts.filter((ride) => ride.distanceM !== null).length,
    avgSpeedMs: workouts.filter((ride) => ride.avgSpeedMs !== null).length,
    avgHr: workouts.filter((ride) => ride.avgHr !== null).length,
  };
}

function median(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (available.length === 0) return null;
  const middle = Math.floor(available.length / 2);
  return available.length % 2 === 0
    ? (available[middle - 1]! + available[middle]!) / 2
    : available[middle]!;
}

function chronological(workouts: readonly WorkoutSummary[]): WorkoutSummary[] {
  return [...workouts].sort((left, right) => left.startUtc - right.startUtc || left.id - right.id);
}

export function priorWorkouts(
  workouts: readonly WorkoutSummary[],
  workoutId: number,
): WorkoutSummary[] {
  const sorted = chronological(workouts);
  const currentIndex = sorted.findIndex((workout) => workout.id === workoutId);
  return currentIndex <= 0 ? [] : sorted.slice(0, currentIndex);
}

export function selectRideComparison(
  workouts: readonly WorkoutSummary[],
  workoutId: number,
  choice: RideComparisonChoice,
): RideComparison | null {
  if (choice.startsWith('ride:')) {
    const selectedId = Number(choice.slice('ride:'.length));
    const ride = workouts.find(
      (candidate) => candidate.id === selectedId && candidate.id !== workoutId,
    );
    if (ride) {
      return {
        kind: 'ride',
        distanceM: ride.distanceM,
        avgSpeedMs: ride.avgSpeedMs,
        avgHr: ride.avgHr,
        windowSize: 1,
        sampleSizes: sampleSizes([ride]),
        ride,
        qualityStates: [ride.qualityState],
      };
    }
  }

  const prior = priorWorkouts(workouts, workoutId);
  if (prior.length === 0) return null;

  if (choice === 'recent_median') {
    const recent = prior.slice(-5);
    return {
      kind: 'recent_median',
      distanceM: median(recent.map((ride) => ride.distanceM)),
      avgSpeedMs: median(recent.map((ride) => ride.avgSpeedMs)),
      avgHr: median(recent.map((ride) => ride.avgHr)),
      windowSize: recent.length,
      sampleSizes: sampleSizes(recent),
      ride: null,
      qualityStates: [...new Set(recent.map((ride) => ride.qualityState))].sort(),
    };
  }

  const ride = prior[prior.length - 1]!;
  return {
    kind: 'ride',
    distanceM: ride.distanceM,
    avgSpeedMs: ride.avgSpeedMs,
    avgHr: ride.avgHr,
    windowSize: 1,
    sampleSizes: sampleSizes([ride]),
    ride,
    qualityStates: [ride.qualityState],
  };
}
