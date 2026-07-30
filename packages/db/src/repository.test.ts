import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.ts';
import { Repository } from './repository.ts';

const APPLICATION_DATA_TABLES = [
  'analytics_snapshots',
  'backup_manifests',
  'import_batches',
  'insight_runs',
  'metric_samples',
  'metric_series',
  'notes_tags',
  'route_points',
  'routes',
  'source_file_reprocessing_failures',
  'source_files',
  'user_settings',
  'workout_source_files',
  'workouts',
] as const;

/**
 * Delete tests use the repository directly (rather than runImport) so a
 * source file "shared" across two workouts can be constructed deliberately:
 * the schema permits metric_series/routes rows from different workouts to
 * reference the same source_files row, and delete must respect that even
 * though the current importer always gives each imported file its own row.
 */
function seedWorkoutWithFile(
  repo: Repository,
  opts: { start: number; end: number; sourceFileId?: number },
): { workoutId: number; sourceFileId: number } {
  const db = repo.db;
  const batchId = repo.createBatch('test-importer', opts.start);
  const sourceFileId =
    opts.sourceFileId ??
    repo.insertSourceFile({
      batchId,
      sha256: `hash-${opts.start}-${Math.random()}`,
      originalName: 'ride.csv',
      detectedType: 'metric:heart_rate',
      parserVersion: 'test-v1',
      status: 'imported',
      sizeBytes: 100,
    });
  const workoutId = repo.createWorkout('outdoor_cycling', opts.start, opts.end, 'import');
  repo.linkSourceFileToWorkout(workoutId, sourceFileId);
  repo.insertMetricSeries({
    workoutId,
    sourceFileId,
    metric: 'heart_rate',
    unit: 'bpm',
    source: null,
    samples: [
      { t: opts.start, value: 120 },
      { t: opts.end, value: 130 },
    ],
  });
  db.prepare(
    `INSERT INTO analytics_snapshots
       (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
     VALUES (?, 'workout', 'analytics-v1', 'h', 'h', '{}', ?)`,
  ).run(workoutId, opts.start);
  return { workoutId, sourceFileId };
}

function seedAllApplicationState(repo: Repository): void {
  const createdAt = Date.UTC(2032, 2, 4, 5, 6, 7);
  const batchId = repo.createBatch('synthetic-delete-all-v1', createdAt);
  const sourceFileId = repo.insertSourceFile({
    batchId,
    sha256: 'synthetic-delete-all-hash',
    originalName: 'synthetic-ride.csv',
    detectedType: 'metric:heart_rate',
    parserVersion: 'synthetic-v1',
    status: 'imported',
    sizeBytes: 10,
  });
  const workoutId = repo.createWorkout(
    'outdoor_cycling',
    createdAt,
    createdAt + 60_000,
    'synthetic-delete-all',
  );
  repo.linkSourceFileToWorkout(workoutId, sourceFileId);
  repo.insertMetricSeries({
    workoutId,
    sourceFileId,
    metric: 'heart_rate',
    unit: 'bpm',
    source: null,
    samples: [
      { t: createdAt, value: 100 },
      { t: createdAt + 60_000, value: 110 },
    ],
  });
  repo.insertRoute({
    workoutId,
    sourceFileId,
    format: 'gpx',
    distanceM: 100,
    segments: [
      {
        points: [
          { t: createdAt, lat: -48.5, lon: -123.5 },
          { t: createdAt + 60_000, lat: -48.51, lon: -123.51 },
        ],
      },
    ],
  });
  repo.recordSourceFileReprocessingFailure({
    sourceFileId,
    batchId,
    attemptedParserVersion: 'synthetic-v2',
    errorCode: 'io_error',
    createdAt: createdAt + 1,
  });
  repo.setSetting('analytics', { timeZone: 'Etc/UTC' });

  repo.db
    .prepare(
      `INSERT INTO analytics_snapshots
         (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
       VALUES (?, 'workout', 'synthetic-v1', 'settings-hash', 'input-hash', '{}', ?)`,
    )
    .run(workoutId, createdAt);
  repo.db
    .prepare(
      `INSERT INTO analytics_snapshots
         (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
       VALUES (NULL, 'global', 'synthetic-v1', 'global-settings', 'global-input', '{}', ?)`,
    )
    .run(createdAt);
  repo.db
    .prepare(
      `INSERT INTO insight_runs
         (workout_id, provider, model_id, prompt_version, schema_version, input_hash,
          payload_json, output_json, validation_status, created_at)
       VALUES (?, 'disabled', NULL, 'synthetic-v1', 'synthetic-v1', 'input-hash',
               '{}', NULL, 'not_run', ?)`,
    )
    .run(workoutId, createdAt);
  repo.db
    .prepare(
      `INSERT INTO insight_runs
         (workout_id, provider, model_id, prompt_version, schema_version, input_hash,
          payload_json, output_json, validation_status, created_at)
       VALUES (NULL, 'disabled', NULL, 'synthetic-v1', 'synthetic-v1', 'global-input',
               '{}', NULL, 'not_run', ?)`,
    )
    .run(createdAt);
  repo.db
    .prepare(
      `INSERT INTO notes_tags
         (workout_id, kind, content, ai_inclusion, created_at)
       VALUES (?, 'tag', 'synthetic-tag', 0, ?)`,
    )
    .run(workoutId, createdAt);
  repo.db
    .prepare(
      `INSERT INTO backup_manifests
         (id, format_version, app_version, schema_version, created_at,
          included_categories_json, checksums_json, manifest_checksum)
       VALUES (1, 1, 'synthetic-app', 'synthetic-schema', ?, '{}', '{}', 'synthetic-checksum')`,
    )
    .run(createdAt);
}

function applicationRowCounts(repo: Repository): Record<string, number> {
  return Object.fromEntries(
    APPLICATION_DATA_TABLES.map((table) => [
      table,
      (
        repo.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
    ]),
  );
}

describe('Repository.insertRoute', () => {
  it('stores reducer-computed bounds and point count', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const { workoutId, sourceFileId } = seedWorkoutWithFile(repo, { start: 1, end: 2 });

    const routeId = repo.insertRoute({
      workoutId,
      sourceFileId,
      format: 'gpx',
      distanceM: null,
      segments: [
        {
          points: [
            { t: null, lat: 43.1, lon: -79.9 },
            { t: null, lat: 42.8, lon: -79.2 },
          ],
        },
        { points: [{ t: null, lat: 43.4, lon: -80.1 }] },
      ],
    });
    const row = db
      .prepare('SELECT point_count, bounds_json FROM routes WHERE id = ?')
      .get(routeId) as { point_count: number; bounds_json: string };

    expect(row.point_count).toBe(3);
    expect(JSON.parse(row.bounds_json)).toEqual({
      latMin: 42.8,
      latMax: 43.4,
      lonMin: -80.1,
      lonMax: -79.2,
    });
    db.close();
  });
});

describe('Repository.findCandidateWorkouts', () => {
  it('returns every overlapping candidate in deterministic order', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const later = repo.createWorkout('outdoor_cycling', 110, 200, 'test');
    const earlier = repo.createWorkout('outdoor_cycling', 100, 190, 'test');
    repo.createWorkout('indoor_cycling', 100, 190, 'test');

    expect(repo.findCandidateWorkouts('outdoor_cycling', 120, 180, 0).map((w) => w.id)).toEqual([
      earlier,
      later,
    ]);
    db.close();
  });
});

describe('Repository.deleteWorkout', () => {
  it('removes the workout and every dependent row, and forgets an exclusive source file hash', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const { workoutId, sourceFileId } = seedWorkoutWithFile(repo, {
      start: Date.UTC(2031, 0, 1),
      end: Date.UTC(2031, 0, 1, 1),
    });

    const result = repo.deleteWorkout(workoutId);

    expect(result).toEqual({ removedSourceFileIds: [sourceFileId] });
    expect(repo.getWorkout(workoutId)).toBeUndefined();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM metric_series WHERE workout_id = ?').get(workoutId),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM analytics_snapshots WHERE workout_id = ?')
        .get(workoutId),
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT * FROM source_files WHERE id = ?').get(sourceFileId)).toBeUndefined();
    db.close();
  });

  it('leaves a source file that is still referenced by another workout untouched', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const first = seedWorkoutWithFile(repo, {
      start: Date.UTC(2031, 0, 1),
      end: Date.UTC(2031, 0, 1, 1),
    });
    // Deliberately share the same source_files row across a second workout —
    // exercises the "must not delete a source file referenced by another
    // workout" guarantee even though normal import never produces this.
    const second = seedWorkoutWithFile(repo, {
      start: Date.UTC(2031, 0, 5),
      end: Date.UTC(2031, 0, 5, 1),
      sourceFileId: first.sourceFileId,
    });

    const result = repo.deleteWorkout(first.workoutId);

    expect(result).toEqual({ removedSourceFileIds: [] });
    expect(repo.getWorkout(first.workoutId)).toBeUndefined();
    expect(repo.getWorkout(second.workoutId)).toBeDefined();
    expect(
      db.prepare('SELECT * FROM source_files WHERE id = ?').get(first.sourceFileId),
    ).toBeDefined();
    // second workout's data survives fully
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM metric_series WHERE workout_id = ?')
        .get(second.workoutId),
    ).toEqual({ n: 1 });
    db.close();
  });

  it('keeps a source linked to another workout even without an active normalized row', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const first = seedWorkoutWithFile(repo, {
      start: Date.UTC(2031, 0, 1),
      end: Date.UTC(2031, 0, 1, 1),
    });
    const secondWorkoutId = repo.createWorkout(
      'outdoor_cycling',
      Date.UTC(2031, 0, 5),
      Date.UTC(2031, 0, 5, 1),
      'synthetic-provenance-only',
    );
    repo.linkSourceFileToWorkout(secondWorkoutId, first.sourceFileId);

    const result = repo.deleteWorkout(first.workoutId);

    expect(result).toEqual({ removedSourceFileIds: [] });
    expect(repo.getWorkout(first.workoutId)).toBeUndefined();
    expect(repo.getWorkout(secondWorkoutId)).toBeDefined();
    expect(repo.workoutIdsForSourceFile(first.sourceFileId)).toEqual([secondWorkoutId]);
    expect(
      db.prepare('SELECT * FROM source_files WHERE id = ?').get(first.sourceFileId),
    ).toBeDefined();
    db.close();
  });

  it('returns null for an unknown workout id and changes nothing', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const { workoutId } = seedWorkoutWithFile(repo, {
      start: Date.UTC(2031, 0, 1),
      end: Date.UTC(2031, 0, 1, 1),
    });
    expect(repo.deleteWorkout(999999)).toBeNull();
    expect(repo.getWorkout(workoutId)).toBeDefined();
    db.close();
  });

  it('a deleted file re-imports cleanly instead of being skipped as a duplicate', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const hash = 'reimport-hash';
    const batchId = repo.createBatch('test-importer', 1);
    const sourceFileId = repo.insertSourceFile({
      batchId,
      sha256: hash,
      originalName: 'ride.csv',
      detectedType: 'metric:heart_rate',
      parserVersion: 'test-v1',
      status: 'imported',
      sizeBytes: 100,
    });
    const workoutId = repo.createWorkout('outdoor_cycling', 1, 2, 'import');
    repo.insertMetricSeries({
      workoutId,
      sourceFileId,
      metric: 'heart_rate',
      unit: 'bpm',
      source: null,
      samples: [{ t: 1, value: 100 }],
    });

    expect(repo.findSourceFileByHash(hash)).toBeDefined();
    repo.deleteWorkout(workoutId);
    // The hash is forgotten: a subsequent import of the identical bytes must
    // not be treated as a duplicate (IMP-003 idempotency must not become a
    // data-loss trap after delete).
    expect(repo.findSourceFileByHash(hash)).toBeUndefined();
    db.close();
  });
});

describe('Repository.deleteAllData', () => {
  it('atomically clears every application table and preserves schema migrations', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    seedAllApplicationState(repo);

    const discoveredApplicationTables = (
      db
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%'
             AND name <> 'schema_migrations'
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(discoveredApplicationTables).toEqual([...APPLICATION_DATA_TABLES].sort());
    expect(Object.values(applicationRowCounts(repo)).every((count) => count > 0)).toBe(true);

    const migrationsBefore = db
      .prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid')
      .all();
    const schemaBefore = db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all();

    repo.deleteAllData();

    expect(applicationRowCounts(repo)).toEqual(
      Object.fromEntries(APPLICATION_DATA_TABLES.map((table) => [table, 0])),
    );
    expect(repo.getSetting('analytics')).toBeUndefined();
    expect(db.prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid').all()).toEqual(
      migrationsBefore,
    );
    expect(
      db
        .prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%'
           ORDER BY type, name`,
        )
        .all(),
    ).toEqual(schemaBefore);
    db.close();
  });

  it('rolls every deletion back when a late table delete fails', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    seedAllApplicationState(repo);
    const before = applicationRowCounts(repo);
    db.exec(`
      CREATE TRIGGER synthetic_delete_all_failure
      BEFORE DELETE ON user_settings
      BEGIN
        SELECT RAISE(ABORT, 'synthetic_delete_blocked');
      END;
    `);

    expect(() => repo.deleteAllData()).toThrow('synthetic_delete_blocked');
    expect(applicationRowCounts(repo)).toEqual(before);
    db.close();
  });
});

describe('Repository.recomputeWorkoutSpan', () => {
  it('re-derives start/end/duration from current metric_series and route_points', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const { workoutId, sourceFileId: hrFile } = seedWorkoutWithFile(repo, {
      start: Date.UTC(2031, 0, 1, 8, 0, 0),
      end: Date.UTC(2031, 0, 1, 9, 0, 0),
    });
    // Widen via a route that starts earlier and ends later than the metric series.
    repo.insertRoute({
      workoutId,
      sourceFileId: hrFile,
      format: 'gpx',
      distanceM: null,
      segments: [
        {
          points: [
            { t: Date.UTC(2031, 0, 1, 7, 55, 0), lat: -48.1, lon: -124.1 },
            { t: Date.UTC(2031, 0, 1, 9, 5, 0), lat: -48.2, lon: -124.2 },
          ],
        },
      ],
    });
    // Corrupt the stored span so recompute has something real to fix.
    db.prepare('UPDATE workouts SET start_utc = 0, end_utc = 0, duration_s = 0 WHERE id = ?').run(
      workoutId,
    );

    const changed = repo.recomputeWorkoutSpan(workoutId);

    expect(changed).toBe(true);
    const w = repo.getWorkout(workoutId);
    expect(w!.start_utc).toBe(Date.UTC(2031, 0, 1, 7, 55, 0));
    expect(w!.end_utc).toBe(Date.UTC(2031, 0, 1, 9, 5, 0));
    expect(w!.duration_s).toBe(Math.round((w!.end_utc - w!.start_utc) / 1000));
    db.close();
  });

  it('returns false when the workout has no dated child rows', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const workoutId = repo.createWorkout('outdoor_cycling', 1, 2, 'import');
    expect(repo.recomputeWorkoutSpan(workoutId)).toBe(false);
    db.close();
  });
});

describe('Repository.insertRoute', () => {
  it('stores bounds for a large synthetic route without argument spreading', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const batchId = repo.createBatch('synthetic-test', 1);
    const sourceFileId = repo.insertSourceFile({
      batchId,
      sha256: 'synthetic-large-route',
      originalName: 'synthetic-route.gpx',
      detectedType: 'route:gpx',
      parserVersion: 'synthetic-v1',
      status: 'imported',
      sizeBytes: 1,
    });
    const workoutId = repo.createWorkout('outdoor_cycling', 1, 200_000, 'synthetic-test');
    const points = Array.from({ length: 200_000 }, (_, index) => ({
      t: index + 1,
      lat: -48 + index / 10_000_000,
      lon: -123 - index / 10_000_000,
    }));

    repo.transaction(() => {
      repo.insertRoute({
        workoutId,
        sourceFileId,
        format: 'gpx',
        segments: [{ points }],
        distanceM: null,
      });
    });

    const stored = db
      .prepare('SELECT point_count, bounds_json FROM routes WHERE workout_id = ?')
      .get(workoutId) as { point_count: number; bounds_json: string };
    expect(stored.point_count).toBe(200_000);
    expect(JSON.parse(stored.bounds_json)).toEqual({
      latMin: -48,
      latMax: -47.9800001,
      lonMin: -123.0199999,
      lonMax: -123,
    });
    expect(repo.countRows('route_points')).toBe(200_000);
    db.close();
  });
});
