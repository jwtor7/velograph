import { describe, expect, it } from 'vitest';
import type { ParsedFile } from '@velograph/shared';
import { associateWorkout, sampleTimeRange, type WorkoutCandidate } from './association.ts';

const minute = 60_000;
const range = { start: 100 * minute, end: 140 * minute };

const candidate = (id: number, start: number, end: number): WorkoutCandidate => ({
  id,
  start_utc: start * minute,
  end_utc: end * minute,
});

describe('corroborated workout association (IMP-005)', () => {
  it('matches when internal and filename evidence identify one candidate', () => {
    expect(associateWorkout([candidate(7, 100, 140)], range, [100 * minute], 10 * minute)).toEqual({
      status: 'matched',
      workout: candidate(7, 100, 140),
    });
  });

  it('returns none only when the two file signals agree and no workout exists', () => {
    expect(associateWorkout([], range, [101 * minute], 10 * minute)).toEqual({ status: 'none' });
  });

  it('rejects a filename timestamp that conflicts with internal samples', () => {
    expect(associateWorkout([], range, [10 * minute], 10 * minute)).toEqual({
      status: 'conflict',
    });
  });

  it('uses filename evidence to disambiguate internal-time candidates', () => {
    const first = candidate(1, 90, 115);
    const second = candidate(2, 125, 150);
    expect(associateWorkout([first, second], range, [140 * minute], 10 * minute)).toEqual({
      status: 'matched',
      workout: second,
    });
  });

  it('reports ambiguity instead of selecting the earliest candidate', () => {
    const first = candidate(1, 95, 145);
    const second = candidate(2, 96, 144);
    expect(associateWorkout([first, second], range, [100 * minute], 10 * minute)).toEqual({
      status: 'ambiguous',
    });
  });

  it('accepts one corroborated interpretation when filename timezone is uncertain', () => {
    expect(
      associateWorkout([candidate(7, 100, 140)], range, [100 * minute, 340 * minute], 10 * minute),
    ).toEqual({
      status: 'matched',
      workout: candidate(7, 100, 140),
    });
  });

  it('derives a range from hundreds of thousands of route points without argument spreading', () => {
    const points = Array.from({ length: 200_000 }, (_, index) => ({
      t: index === 0 ? null : 10_000_000 + index,
      lat: -48 + index / 10_000_000,
      lon: -123 - index / 10_000_000,
    }));
    const file: ParsedFile = {
      kind: 'route',
      format: 'gpx',
      workoutType: 'outdoor_cycling',
      segments: [{ points }],
    };

    expect(sampleTimeRange(file)).toEqual({
      start: 10_000_001,
      end: 10_199_999,
    });
  });
});
