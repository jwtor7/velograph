import { describe, expect, it } from 'vitest';
import {
  AnalyticsSnapshotConflictError,
  loadWorkoutData,
  saveAnalyticsSnapshot,
} from './analytics-input.ts';
import { openDatabase } from './database.ts';
import { Repository } from './repository.ts';

describe('loadWorkoutData route timestamps', () => {
  it('keeps a missing route timestamp explicit instead of substituting epoch zero', () => {
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

    expect(route[0]!.points[0]).toEqual({ t: null, lat: 43.1, lon: -79.1, ele: 100 });
    expect(route[0]!.points[1]!.t).toBe(150);
    db.close();
  });

  it('loads every route and keeps equal-numbered segments from separate files distinct', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const batchId = repo.createBatch('synthetic-test', 1);
    const firstSourceId = repo.insertSourceFile({
      batchId,
      sha256: 'synthetic-route-source-a',
      originalName: 'invented-route-a.gpx',
      detectedType: 'route:gpx',
      parserVersion: 'test-v1',
      status: 'imported',
      sizeBytes: 120,
    });
    const secondSourceId = repo.insertSourceFile({
      batchId,
      sha256: 'synthetic-route-source-b',
      originalName: 'invented-route-b.gpx',
      detectedType: 'route:gpx',
      parserVersion: 'test-v1',
      status: 'imported',
      sizeBytes: 140,
    });
    const workoutId = repo.createWorkout('outdoor_cycling', 1_000, 9_000, 'import');
    repo.insertRoute({
      workoutId,
      sourceFileId: firstSourceId,
      format: 'gpx',
      distanceM: null,
      segments: [
        {
          points: [
            { t: 1_000, lat: -48.41, lon: -123.41 },
            { t: 2_000, lat: -48.42, lon: -123.42 },
          ],
        },
        {
          points: [{ t: null, lat: -48.43, lon: -123.43 }],
        },
      ],
    });
    repo.insertRoute({
      workoutId,
      sourceFileId: secondSourceId,
      format: 'gpx',
      distanceM: null,
      segments: [
        {
          points: [
            { t: 7_000, lat: -48.44, lon: -123.44 },
            { t: 8_000, lat: -48.45, lon: -123.45 },
          ],
        },
      ],
    });

    const route = loadWorkoutData(db, workoutId)!.route;

    expect(route).toHaveLength(3);
    expect(route.map((segment) => segment.points.map((point) => point.lat))).toEqual([
      [-48.41, -48.42],
      [-48.43],
      [-48.44, -48.45],
    ]);
    expect(route[1]!.points[0]!.t).toBeNull();
    db.close();
  });
});

describe('saveAnalyticsSnapshot immutability', () => {
  function setupSnapshotDb() {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const workoutId = repo.createWorkout('outdoor_cycling', 1_000, 9_000, 'synthetic-test');
    return { db, workoutId };
  }

  it('treats a byte-identical replay as an idempotent cache hit', () => {
    const { db, workoutId } = setupSnapshotDb();
    const row = {
      workoutId,
      formulaVersion: 'synthetic-formula-v1',
      settingsHash: 'synthetic-settings-hash',
      inputHash: 'synthetic-input-hash',
      resultJson: '{"distanceM":1234}',
      createdAt: 10_000,
    };

    expect(saveAnalyticsSnapshot(db, row)).toBe('inserted');
    expect(saveAnalyticsSnapshot(db, { ...row, createdAt: 20_000 })).toBe('existing');
    expect(
      db
        .prepare(
          `SELECT result_json, created_at FROM analytics_snapshots
           WHERE workout_id = ?`,
        )
        .get(workoutId),
    ).toEqual({ result_json: row.resultJson, created_at: row.createdAt });
    db.close();
  });

  it('rejects a conflicting replay and preserves the original evidence', () => {
    const { db, workoutId } = setupSnapshotDb();
    const row = {
      workoutId,
      formulaVersion: 'synthetic-formula-v1',
      settingsHash: 'synthetic-settings-hash',
      inputHash: 'synthetic-input-hash',
      resultJson: '{"distanceM":1234}',
      createdAt: 10_000,
    };
    saveAnalyticsSnapshot(db, row);

    expect(() =>
      saveAnalyticsSnapshot(db, {
        ...row,
        resultJson: '{"distanceM":9876}',
        createdAt: 20_000,
      }),
    ).toThrow(AnalyticsSnapshotConflictError);
    expect(
      db
        .prepare(
          `SELECT result_json, created_at FROM analytics_snapshots
           WHERE workout_id = ?`,
        )
        .get(workoutId),
    ).toEqual({ result_json: row.resultJson, created_at: row.createdAt });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM analytics_snapshots WHERE workout_id = ?')
        .get(workoutId),
    ).toEqual({ count: 1 });
    db.close();
  });
});
