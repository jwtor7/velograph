import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import {
  applyMigrations,
  isOrderedMigrationPrefix,
  listMigrations,
  readAppliedMigrations,
} from './migrate.ts';
import { openDatabase } from './database.ts';

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
      'schema_migrations',
    ]) {
      expect(tables).toContain(t);
    }
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
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

  it('adopts a legacy filename-only history once and then verifies its checksum', () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-mig-'));
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const db = new DatabaseConstructor(':memory:');
    db.exec(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_a.sql', 1000);
    `);

    expect(applyMigrations(db, dir)).toEqual([]);
    expect(readAppliedMigrations(db)).toEqual([
      {
        name: '0001_a.sql',
        appliedAt: 1000,
        checksum: listMigrations(dir)[0]!.checksum,
      },
    ]);
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

  it('rolls back checksum adoption when a pinned legacy history is invalid', () => {
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
          ('0001_a.sql', 1000, NULL),
          ('0002_b.sql', 2000, '${'0'.repeat(64)}');
    `);

    expect(() => applyMigrations(db, dir)).toThrow('migration_checksum_mismatch');
    expect(db.prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid').all()).toEqual(
      [
        { name: '0001_a.sql', checksum: null },
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
});
