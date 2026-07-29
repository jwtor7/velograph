import type { ParsedFile } from '@velograph/shared';

/**
 * Workout association (IMP-005): type has already constrained the candidate
 * query. This layer combines INTERNAL sample times with a filename timestamp
 * when one is available. Filename evidence is corroborating only and can
 * never create or match a workout on its own.
 */
export const DEFAULT_ASSOCIATION_TOLERANCE_MS = 10 * 60 * 1000;

export interface SampleTimeRange {
  start: number;
  end: number;
}

export interface WorkoutCandidate {
  id: number;
  start_utc: number;
  end_utc: number;
}

export type AssociationResult =
  | { status: 'matched'; workout: WorkoutCandidate }
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'conflict' };

export function sampleTimeRange(file: ParsedFile): SampleTimeRange | null {
  if (file.kind === 'metric') {
    if (file.samples.length === 0) return null;
    return { start: file.samples[0]!.t, end: file.samples[file.samples.length - 1]!.t };
  }
  const times = file.segments
    .flatMap((s) => s.points.map((p) => p.t))
    .filter((t): t is number => t != null);
  if (times.length === 0) return null;
  return { start: Math.min(...times), end: Math.max(...times) };
}

export function associateWorkout(
  candidates: WorkoutCandidate[],
  internal: SampleTimeRange,
  filenameTimestamps: readonly number[],
  toleranceMs: number,
): AssociationResult {
  const corroboratingTimestamps = filenameTimestamps.filter((instant) =>
    instantCorroboratesRange(instant, internal, toleranceMs),
  );
  if (filenameTimestamps.length > 0 && corroboratingTimestamps.length === 0)
    return { status: 'conflict' };
  if (candidates.length === 0) return { status: 'none' };

  const corroborated =
    corroboratingTimestamps.length === 0
      ? candidates
      : candidates.filter((candidate) =>
          corroboratingTimestamps.some((instant) =>
            instantCorroboratesRange(
              instant,
              { start: candidate.start_utc, end: candidate.end_utc },
              toleranceMs,
            ),
          ),
        );

  if (corroborated.length === 0) return { status: 'conflict' };
  if (corroborated.length > 1) return { status: 'ambiguous' };
  return { status: 'matched', workout: corroborated[0]! };
}

function instantCorroboratesRange(
  instant: number,
  range: SampleTimeRange,
  toleranceMs: number,
): boolean {
  return instant >= range.start - toleranceMs && instant <= range.end + toleranceMs;
}
