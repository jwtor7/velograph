import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseConstructor from 'better-sqlite3';
import {
  applyMigrations,
  isOrderedMigrationPrefix,
  listMigrations,
  readAppliedMigrations,
} from './migrate.ts';
import { MIGRATIONS_DIR, openDatabase } from './database.ts';

const BUNDLED_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

describe('ordered migrations', () => {
  it('applies the bundled schema and is idempotent', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'import_batches',
      'source_files',
      'workouts',
      'metric_series',
      'metric_samples',
      'routes',
      'route_points',
      'analytics_snapshots',
      'insight_runs',
      'user_settings',
      'notes_tags',
      'source_file_reprocessing_failures',
      'workout_source_files',
      'backup_manifests',
      'schema_migrations',
    ]) {
      expect(tables).toContain(t);
    }
    expect(
      db
        .prepare('SELECT name FROM schema_migrations ORDER BY name')
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([
      '0001_init.sql',
      '0002_source_file_reprocessing_failures.sql',
      '0003_workout_source_files.sql',
      '0004_backup_manifest.sql',
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('upgrades a populated v1 database without changing existing source data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    writeFileSync(
      join(dir, '0001_init.sql'),
      readFileSync(join(BUNDLED_MIGRATIONS, '0001_init.sql')),
    );
    const db = new DatabaseConstructor(':memory:');
    db.pragma('foreign_keys = ON');
    expect(applyMigrations(db, dir)).toEqual(['0001_init.sql']);
    db.prepare(
      `INSERT INTO import_batches
         (id, created_at, status, importer_version, counts_json)
       VALUES (1, 1, 'committed', 'synthetic-v1', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO source_files
         (id, batch_id, sha256, original_name, detected_type, parser_version,
          status, error_code, size_bytes)
       VALUES (1, 1, 'synthetic-hash', 'synthetic.csv', 'metric:cadence',
               'synthetic-parser-v1', 'imported', NULL, 10)`,
    ).run();
    const sourceBefore = db.prepare('SELECT * FROM source_files').get();

    writeFileSync(
      join(dir, '0002_source_file_reprocessing_failures.sql'),
      readFileSync(join(BUNDLED_MIGRATIONS, '0002_source_file_reprocessing_failures.sql')),
    );
    expect(applyMigrations(db, dir)).toEqual(['0002_source_file_reprocessing_failures.sql']);
    expect(db.prepare('SELECT * FROM source_files').get()).toEqual(sourceBefore);
    expect(
      db
        .prepare('PRAGMA table_info(source_file_reprocessing_failures)')
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([
      'id',
      'source_file_id',
      'batch_id',
      'attempted_parser_version',
      'error_code',
      'created_at',
    ]);
    expect(
      (
        db.prepare('PRAGMA foreign_key_list(source_file_reprocessing_failures)').all() as {
          from: string;
          table: string;
          on_delete: string;
        }[]
      )
        .map((row) => ({ from: row.from, table: row.table, onDelete: row.on_delete }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    ).toEqual([
      { from: 'batch_id', table: 'import_batches', onDelete: 'NO ACTION' },
      { from: 'source_file_id', table: 'source_files', onDelete: 'CASCADE' },
    ]);
    db.close();
  });

  it('backfills source ownership and forgets only unowned successful hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    for (const migration of ['0001_init.sql', '0002_source_file_reprocessing_failures.sql']) {
      writeFileSync(join(dir, migration), readFileSync(join(BUNDLED_MIGRATIONS, migration)));
    }
    const db = new DatabaseConstructor(':memory:');
    db.pragma('foreign_keys = ON');
    expect(applyMigrations(db, dir)).toEqual([
      '0001_init.sql',
      '0002_source_file_reprocessing_failures.sql',
    ]);
    db.prepare(
      `INSERT INTO import_batches
         (id, created_at, status, importer_version, counts_json)
       VALUES (1, 1, 'committed', 'synthetic-v2', '{}')`,
    ).run();
    const insertSource = db.prepare(
      `INSERT INTO source_files
         (id, batch_id, sha256, original_name, detected_type, parser_version,
          status, error_code, size_bytes)
       VALUES (?, 1, ?, ?, ?, 'synthetic-parser-v1', ?, ?, 10)`,
    );
    insertSource.run(
      1,
      'synthetic-metric-hash',
      'synthetic-metric.csv',
      'metric:cadence',
      'imported',
      null,
    );
    insertSource.run(
      2,
      'synthetic-orphan-hash',
      'synthetic-superseded-route.csv',
      'route:csv',
      'imported',
      null,
    );
    insertSource.run(
      3,
      'synthetic-quarantine-hash',
      'synthetic-invalid.gpx',
      'unknown',
      'quarantined',
      'malformed_xml',
    );
    insertSource.run(
      4,
      'synthetic-route-hash',
      'synthetic-route.gpx',
      'route:gpx',
      'imported',
      null,
    );
    db.prepare(
      `INSERT INTO workouts
         (id, type, start_utc, end_utc, duration_s, provenance)
       VALUES (1, 'outdoor_cycling', 1000, 2000, 1, 'synthetic-v2')`,
    ).run();
    db.prepare(
      `INSERT INTO metric_series
         (id, workout_id, source_file_id, metric_type, unit, start_utc, end_utc, sample_count)
       VALUES (1, 1, 1, 'cadence', 'rpm', 1000, 2000, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO routes
         (id, workout_id, source_file_id, source_format, point_count, bounds_json)
       VALUES (1, 1, 4, 'gpx', 2, '{}')`,
    ).run();

    const migration = '0003_workout_source_files.sql';
    writeFileSync(join(dir, migration), readFileSync(join(BUNDLED_MIGRATIONS, migration)));
    expect(applyMigrations(db, dir)).toEqual([migration]);

    expect(
      db
        .prepare(
          'SELECT workout_id, source_file_id FROM workout_source_files ORDER BY source_file_id',
        )
        .all(),
    ).toEqual([
      { workout_id: 1, source_file_id: 1 },
      { workout_id: 1, source_file_id: 4 },
    ]);
    expect(
      db
        .prepare('SELECT id, status FROM source_files ORDER BY id')
        .all()
        .map((row) => row as { id: number; status: string }),
    ).toEqual([
      { id: 1, status: 'imported' },
      { id: 3, status: 'quarantined' },
      { id: 4, status: 'imported' },
    ]);
    expect(
      (
        db.prepare('PRAGMA foreign_key_list(workout_source_files)').all() as {
          from: string;
          table: string;
          on_delete: string;
        }[]
      )
        .map((row) => ({ from: row.from, table: row.table, onDelete: row.on_delete }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    ).toEqual([
      { from: 'source_file_id', table: 'source_files', onDelete: 'CASCADE' },
      { from: 'workout_id', table: 'workouts', onDelete: 'CASCADE' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('runs new migrations in order and records them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeFileSync(join(dir, '0002_b.sql'), 'ALTER TABLE a ADD COLUMN b TEXT;');
    const db = new DatabaseConstructor(':memory:');
    expect(applyMigrations(db, dir)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(readAppliedMigrations(db)).toEqual([
      expect.objectContaining({
        name: '0001_a.sql',
        checksum: listMigrations(dir)[0]!.checksum,
      }),
      expect.objectContaining({
        name: '0002_b.sql',
        checksum: listMigrations(dir)[1]!.checksum,
      }),
    ]);
    expect(applyMigrations(db, dir)).toEqual([]); // second run: nothing new
    writeFileSync(join(dir, '0003_c.sql'), 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
    expect(applyMigrations(db, dir)).toEqual(['0003_c.sql']);
    db.close();
  });

  it('fails closed when an applied migration file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    const migrationPath = join(dir, '0001_a.sql');
    writeFileSync(migrationPath, 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const db = new DatabaseConstructor(':memory:');
    expect(applyMigrations(db, dir)).toEqual(['0001_a.sql']);

    writeFileSync(migrationPath, 'CREATE TABLE a (id INTEGER PRIMARY KEY, changed TEXT);');

    expect(() => applyMigrations(db, dir)).toThrow('migration_checksum_mismatch');
    db.close();
  });

  it('upgrades the released filename-only schema, preserves data, and pins every checksum', () => {
    const db = new DatabaseConstructor(':memory:');
    db.exec(readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8'));
    db.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_init.sql', 1000);
    `);
    db.prepare('INSERT INTO user_settings (key, value_json) VALUES (?, ?)').run(
      'synthetic-setting',
      '"preserved"',
    );

    const available = listMigrations(MIGRATIONS_DIR);
    expect(applyMigrations(db, MIGRATIONS_DIR)).toEqual(
      available.slice(1).map((migration) => migration.name),
    );
    expect(readAppliedMigrations(db)).toEqual(
      available.map((migration, index) => ({
        ...migration,
        appliedAt: index === 0 ? 1000 : expect.any(Number),
      })),
    );
    expect(
      db.prepare("SELECT value_json FROM user_settings WHERE key = 'synthetic-setting'").get(),
    ).toEqual({ value_json: '"preserved"' });
    expect(applyMigrations(db, MIGRATIONS_DIR)).toEqual([]);
    db.close();
  });

  it('rejects a changed released migration before adopting its filename-only history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    for (const migration of listMigrations(MIGRATIONS_DIR)) {
      const content = readFileSync(join(MIGRATIONS_DIR, migration.name), 'utf8');
      writeFileSync(
        join(dir, migration.name),
        migration.name === '0001_init.sql' ? `${content}\n-- altered after release\n` : content,
      );
    }
    const db = new DatabaseConstructor(':memory:');
    db.exec(readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8'));
    db.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_init.sql', 1000);
    `);

    expect(() => applyMigrations(db, dir)).toThrow('migration_checksum_mismatch');
    expect(
      (
        db.prepare('PRAGMA table_info(schema_migrations)').all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    ).not.toContain('checksum');
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'backup_manifests'")
        .get(),
    ).toBeUndefined();
    db.close();
  });

  it('rejects a missing checksum outside the published legacy baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    writeFileSync(join(dir, '0001_unreleased.sql'), 'CREATE TABLE unreleased (id INTEGER);');
    const db = new DatabaseConstructor(':memory:');
    db.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE unreleased (id INTEGER);
      INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_unreleased.sql', 1000);
    `);

    expect(() => applyMigrations(db, dir)).toThrow('migration_checksum_missing');
    expect(
      (
        db.prepare('PRAGMA table_info(schema_migrations)').all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    ).not.toContain('checksum');
    db.close();
  });

  it('rejects a skipped or reordered recorded migration before running anything new', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    const db = new DatabaseConstructor(':memory:');
    db.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      );
      INSERT INTO schema_migrations (name, applied_at, checksum)
        VALUES ('0002_b.sql', 1000, '${'0'.repeat(64)}');
    `);

    expect(() => applyMigrations(db, dir)).toThrow('migration_history_invalid');
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'a'").get(),
    ).toBeUndefined();
    db.close();
  });

  it('rolls back checksum preparation when a pinned history is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    const db = new DatabaseConstructor(':memory:');
    db.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      );
      INSERT INTO schema_migrations (name, applied_at, checksum)
        VALUES
          ('0001_a.sql', 1000, '${listMigrations(dir)[0]!.checksum}'),
          ('0002_b.sql', 2000, '${'0'.repeat(64)}');
    `);

    expect(() => applyMigrations(db, dir)).toThrow('migration_checksum_mismatch');
    expect(db.prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid').all()).toEqual(
      [
        { name: '0001_a.sql', checksum: listMigrations(dir)[0]!.checksum },
        { name: '0002_b.sql', checksum: '0'.repeat(64) },
      ],
    );
    db.close();
  });

  it('rolls back a failing migration atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    writeFileSync(join(dir, '0001_bad.sql'), 'CREATE TABLE ok (id INTEGER); INVALID SQL;');
    const db = new DatabaseConstructor(':memory:');
    expect(() => applyMigrations(db, dir)).toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map((r) => (r as { name: string }).name)).not.toContain('ok');
    db.close();
  });

  it('accepts only an exact ordered migration prefix', () => {
    const available = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];
    expect(isOrderedMigrationPrefix([], available)).toBe(true);
    expect(isOrderedMigrationPrefix(['0001_a.sql', '0002_b.sql'], available)).toBe(true);
    expect(isOrderedMigrationPrefix(available, available)).toBe(true);
    expect(isOrderedMigrationPrefix(['0002_b.sql', '0001_a.sql'], available)).toBe(false);
    expect(isOrderedMigrationPrefix(['0001_a.sql', '0003_c.sql'], available)).toBe(false);
    expect(isOrderedMigrationPrefix([...available, '9999_future.sql'], available)).toBe(false);
  });

  it('rejects duplicate migration sequence numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeFileSync(join(dir, '0001_b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);');

    expect(() => listMigrations(dir)).toThrow('migration_files_invalid');
  });
});
