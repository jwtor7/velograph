import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from './migrate.ts';

export type { Database };

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Open (creating if needed) a Velograph SQLite database with foreign keys on
 * and WAL journaling, and bring it to the latest schema version.
 * Pass ':memory:' for tests.
 */
export function openDatabase(path: string): Database {
  const db = new DatabaseConstructor(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    applyMigrations(db, MIGRATIONS_DIR);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the migration/open error. A path-bearing close error must
      // not replace the compatibility failure.
    }
    throw error;
  }
}

/**
 * Flush every committed WAL frame and truncate the sidecar. SQLite reports a
 * busy result instead of throwing when another connection prevents a complete
 * checkpoint, so callers must reject that state before shutdown or restore.
 */
export function checkpointDatabase(db: Database): void {
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as {
    busy?: number;
  }[];
  if (rows[0]?.busy !== 0) {
    throw new Error('wal_checkpoint_busy');
  }
}
