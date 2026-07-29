import { describe, expect, it } from 'vitest';
import { loadWorkoutData } from './analytics-input.ts';
import { openDatabase } from './database.ts';
import { Repository } from './repository.ts';

describe('loadWorkoutData route timestamps', () => {
  it('keeps a missing route timestamp absent instead of substituting epoch zero', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const batchId = repo.createBatch('synthetic-test', 1);
    const sourceFileId = repo.insertSourceFile({
      batchId,
      sha256: 'synthetic-missing-route-time',
      originalName: 'synthetic-route.gpx',
      detectedType: 'route:gpx',
      parserVersion: 'test-v1',
      status: 'imported',
      sizeBytes: 100,
    });
    const workoutId = repo.createWorkout('outdoor_cycling', 100, 200, 'import');
    repo.insertRoute({
      workoutId,
      sourceFileId,
      format: 'gpx',
      distanceM: null,
      segments: [
        {
          points: [
            { lat: 43.1, lon: -79.1, ele: 100 },
            { t: 150, lat: 43.2, lon: -79.2, ele: 101 },
          ],
        },
      ],
    });

    const route = loadWorkoutData(db, workoutId)!.route;

    expect(route[0]!.points[0]).toEqual({ lat: 43.1, lon: -79.1, ele: 100 });
    expect(route[0]!.points[0]).not.toHaveProperty('t');
    expect(route[0]!.points[1]!.t).toBe(150);
    db.close();
  });
});
