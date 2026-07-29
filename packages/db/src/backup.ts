import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { guardAgainstCheckout } from './datadir.ts';
import { openDatabase } from './database.ts';

export interface BackupResult {
  totalPages: number;
  remainingPages: number;
}

/**
 * Export the live database to `destPath` using SQLite's online backup API
 * (PRD: backups use the backup API, never a copy of a live WAL database's
 * files). `destPath` must not resolve inside a git checkout — backups carry
 * real health data — enforced by the same `guardAgainstCheckout` guard used
 * for VELO_DATA_DIR.
 */
export async function backupDatabase(db: Database, destPath: string): Promise<BackupResult> {
  const resolved = resolve(destPath);
  guardAgainstCheckout(dirname(resolved));
  mkdirSync(dirname(resolved), { recursive: true });
  return db.backup(resolved);
}

/** True when `path` exists and looks like a Velograph database (has a `workouts` table). */
export function isVelographBackup(path: string): boolean {
  if (!existsSync(path)) return false;
  let probe: Database;
  try {
    probe = new DatabaseConstructor(path, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    return (
      probe
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workouts'")
        .get() !== undefined
    );
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

/**
 * Restore the live database from a backup file (PRD: use the backup API,
 * never copy files out from under an open WAL connection). Validates the
 * backup file, checkpoints and closes `liveDb`, clears any leftover
 * WAL/SHM sidecars next to `dbPath`, backs the validated source into
 * `dbPath` via SQLite's own backup API, then reopens `dbPath` (bringing it
 * to the current schema via migrations) and returns the fresh handle.
 *
 * The caller is responsible for swapping any references to the old, now
 * closed `liveDb` handle for the returned one.
 */
export async function restoreDatabase(
  liveDb: Database,
  dbPath: string,
  backupPath: string,
): Promise<Database> {
  const resolvedBackup = resolve(backupPath);
  if (!isVelographBackup(resolvedBackup)) {
    throw new Error('invalid_backup_file');
  }
  const source = new DatabaseConstructor(resolvedBackup, { readonly: true, fileMustExist: true });
  try {
    liveDb.pragma('wal_checkpoint(TRUNCATE)');
    liveDb.close();
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) rmSync(sidecar);
    }
    await source.backup(resolve(dbPath));
  } finally {
    source.close();
  }
  return openDatabase(dbPath);
}
