import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '@velograph/shared';
import { loadWorkoutData, openDatabase, Repository } from '@velograph/db';
import { runImport } from '@velograph/importers';
import { computeRideAnalytics } from './engine.ts';
import { DEFAULT_ANALYTICS_SETTINGS } from './settings.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'synthetic', 'rides');
const GOLDEN = join(ROOT, 'fixtures', 'synthetic', 'golden', 'analytics-workout-1.json');

const SETTINGS = { ...DEFAULT_ANALYTICS_SETTINGS, hrZoneBounds: [110, 125, 140, 155, 170] };

function computeFirstWorkout(): string {
  const db = openDatabase(':memory:');
  const files = readdirSync(FIXTURES)
    .filter((f) => /\.(csv|gpx)$/.test(f))
    .sort()
    .map((name) => ({ name, data: readFileSync(join(FIXTURES, name)) }));
  runImport(db, files, { now: Date.UTC(2031, 4, 1) });
  const first = new Repository(db).listWorkouts()[0]!;
  const input = loadWorkoutData(db, first.id)!;
  const result = computeRideAnalytics(input, SETTINGS);
  db.close();
  return stableStringify(result);
}

describe('deterministic golden analytics (§9.3, NFR reproducibility)', () => {
  it('repeated full-pipeline runs produce byte-equivalent JSON', () => {
    expect(computeFirstWorkout()).toBe(computeFirstWorkout());
  });

  it('matches the committed golden snapshot byte for byte', () => {
    const golden = readFileSync(GOLDEN, 'utf8').trimEnd();
    expect(computeFirstWorkout()).toBe(golden);
  });
});
