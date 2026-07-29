import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { loadWorkoutData, openDatabase, Repository } from '@velograph/db';
import { sha256Hex } from '@velograph/shared';
import { DEFAULT_GPX_LIMITS } from './gpx.ts';
import { runImport, runImportGroups, type ImportFile } from './importer.ts';

const SYNTHETIC_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'synthetic',
);
const FIXTURES = join(SYNTHETIC_ROOT, 'rides');
const HARDENING_FIXTURES = join(SYNTHETIC_ROOT, 'import-hardening');

function fixtureFiles(): ImportFile[] {
  return readdirSync(FIXTURES)
    .filter((f) => /\.(csv|gpx)$/.test(f))
    .sort()
    .map((name) => ({ name, data: readFileSync(join(FIXTURES, name)) }));
}

function hardeningFixture(name: string): ImportFile {
  return { name, data: readFileSync(join(HARDENING_FIXTURES, name)) };
}

function rideFixture(name: string): ImportFile {
  return { name, data: readFileSync(join(FIXTURES, name)) };
}

const FIXED_NOW = Date.UTC(2031, 4, 1);

describe('import engine (IMP-003/005/006/007/008)', () => {
  it('imports the synthetic folder corpus into 3 associated workouts', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const result = runImport(db, fixtureFiles(), { now: FIXED_NOW });

    expect(result.quarantined).toBe(0);
    expect(result.imported).toBe(18);
    expect(repo.countRows('workouts')).toBe(3);
    // per workout: hr + cadence + distance + energy series
    expect(repo.countRows('metric_series')).toBe(12);
    // GPX preferred; route CSV skipped as fallback-only (one route per workout)
    expect(repo.countRows('routes')).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workout_source_files').get()).toEqual({ n: 18 });
    const formats = db.prepare('SELECT DISTINCT source_format FROM routes').all();
    expect(formats).toEqual([{ source_format: 'gpx' }]);
    expect(
      db.prepare('SELECT importer_version FROM import_batches WHERE id = ?').get(result.batchId),
    ).toEqual({ importer_version: 'importer-v3' });
    expect(
      db.prepare('SELECT DISTINCT parser_version FROM source_files ORDER BY parser_version').all(),
    ).toEqual([{ parser_version: 'gpx-v4' }, { parser_version: 'hae-csv-v2' }]);
    db.close();
  });

  it('re-importing identical files creates zero duplicate workouts or samples', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    runImport(db, fixtureFiles(), { now: FIXED_NOW });
    const workouts = repo.countRows('workouts');
    const samples = repo.countRows('metric_samples');
    const points = repo.countRows('route_points');

    const second = runImport(db, fixtureFiles(), { now: FIXED_NOW + 1000 });
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(18);
    expect(repo.countRows('workouts')).toBe(workouts);
    expect(repo.countRows('metric_samples')).toBe(samples);
    expect(repo.countRows('route_points')).toBe(points);
    db.close();
  });

  it('forgets superseded route hashes when their workout is deleted', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const routeCsv = rideFixture('Outdoor Cycling-Route-20310402_073000.csv');
    const routeGpx = rideFixture('Outdoor Cycling-Route-20310402_073000.gpx');

    const csvImport = runImport(db, [routeCsv], { now: FIXED_NOW });
    const workoutId = repo.listWorkouts()[0]!.id;
    expect(csvImport).toMatchObject({
      imported: 1,
      skippedDuplicates: 0,
      workoutsCreated: 1,
    });
    expect(repo.workoutRouteFormat(workoutId)).toBe('csv');

    const gpxImport = runImport(db, [routeGpx], { now: FIXED_NOW + 1_000 });
    expect(gpxImport).toMatchObject({
      imported: 1,
      skippedDuplicates: 0,
      workoutsUpdated: 1,
    });
    expect(repo.workoutRouteFormat(workoutId)).toBe('gpx');
    expect(repo.sourceFileIdsForWorkout(workoutId)).toHaveLength(2);

    const csvHash = sha256Hex(routeCsv.data);
    const gpxHash = sha256Hex(routeGpx.data);
    expect(repo.findSourceFileByHash(csvHash)).toBeDefined();
    expect(repo.findSourceFileByHash(gpxHash)).toBeDefined();
    expect(repo.deleteWorkout(workoutId)?.removedSourceFileIds).toHaveLength(2);
    expect(repo.findSourceFileByHash(csvHash)).toBeUndefined();
    expect(repo.findSourceFileByHash(gpxHash)).toBeUndefined();

    const reimport = runImport(db, [routeCsv], { now: FIXED_NOW + 2_000 });
    expect(reimport).toMatchObject({
      imported: 1,
      skippedDuplicates: 0,
      workoutsCreated: 1,
    });
    expect(repo.countRows('workouts')).toBe(1);
    expect(repo.countRows('routes')).toBe(1);
    db.close();
  });

  it('reprocesses an existing hash when its parser version changes', () => {
    const db = openDatabase(':memory:');
    const file = hardeningFixture('Outdoor Cycling-Cycling Cadence-20310604_080000.csv');
    const first = runImport(db, [file], { now: FIXED_NOW });
    const source = db.prepare('SELECT id FROM source_files').get() as { id: number };
    const workout = db.prepare('SELECT id FROM workouts').get() as { id: number };
    db.prepare(
      `INSERT INTO analytics_snapshots
         (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
       VALUES (?, 'workout', 'synthetic-old', 's', 'i', '{}', ?)`,
    ).run(workout.id, FIXED_NOW);
    db.prepare(
      `INSERT INTO insight_runs
         (workout_id, provider, model_id, prompt_version, schema_version, input_hash,
          payload_json, output_json, validation_status, created_at)
       VALUES (?, 'disabled', NULL, 'synthetic-old', 'synthetic-old', 'i',
               '{}', NULL, 'valid', ?)`,
    ).run(workout.id, FIXED_NOW);
    db.prepare(
      `INSERT INTO notes_tags (workout_id, kind, content, created_at)
       VALUES (?, 'note', 'Synthetic reprocessing note', ?)`,
    ).run(workout.id, FIXED_NOW);
    db.prepare(
      `INSERT INTO notes_tags (workout_id, kind, content, created_at)
       VALUES (?, 'tag', 'synthetic-retained-tag', ?)`,
    ).run(workout.id, FIXED_NOW);
    db.prepare('UPDATE workouts SET start_utc = ?, end_utc = ?, duration_s = 60 WHERE id = ?').run(
      Date.UTC(2040, 0, 1),
      Date.UTC(2040, 0, 1, 0, 1),
      workout.id,
    );
    db.prepare("UPDATE source_files SET parser_version = 'hae-csv-v1' WHERE id = ?").run(source.id);

    const second = runImport(db, [file], { now: FIXED_NOW + 1000 });

    expect(first.imported).toBe(1);
    expect(second).toMatchObject({
      imported: 1,
      skippedDuplicates: 0,
      quarantined: 0,
      workoutsCreated: 0,
      workoutsUpdated: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_files').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM metric_series').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM workouts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT id FROM workouts').get()).toEqual({ id: workout.id });
    expect(
      db.prepare('SELECT workout_id, kind, content FROM notes_tags ORDER BY id').all(),
    ).toEqual([
      {
        workout_id: workout.id,
        kind: 'note',
        content: 'Synthetic reprocessing note',
      },
      {
        workout_id: workout.id,
        kind: 'tag',
        content: 'synthetic-retained-tag',
      },
    ]);
    expect(
      db
        .prepare(
          'SELECT id, batch_id, parser_version, status, error_code FROM source_files WHERE id = ?',
        )
        .get(source.id),
    ).toEqual({
      id: source.id,
      batch_id: second.batchId,
      parser_version: 'hae-csv-v2',
      status: 'imported',
      error_code: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM insight_runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_file_reprocessing_failures').get()).toEqual(
      { n: 0 },
    );
    db.close();
  });

  it('records a failed parser upgrade without deleting last-known-good data or notes', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const file = hardeningFixture('Outdoor Cycling-Route-20310608_080000-invalid-time.gpx');
    const legacyBatchId = repo.createBatch('synthetic-legacy-importer', FIXED_NOW);
    const sourceFileId = repo.insertSourceFile({
      batchId: legacyBatchId,
      sha256: sha256Hex(file.data),
      originalName: file.name,
      detectedType: 'route:gpx',
      parserVersion: 'gpx-v3',
      status: 'imported',
      sizeBytes: file.data.length,
    });
    const start = Date.UTC(2031, 5, 8, 8, 0, 0);
    const workoutId = repo.createWorkout(
      'outdoor_cycling',
      start,
      start + 60_000,
      'synthetic-legacy-import',
    );
    repo.insertRoute({
      workoutId,
      sourceFileId,
      format: 'gpx',
      distanceM: null,
      segments: [
        {
          points: [
            { t: start, lat: -48.4, lon: -123.4 },
            { t: start + 60_000, lat: -48.41, lon: -123.41 },
          ],
        },
      ],
    });
    db.prepare(
      `INSERT INTO notes_tags (workout_id, kind, content, created_at)
       VALUES (?, 'note', 'Synthetic retained note', ?)`,
    ).run(workoutId, FIXED_NOW);
    db.prepare(
      `INSERT INTO notes_tags (workout_id, kind, content, created_at)
       VALUES (?, 'tag', 'synthetic-retained-tag', ?)`,
    ).run(workoutId, FIXED_NOW);
    db.prepare(
      `INSERT INTO analytics_snapshots
         (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
       VALUES (?, 'workout', 'synthetic-old', 's', 'i', '{}', ?)`,
    ).run(workoutId, FIXED_NOW);
    db.prepare(
      `INSERT INTO insight_runs
         (workout_id, provider, model_id, prompt_version, schema_version, input_hash,
          payload_json, output_json, validation_status, created_at)
       VALUES (?, 'disabled', NULL, 'synthetic-old', 'synthetic-old', 'i',
               '{}', NULL, 'valid', ?)`,
    ).run(workoutId, FIXED_NOW);
    repo.finishBatch(legacyBatchId, 'committed', {
      imported: 1,
      skippedDuplicates: 0,
      quarantined: 0,
      workoutsCreated: 1,
      workoutsUpdated: 0,
    });
    const preservedTables = [
      'source_files',
      'workouts',
      'routes',
      'route_points',
      'notes_tags',
      'analytics_snapshots',
      'insight_runs',
    ] as const;
    const before = Object.fromEntries(
      preservedTables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    );

    const result = runImport(db, [file], { now: FIXED_NOW + 1000 });

    expect(result).toMatchObject({
      imported: 0,
      quarantined: 1,
      workoutsCreated: 0,
      workoutsUpdated: 0,
      quarantinedFiles: [{ name: file.name, code: 'timestamps_invalid' }],
    });
    expect(repo.getWorkout(workoutId)).toBeDefined();
    expect(repo.countRows('routes')).toBe(1);
    expect(repo.countRows('route_points')).toBe(2);
    for (const table of preservedTables) {
      expect(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(before[table]);
    }
    expect(
      db
        .prepare(
          `SELECT source_file_id, batch_id, attempted_parser_version, error_code, created_at
           FROM source_file_reprocessing_failures`,
        )
        .get(),
    ).toEqual({
      source_file_id: sourceFileId,
      batch_id: result.batchId,
      attempted_parser_version: 'gpx-v4',
      error_code: 'timestamps_invalid',
      created_at: FIXED_NOW + 1000,
    });
    db.close();
  });

  it('fails closed when one stale source owns normalized rows in multiple workouts', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const file = hardeningFixture('Outdoor Cycling-Cycling Cadence-20310604_080000.csv');
    runImport(db, [file], { now: FIXED_NOW });
    const source = db.prepare('SELECT id FROM source_files').get() as { id: number };
    const secondStart = Date.UTC(2031, 5, 5, 8, 0, 0);
    const secondWorkoutId = repo.createWorkout(
      'outdoor_cycling',
      secondStart,
      secondStart + 60_000,
      'synthetic-shared-source',
    );
    repo.insertMetricSeries({
      workoutId: secondWorkoutId,
      sourceFileId: source.id,
      metric: 'cadence',
      unit: 'rpm',
      source: null,
      samples: [
        { t: secondStart, value: 75 },
        { t: secondStart + 60_000, value: 77 },
      ],
    });
    db.prepare("UPDATE source_files SET parser_version = 'hae-csv-v1' WHERE id = ?").run(source.id);
    const preservedTables = [
      'source_files',
      'workouts',
      'metric_series',
      'metric_samples',
    ] as const;
    const before = Object.fromEntries(
      preservedTables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    );

    const result = runImport(db, [file], { now: FIXED_NOW + 1000 });

    expect(result).toMatchObject({
      imported: 0,
      quarantined: 1,
      workoutsCreated: 0,
      workoutsUpdated: 0,
      quarantinedFiles: [{ name: file.name, code: 'association_ambiguous' }],
    });
    expect(repo.countRows('workouts')).toBe(2);
    expect(repo.countRows('metric_series')).toBe(2);
    expect(repo.workoutIdsForSourceFile(source.id)).toHaveLength(2);
    for (const table of preservedTables) {
      expect(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(before[table]);
    }
    expect(
      db.prepare('SELECT parser_version, status FROM source_files WHERE id = ?').get(source.id),
    ).toEqual({ parser_version: 'hae-csv-v1', status: 'imported' });
    expect(
      db
        .prepare(
          `SELECT source_file_id, attempted_parser_version, error_code
           FROM source_file_reprocessing_failures`,
        )
        .get(),
    ).toEqual({
      source_file_id: source.id,
      attempted_parser_version: 'hae-csv-v2',
      error_code: 'association_ambiguous',
    });
    db.close();
  });

  it('rolls a parser-version replacement back atomically on a storage failure', () => {
    const db = openDatabase(':memory:');
    const file = hardeningFixture('Outdoor Cycling-Cycling Cadence-20310604_080000.csv');
    runImport(db, [file], { now: FIXED_NOW });
    const source = db.prepare('SELECT id FROM source_files').get() as { id: number };
    const workout = db.prepare('SELECT id FROM workouts').get() as { id: number };
    db.prepare(
      `INSERT INTO analytics_snapshots
         (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
       VALUES (?, 'workout', 'synthetic-old', 's', 'i', '{}', ?)`,
    ).run(workout.id, FIXED_NOW);
    db.prepare("UPDATE source_files SET parser_version = 'hae-csv-v1' WHERE id = ?").run(source.id);
    db.exec(`
      CREATE TRIGGER synthetic_source_update_failure
      BEFORE UPDATE ON source_files
      BEGIN
        SELECT RAISE(ABORT, 'synthetic storage failure');
      END
    `);

    expect(() => runImport(db, [file], { now: FIXED_NOW + 1000 })).toThrow(
      'synthetic storage failure',
    );

    expect(db.prepare('SELECT COUNT(*) AS n FROM import_batches').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM workouts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM metric_series').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_snapshots').get()).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT parser_version FROM source_files WHERE id = ?').get(source.id),
    ).toEqual({ parser_version: 'hae-csv-v1' });
    db.close();
  });

  it('imports a ZIP of the same corpus identically to the folder', () => {
    const dbFolder = openDatabase(':memory:');
    const dbZip = openDatabase(':memory:');
    const files = fixtureFiles();
    runImport(dbFolder, files, { now: FIXED_NOW });

    const zipped = zipSync(Object.fromEntries(files.map((f) => [f.name, new Uint8Array(f.data)])));
    runImport(dbZip, [{ name: 'export.zip', data: zipped }], { now: FIXED_NOW });

    for (const table of [
      'workouts',
      'metric_series',
      'metric_samples',
      'routes',
      'route_points',
    ] as const) {
      expect(new Repository(dbZip).countRows(table)).toBe(
        new Repository(dbFolder).countRows(table),
      );
    }
    dbFolder.close();
    dbZip.close();
  });

  it('quarantines malformed files with value-free codes, without aborting the batch', () => {
    const db = openDatabase(':memory:');
    const good = fixtureFiles().slice(0, 6);
    const bad: ImportFile[] = [
      {
        name: 'Outdoor Cycling-Heart Rate-20310501_070000.csv',
        data: Buffer.from('Nope,Columns\n1,2\n'),
      },
      {
        name: 'Outdoor Cycling-Route-20310501_070000.gpx',
        data: Buffer.from('<?xml version="1.0"?><!DOCTYPE x []><gpx></gpx>'),
      },
      { name: 'random.txt', data: Buffer.from('hello') },
    ];
    const result = runImport(db, [...good, ...bad], { now: FIXED_NOW });
    expect(result.quarantined).toBe(3);
    const codes = result.quarantinedFiles.map((q) => q.code).sort();
    expect(codes).toEqual([
      'unrecognized_headers',
      'unsupported_file_type',
      'xml_doctype_rejected',
    ]);
    // quarantined rows exist, but contributed no data
    const quarantined = db
      .prepare("SELECT COUNT(*) AS n FROM source_files WHERE status = 'quarantined'")
      .get() as { n: number };
    expect(quarantined.n).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_file_reprocessing_failures').get()).toEqual(
      { n: 0 },
    );
    expect(result.imported).toBe(6);
    db.close();
  });

  it('quarantines filename timestamps that conflict with internal sample times', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const files: ImportFile[] = [
      hardeningFixture('Outdoor Cycling-Heart Rate-20990101_000000.csv'),
      hardeningFixture('Outdoor Cycling-Cycling Cadence-20770707_070707.csv'),
    ];
    const result = runImport(db, files, { now: FIXED_NOW });
    expect(result.quarantined).toBe(2);
    expect(result.quarantinedFiles.map((f) => f.code)).toEqual([
      'association_conflict',
      'association_conflict',
    ]);
    expect(repo.countRows('workouts')).toBe(0);
    expect(repo.countRows('metric_series')).toBe(0);
    db.close();
  });

  it('quarantines an ambiguous association instead of selecting the earliest workout', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const start = Date.UTC(2031, 5, 3, 8, 0, 0);
    repo.createWorkout('outdoor_cycling', start - 60_000, start + 31 * 60_000, 'test');
    repo.createWorkout('outdoor_cycling', start - 2 * 60_000, start + 32 * 60_000, 'test');

    const result = runImport(
      db,
      [hardeningFixture('Outdoor Cycling-Heart Rate-20310603_080000.csv')],
      { now: FIXED_NOW },
    );

    expect(result.quarantinedFiles).toEqual([
      {
        name: 'Outdoor Cycling-Heart Rate-20310603_080000.csv',
        code: 'association_ambiguous',
      },
    ]);
    expect(repo.countRows('workouts')).toBe(2);
    expect(repo.countRows('metric_series')).toBe(0);
    db.close();
  });

  it('quarantines a malformed outer ZIP and continues a valid sibling', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);

    const result = runImport(
      db,
      [
        hardeningFixture('Outdoor Cycling-Cycling Cadence-20310604_080000.csv'),
        { name: 'malformed-synthetic.zip', data: Buffer.from('not a zip') },
      ],
      { now: FIXED_NOW },
    );

    expect(result).toMatchObject({
      imported: 1,
      quarantined: 1,
      workoutsCreated: 1,
    });
    expect(result.quarantinedFiles).toEqual([
      { name: 'malformed-synthetic.zip', code: 'io_error' },
    ]);
    expect(repo.countRows('metric_series')).toBe(1);
    expect(
      db
        .prepare(
          "SELECT status, detected_type, parser_version, error_code FROM source_files WHERE original_name = 'malformed-synthetic.zip'",
        )
        .get(),
    ).toEqual({
      status: 'quarantined',
      detected_type: 'archive:zip',
      parser_version: 'zip-v2',
      error_code: 'io_error',
    });
    expect(
      db.prepare('SELECT status FROM import_batches WHERE id = ?').get(result.batchId),
    ).toEqual({ status: 'committed' });
    db.close();
  });

  it('shares one decoded-byte budget across every selected outer ZIP', () => {
    const db = openDatabase(':memory:');
    const first = zipSync({ 'synthetic-first.txt': Buffer.from('A'.repeat(60_000)) }, { level: 9 });
    const second = zipSync(
      { 'synthetic-second.txt': Buffer.from('B'.repeat(60_000)) },
      { level: 9 },
    );

    const result = runImport(
      db,
      [
        { name: 'alpha-synthetic.zip', data: first },
        { name: 'beta-synthetic.zip', data: second },
      ],
      {
        now: FIXED_NOW,
        zipLimits: {
          maxEntries: 10,
          maxEntryBytes: 80_000,
          maxTotalBytes: 100_000,
        },
      },
    );

    expect(result.imported).toBe(0);
    expect(result.quarantinedFiles).toEqual([
      { name: 'beta-synthetic.zip', code: 'zip_limits_exceeded' },
      { name: 'synthetic-first.txt', code: 'unsupported_file_type' },
    ]);
    expect(
      db
        .prepare(
          "SELECT original_name, error_code FROM source_files WHERE status = 'quarantined' ORDER BY original_name",
        )
        .all(),
    ).toEqual([
      { original_name: 'beta-synthetic.zip', error_code: 'zip_limits_exceeded' },
      { original_name: 'synthetic-first.txt', error_code: 'unsupported_file_type' },
    ]);
    db.close();
  });

  it('quarantines a whole CSV when a required number or timestamp is invalid', () => {
    const db = openDatabase(':memory:');

    const result = runImport(
      db,
      [
        hardeningFixture('Outdoor Cycling-Cycling Cadence-20310605_080000.csv'),
        hardeningFixture('Outdoor Cycling-Cycling Distance-20310606_080000.csv'),
      ],
      { now: FIXED_NOW },
    );

    expect(result.imported).toBe(0);
    expect(result.quarantinedFiles.map((f) => f.code).sort()).toEqual([
      'numeric_value_invalid',
      'timestamps_invalid',
    ]);
    expect(new Repository(db).countRows('metric_samples')).toBe(0);
    db.close();
  });

  it('stores mixed timed and untimed GPX points without fabricating epoch zero', () => {
    const db = openDatabase(':memory:');

    const result = runImport(db, [hardeningFixture('Outdoor Cycling-Route-20310607_080000.gpx')], {
      now: FIXED_NOW,
    });

    expect(result.quarantined).toBe(0);
    expect(db.prepare('SELECT t_utc FROM route_points ORDER BY seq').all()).toEqual([
      { t_utc: null },
      { t_utc: Date.UTC(2031, 5, 7, 8, 0, 0) },
    ]);
    const workout = db.prepare('SELECT id FROM workouts').get() as { id: number };
    expect(loadWorkoutData(db, workout.id)!.route[0]!.points.map((point) => point.t)).toEqual([
      null,
      Date.UTC(2031, 5, 7, 8, 0, 0),
    ]);
    db.close();
  });

  it('quarantines invalid UTF-8 GPX instead of decoding replacement characters', () => {
    const db = openDatabase(':memory:');
    const bytes = Buffer.concat([
      Buffer.from('<gpx><trk><trkseg><trkpt lat="-48" lon="-123">'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('</trkpt></trkseg></trk></gpx>'),
    ]);

    const result = runImport(
      db,
      [{ name: 'Outdoor Cycling-Route-20310609_080000.gpx', data: bytes }],
      { now: FIXED_NOW },
    );

    expect(result.quarantinedFiles).toEqual([
      {
        name: 'Outdoor Cycling-Route-20310609_080000.gpx',
        code: 'malformed_xml',
      },
    ]);
    expect(new Repository(db).countRows('route_points')).toBe(0);
    db.close();
  });

  it('rejects an oversized GPX by raw byte length before decoding', () => {
    class SyntheticOversizedBytes extends Uint8Array {
      override get byteLength(): number {
        return DEFAULT_GPX_LIMITS.maxBytes + 1;
      }
    }
    const data = new SyntheticOversizedBytes(Buffer.from('<gpx/>'));
    const db = openDatabase(':memory:');

    const result = runImport(db, [{ name: 'Outdoor Cycling-Route-20310610_080000.gpx', data }], {
      now: FIXED_NOW,
    });

    expect(result.quarantinedFiles).toEqual([
      {
        name: 'Outdoor Cycling-Route-20310610_080000.gpx',
        code: 'gpx_limits_exceeded',
      },
    ]);
    expect(new Repository(db).countRows('route_points')).toBe(0);
    db.close();
  });

  it('associates offset-less metric CSV wall time with an absolute UTC route', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const files: ImportFile[] = [
      hardeningFixture('Outdoor Cycling-Active Energy-20320710_113000.csv'),
      hardeningFixture('Outdoor Cycling-Route-20320710_113000.gpx'),
    ];

    const result = runImport(db, files, {
      now: FIXED_NOW,
      timeZone: 'America/Toronto',
    });

    expect(result.quarantined).toBe(0);
    expect(repo.countRows('workouts')).toBe(1);
    expect(repo.countRows('metric_series')).toBe(1);
    expect(repo.countRows('routes')).toBe(1);
    const joined = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM metric_series m
         JOIN routes r ON r.workout_id = m.workout_id
         WHERE m.metric_type = 'energy'`,
      )
      .get() as { n: number };
    expect(joined.n).toBe(1);
    db.close();
  });

  it('a far-apart ride becomes a separate workout (tolerance respected)', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const mk = (dateA: string, dateB: string) =>
      [`Date/Time,Avg (bpm),Source`, `${dateA},120,S`, `${dateB},125,S`].join('\n');
    const files: ImportFile[] = [
      {
        name: 'Outdoor Cycling-Heart Rate-20310601_080000.csv',
        data: Buffer.from(mk('2031-06-01T08:00:00Z', '2031-06-01T08:40:00Z')),
      },
      {
        name: 'Outdoor Cycling-Heart Rate-20310602_080000.csv',
        data: Buffer.from(mk('2031-06-02T08:00:00Z', '2031-06-02T08:40:00Z')),
      },
    ];
    runImport(db, files, { now: FIXED_NOW });
    expect(repo.countRows('workouts')).toBe(2);
    db.close();
  });
});
