import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { guardAgainstCheckout } from './datadir.ts';
import { checkpointDatabase, openDatabase } from './database.ts';

export interface BackupResult {
  totalPages: number;
  remainingPages: number;
}

export interface RestoreOptions {
  /**
   * Test seam invoked after the replacement has been staged and validated,
   * but before the live handle is checkpointed or closed.
   */
  beforeSwap?: () => void | Promise<void>;
}

/**
 * A restore can fail after the old handle has been closed (for example, if
 * the filesystem refuses the atomic rename). In that case this error carries
 * a freshly reopened handle for whichever complete database still owns the
 * live path, so callers never have to keep using a closed connection.
 */
export class RestoreDatabaseError extends Error {
  readonly code: string;
  readonly recoveredDatabase: Database | undefined;

  constructor(code: string, recoveredDatabase?: Database) {
    super(code);
    this.name = 'RestoreDatabaseError';
    this.code = code;
    this.recoveredDatabase = recoveredDatabase;
  }
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

function openVelographBackup(path: string): Database {
  let probe: Database | undefined;
  try {
    probe = new DatabaseConstructor(path, { readonly: true, fileMustExist: true });
    const valid =
      probe
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workouts'")
        .get() !== undefined;
    if (!valid) throw new Error('invalid_backup_file');
    return probe;
  } catch {
    if (probe?.open) {
      try {
        probe.close();
      } catch {
        // Preserve the privacy-safe validation error below.
      }
    }
    throw new Error('invalid_backup_file');
  }
}

/** True when `path` exists and looks like a Velograph database (has a `workouts` table). */
export function isVelographBackup(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const probe = openVelographBackup(path);
    try {
      probe.close();
    } catch {
      // Validation already succeeded; suppress a native path-bearing close
      // error in this boolean probe.
    }
    return true;
  } catch {
    return false;
  }
}

function removeSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  try {
    fsyncPath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR' || code === 'EPERM') {
      // Some platforms cannot open or fsync directory handles. The staged
      // database itself is still fsynced before the atomic rename.
      return;
    }
    throw error;
  }
}

/**
 * Restore the live database from a backup file (PRD: use the backup API,
 * never copy files out from under an open WAL connection). The incoming
 * database is first backed up to a sibling temporary file, opened, migrated,
 * integrity-checked, checkpointed, closed, and fsynced while `liveDb` remains
 * usable. The final cutover checkpoints and closes the old handle, atomically
 * renames the complete staged file over `dbPath`, then removes the old
 * WAL/SHM sidecars and reopens the replacement.
 *
 * A process exit before the rename leaves the original path untouched. A
 * process exit during the rename observes either the complete original or the
 * complete replacement. The live database is never overwritten in place.
 *
 * The caller is responsible for swapping any references to the old, now
 * closed `liveDb` handle for the returned one.
 */
export async function restoreDatabase(
  liveDb: Database,
  dbPath: string,
  backupPath: string,
  options: RestoreOptions = {},
): Promise<Database> {
  const resolvedBackup = resolve(backupPath);
  const resolvedDbPath = resolve(dbPath);
  // Validate and copy from one already-open read-only handle so the source
  // path cannot be substituted between separate validation and backup opens.
  const source = openVelographBackup(resolvedBackup);
  mkdirSync(dirname(resolvedDbPath), { recursive: true });
  const stagedPath = join(
    dirname(resolvedDbPath),
    `.${basename(resolvedDbPath)}.restore-${randomUUID()}.tmp`,
  );
  let staged: Database | undefined;
  let liveClosed = false;
  let swapped = false;
  try {
    await source.backup(stagedPath);

    // Opening through the normal boundary applies compatible migrations to
    // the staged copy and proves the replacement can be used before the live
    // connection is disturbed.
    staged = openDatabase(stagedPath);
    const integrity = staged.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error('invalid_backup_integrity');
    }
    checkpointDatabase(staged);
    staged.close();
    staged = undefined;
    removeSidecars(stagedPath);
    fsyncPath(stagedPath);

    await options.beforeSwap?.();

    checkpointDatabase(liveDb);
    liveDb.close();
    liveClosed = true;

    // Same-directory rename is the commit point. Never delete the live main
    // file or its sidecars before this succeeds.
    renameSync(stagedPath, resolvedDbPath);
    swapped = true;
    fsyncDirectory(dirname(resolvedDbPath));
    removeSidecars(resolvedDbPath);
    fsyncDirectory(dirname(resolvedDbPath));
    return openDatabase(resolvedDbPath);
  } catch (error) {
    if (!liveClosed) throw error;

    // If the cutover itself failed, the original path is still intact. If a
    // later reopen failed, the atomically committed replacement is intact.
    // Reopen whichever complete database owns the path so the API/CLI can
    // recover its handle instead of retaining a closed connection.
    let recoveredDatabase: Database | undefined;
    try {
      recoveredDatabase = openDatabase(resolvedDbPath);
    } catch {
      // The stable error code remains value-free; the original cause and
      // local paths must not escape into API responses or logs.
    }
    throw new RestoreDatabaseError(
      swapped ? 'restore_reopen_failed' : 'restore_cutover_failed',
      recoveredDatabase,
    );
  } finally {
    if (staged?.open) {
      try {
        staged.close();
      } catch {
        // Cleanup must not replace a successful restore or its structured
        // recovery error.
      }
    }
    if (source.open) {
      try {
        source.close();
      } catch {
        // Preserve the primary restore outcome.
      }
    }
    if (!swapped) {
      try {
        removeSidecars(stagedPath);
      } catch {
        // A uniquely named leftover staging artifact is safer than masking
        // the recoverable live-database outcome.
      }
      try {
        if (existsSync(stagedPath)) rmSync(stagedPath, { force: true });
      } catch {
        // Preserve the primary restore outcome.
      }
    }
  }
}
