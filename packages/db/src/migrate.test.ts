import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { applyMigrations } from './migrate.ts';
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
    expect(applyMigrations(db, dir)).toEqual([]); // second run: nothing new
    writeFileSync(join(dir, '0003_c.sql'), 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
    expect(applyMigrations(db, dir)).toEqual(['0003_c.sql']);
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
});
