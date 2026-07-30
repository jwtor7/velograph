import type { RepairResultBody, WorkoutDetail, WorkoutSummary } from './api.ts';

export interface RideRepairClient {
  repairWorkout: (id: number) => Promise<RepairResultBody>;
  workout: (id: number) => Promise<WorkoutDetail>;
  workouts: () => Promise<{ workouts: WorkoutSummary[] }>;
}

export function findPreviousWorkout(
  workouts: readonly WorkoutSummary[],
  workoutId: number,
): WorkoutSummary | null {
  const sorted = [...workouts].sort(
    (left, right) => left.startUtc - right.startUtc || left.id - right.id,
  );
  const index = sorted.findIndex((workout) => workout.id === workoutId);
  return index > 0 ? sorted[index - 1]! : null;
}

/**
 * Repair first, then reload both canonical detail and library state. Callers
 * can install the returned state in one React batch and reset cursor domains.
 */
export async function repairAndReloadRide(
  client: RideRepairClient,
  workoutId: number,
): Promise<{
  detail: WorkoutDetail;
  previous: WorkoutSummary | null;
  workouts: WorkoutSummary[];
}> {
  await client.repairWorkout(workoutId);
  const [detail, library] = await Promise.all([client.workout(workoutId), client.workouts()]);
  return {
    detail,
    previous: findPreviousWorkout(library.workouts, workoutId),
    workouts: library.workouts,
  };
}
