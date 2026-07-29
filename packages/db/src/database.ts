import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from './migrate.ts';

export type { Database };

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Open (creating if needed) a Velograph SQLite database with foreign keys on
 * and WAL journaling, and bring it to the latest schema version.
 * Pass ':memory:' for tests.
 */
export function openDatabase(path: string): Database {
  const db = new DatabaseConstructor(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  applyMigrations(db, MIGRATIONS_DIR);
  return db;
}
