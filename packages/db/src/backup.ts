import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { guardAgainstCheckout } from './datadir.ts';
import { checkpointDatabase, MIGRATIONS_DIR, openDatabase } from './database.ts';
import { isOrderedMigrationPrefix, listMigrationFiles } from './migrate.ts';

export interface BackupResult {
  totalPages: number;
  remainingPages: number;
}

export type RestoreValidationErrorCode =
  | 'invalid_backup_file'
  | 'invalid_backup_integrity'
  | 'invalid_backup_migrations'
  | 'invalid_backup_migration'
  | 'invalid_backup_schema'
  | 'invalid_backup_foreign_keys'
  | 'restore_stage_failed'
  | 'restore_checkpoint_busy'
  | 'restore_rollback_failed';

export interface RestoreOptions {
  /**
   * Test seam invoked after stage and rollback snapshots are complete and
   * durable, but before the live handle is closed.
   */
  beforeSwap?: () => void | Promise<void>;
  /** @internal Deterministic fault-injection seam. */
  stageBackup?: (source: Database, destination: string) => Promise<unknown>;
  /** @internal Deterministic fault-injection seam. */
  afterLiveClose?: () => void | Promise<void>;
  /** @internal Deterministic fault-injection seam. */
  afterInstall?: () => void | Promise<void>;
  /** @internal Deterministic fault-injection seam. */
  reopenDatabase?: (path: string) => Database;
}

/** A pre-cutover compatibility failure with a stable, value-free code. */
export class RestoreValidationError extends Error {
  readonly code: RestoreValidationErrorCode;

  constructor(code: RestoreValidationErrorCode) {
    super(code);
    this.name = 'RestoreValidationError';
    this.code = code;
  }
}

/**
 * A restore failed after the old handle was closed. When recovery succeeds,
 * `recoveredDatabase` is the reopened original database. If recovery cannot
 * be proven, callers must fail closed; the private rollback snapshot is
 * retained beside the live database for manual recovery.
 */
export class RestoreDatabaseError extends Error {
  readonly code: 'restore_cutover_failed' | 'restore_reopen_failed' | 'restore_recovery_failed';
  readonly recoveredDatabase: Database | undefined;

  constructor(
    code: 'restore_cutover_failed' | 'restore_reopen_failed' | 'restore_recovery_failed',
    recoveredDatabase?: Database,
  ) {
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
  const created = !existsSync(resolved);
  if (created) createPrivateArtifact(resolved);
  try {
    const result = await db.backup(resolved);
    if (created) chmodSync(resolved, 0o600);
    return result;
  } catch (error) {
    if (created) removeArtifact(resolved);
    throw error;
  }
}

interface SchemaRow {
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
}

interface MigrationRow {
  name: unknown;
  appliedAt: unknown;
}

interface DatabaseMetadata {
  mode: number;
  uid: number;
  gid: number;
}

let canonicalDefinition:
  | {
      migrations: string[];
      schema: string;
    }
  | undefined;

function schemaSignature(db: Database): string {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       WHERE substr(name, 1, 7) <> 'sqlite_'
       ORDER BY type, name, tbl_name`,
    )
    .all() as SchemaRow[];
  return JSON.stringify(rows);
}

function currentCanonicalDefinition(): { migrations: string[]; schema: string } {
  if (canonicalDefinition) return canonicalDefinition;
  const canonical = openDatabase(':memory:');
  try {
    canonicalDefinition = {
      migrations: listMigrationFiles(MIGRATIONS_DIR),
      schema: schemaSignature(canonical),
    };
    return canonicalDefinition;
  } finally {
    canonical.close();
  }
}

function validateIntegrity(db: Database): void {
  let result: unknown;
  try {
    result = db.pragma('integrity_check', { simple: true });
  } catch {
    throw new RestoreValidationError('invalid_backup_integrity');
  }
  if (result !== 'ok') {
    throw new RestoreValidationError('invalid_backup_integrity');
  }
}

function recordedMigrations(db: Database): string[] {
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (!table) throw new RestoreValidationError('invalid_backup_migrations');
    const rows = db
      .prepare('SELECT name, applied_at AS appliedAt FROM schema_migrations ORDER BY rowid')
      .all() as MigrationRow[];
    if (
      rows.some(
        (row) =>
          typeof row.name !== 'string' ||
          typeof row.appliedAt !== 'number' ||
          !Number.isSafeInteger(row.appliedAt) ||
          row.appliedAt < 0,
      )
    ) {
      throw new RestoreValidationError('invalid_backup_migrations');
    }
    return rows.map((row) => row.name as string);
  } catch (error) {
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError('invalid_backup_migrations');
  }
}

function validateMigrationPrefix(db: Database, available: string[]): string[] {
  const recorded = recordedMigrations(db);
  if (!isOrderedMigrationPrefix(recorded, available)) {
    throw new RestoreValidationError('invalid_backup_migrations');
  }
  return recorded;
}

function validateCanonicalDatabase(db: Database): void {
  const canonical = currentCanonicalDefinition();
  validateIntegrity(db);
  const migrations = validateMigrationPrefix(db, canonical.migrations);
  if (
    migrations.length !== canonical.migrations.length ||
    migrations.some((name, index) => name !== canonical.migrations[index])
  ) {
    throw new RestoreValidationError('invalid_backup_migrations');
  }
  let foreignKeyViolations: unknown[];
  try {
    foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
  } catch {
    throw new RestoreValidationError('invalid_backup_foreign_keys');
  }
  if (foreignKeyViolations.length !== 0) {
    throw new RestoreValidationError('invalid_backup_foreign_keys');
  }
  if (schemaSignature(db) !== canonical.schema) {
    throw new RestoreValidationError('invalid_backup_schema');
  }
}

function openBackupSource(path: string): Database {
  let probe: Database | undefined;
  try {
    probe = new DatabaseConstructor(path, { readonly: true, fileMustExist: true });
  } catch {
    throw new RestoreValidationError('invalid_backup_file');
  }
  try {
    validateIntegrity(probe);
    validateMigrationPrefix(probe, currentCanonicalDefinition().migrations);
    return probe;
  } catch (error) {
    try {
      probe.close();
    } catch {
      // Preserve the privacy-safe validation error.
    }
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError('invalid_backup_file');
  }
}

/**
 * True when `path` is a complete database at the current canonical schema.
 * Restore additionally supports older known migration prefixes by migrating a
 * private staged copy before performing this same canonical comparison.
 */
export function isVelographBackup(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const probe = openBackupSource(path);
    try {
      validateCanonicalDatabase(probe);
      return true;
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}

function removeSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
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
      // Some platforms cannot open or fsync directory handles. Each database
      // artifact is still fsynced before its atomic rename.
      return;
    }
    throw error;
  }
}

function createPrivateArtifact(path: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    chmodSync(path, 0o600);
  } finally {
    closeSync(fd);
  }
}

function databaseMetadata(path: string): DatabaseMetadata {
  const stats = statSync(path);
  return {
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    gid: stats.gid,
  };
}

function applyDatabaseMetadata(path: string, metadata: DatabaseMetadata): void {
  const current = statSync(path);
  if (current.uid !== metadata.uid || current.gid !== metadata.gid) {
    chownSync(path, metadata.uid, metadata.gid);
  }
  chmodSync(path, metadata.mode);
}

function closeQuietly(db: Database | undefined): void {
  if (!db?.open) return;
  try {
    db.close();
  } catch {
    // Cleanup must not replace a stable restore error.
  }
}

function removeArtifact(path: string): void {
  try {
    removeSidecars(path);
  } catch {
    // Continue with the main artifact cleanup.
  }
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    // A private random-name artifact is safer than masking the restore
    // outcome. An unproven rollback artifact is deliberately retained.
  }
}

function normalizePreCutoverError(error: unknown): RestoreValidationError {
  if (error instanceof RestoreValidationError) return error;
  if (error instanceof Error && error.message === 'wal_checkpoint_busy') {
    return new RestoreValidationError('restore_checkpoint_busy');
  }
  return new RestoreValidationError('restore_stage_failed');
}

function openAndValidateCanonical(path: string): Database {
  let staged: Database;
  try {
    staged = openDatabase(path);
  } catch {
    throw new RestoreValidationError('invalid_backup_migration');
  }
  try {
    validateCanonicalDatabase(staged);
    return staged;
  } catch (error) {
    closeQuietly(staged);
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError('invalid_backup_schema');
  }
}

function reopenOriginal(
  dbPath: string,
  rollbackPath: string,
  replacementInstalled: boolean,
  reopen: (path: string) => Database,
): { database?: Database; rollbackInstalled: boolean } {
  if (!replacementInstalled) {
    try {
      return { database: reopen(dbPath), rollbackInstalled: false };
    } catch {
      // The original path should still be intact. Install the independently
      // validated rollback snapshot if reopening it nevertheless fails.
    }
  }

  try {
    removeSidecars(dbPath);
    renameSync(rollbackPath, dbPath);
    fsyncDirectory(dirname(dbPath));
    removeSidecars(dbPath);
    fsyncDirectory(dirname(dbPath));
  } catch {
    return { rollbackInstalled: false };
  }

  try {
    return { database: reopen(dbPath), rollbackInstalled: true };
  } catch {
    return { rollbackInstalled: true };
  }
}

/**
 * Restore the live database from a backup file. Both incoming stage and
 * original rollback snapshots are produced through SQLite's online backup
 * API, validated, closed, permissioned, and fsynced while `liveDb` remains
 * usable. The final same-directory rename is the replacement commit point.
 *
 * Any failure after the live handle closes reinstalls and reopens the
 * original snapshot. The caller must swap its old handle reference for either
 * the successful return value or `RestoreDatabaseError.recoveredDatabase`.
 */
export async function restoreDatabase(
  liveDb: Database,
  dbPath: string,
  backupPath: string,
  options: RestoreOptions = {},
): Promise<Database> {
  const resolvedBackup = resolve(backupPath);
  const resolvedDbPath = resolve(dbPath);
  const parent = dirname(resolvedDbPath);
  const id = randomUUID();
  const stagedPath = join(parent, `.${basename(resolvedDbPath)}.restore-${id}.tmp`);
  const rollbackPath = join(parent, `.${basename(resolvedDbPath)}.rollback-${id}.tmp`);
  const reopen = options.reopenDatabase ?? openDatabase;
  const source = openBackupSource(resolvedBackup);

  let staged: Database | undefined;
  let rollbackProbe: Database | undefined;
  let liveClosed = false;
  let replacementInstalled = false;
  let rollbackInstalled = false;
  let cleanupRollback = true;
  try {
    mkdirSync(parent, { recursive: true });
    const metadata = databaseMetadata(resolvedDbPath);

    try {
      createPrivateArtifact(stagedPath);
      if (options.stageBackup) {
        await options.stageBackup(source, stagedPath);
      } else {
        await source.backup(stagedPath);
      }
      // SQLite must never inherit a permissive process umask for an artifact
      // that already contains private bytes.
      chmodSync(stagedPath, 0o600);
    } catch {
      throw new RestoreValidationError('restore_stage_failed');
    }

    // Validate the source migration prefix before normal open can add current
    // migrations to the staged copy.
    let preMigration: Database | undefined;
    try {
      preMigration = new DatabaseConstructor(stagedPath, {
        readonly: true,
        fileMustExist: true,
      });
      validateIntegrity(preMigration);
      validateMigrationPrefix(preMigration, currentCanonicalDefinition().migrations);
    } finally {
      closeQuietly(preMigration);
    }

    staged = openAndValidateCanonical(stagedPath);
    checkpointDatabase(staged);
    staged.close();
    staged = undefined;
    removeSidecars(stagedPath);
    applyDatabaseMetadata(stagedPath, metadata);
    fsyncPath(stagedPath);

    // The request barrier is active before this function is called. Refuse
    // an incomplete checkpoint before taking the rollback snapshot or
    // closing the live handle.
    checkpointDatabase(liveDb);
    try {
      createPrivateArtifact(rollbackPath);
      await liveDb.backup(rollbackPath);
      chmodSync(rollbackPath, 0o600);
    } catch {
      throw new RestoreValidationError('restore_rollback_failed');
    }
    rollbackProbe = new DatabaseConstructor(rollbackPath, {
      readonly: true,
      fileMustExist: true,
    });
    validateCanonicalDatabase(rollbackProbe);
    rollbackProbe.close();
    rollbackProbe = undefined;
    removeSidecars(rollbackPath);
    applyDatabaseMetadata(rollbackPath, metadata);
    fsyncPath(rollbackPath);

    try {
      await options.beforeSwap?.();
    } catch {
      throw new RestoreValidationError('restore_stage_failed');
    }

    try {
      liveDb.close();
      liveClosed = true;
    } catch (error) {
      liveClosed = !liveDb.open;
      throw error;
    }

    await options.afterLiveClose?.();

    renameSync(stagedPath, resolvedDbPath);
    replacementInstalled = true;
    fsyncDirectory(parent);
    removeSidecars(resolvedDbPath);
    fsyncDirectory(parent);

    await options.afterInstall?.();

    const restored = reopen(resolvedDbPath);
    removeArtifact(rollbackPath);
    return restored;
  } catch (error) {
    if (!liveClosed) {
      throw normalizePreCutoverError(error);
    }

    const recovery = reopenOriginal(resolvedDbPath, rollbackPath, replacementInstalled, reopen);
    rollbackInstalled = recovery.rollbackInstalled;
    cleanupRollback = recovery.database !== undefined;
    const primaryCode = replacementInstalled ? 'restore_reopen_failed' : 'restore_cutover_failed';
    throw new RestoreDatabaseError(
      recovery.database ? primaryCode : 'restore_recovery_failed',
      recovery.database,
    );
  } finally {
    closeQuietly(staged);
    closeQuietly(rollbackProbe);
    closeQuietly(source);
    removeArtifact(stagedPath);
    if (cleanupRollback || rollbackInstalled) {
      removeArtifact(rollbackPath);
    }
  }
}
