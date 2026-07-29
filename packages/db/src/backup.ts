import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { guardAgainstCheckout } from './datadir.ts';
import { checkpointDatabase, MIGRATIONS_DIR, openDatabase } from './database.ts';
import { isOrderedMigrationPrefix, listMigrationFiles } from './migrate.ts';

export interface BackupResult {
  totalPages: number;
  remainingPages: number;
}

export type BackupValidationErrorCode =
  | 'destination_inside_checkout'
  | 'destination_conflicts_with_live_database'
  | 'invalid_backup_destination';

/** A backup destination failure with a stable, value-free code. */
export class BackupValidationError extends Error {
  readonly code: BackupValidationErrorCode;

  constructor(code: BackupValidationErrorCode) {
    super(code);
    this.name = 'BackupValidationError';
    this.code = code;
  }
}

export interface BackupOptions {
  /** @internal Deterministic fault-injection seam. */
  stageBackup?: (source: Database, destination: string) => Promise<BackupResult>;
  /** @internal Deterministic fault-injection seam. */
  afterInstall?: () => void | Promise<void>;
  /** @internal Deterministic fault-injection seam. */
  syncDirectory?: (path: string) => void;
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

interface FileIdentity {
  dev: number;
  ino: number;
}

interface PreparedBackupTarget {
  target: string;
  parent: string;
  parentIdentity: FileIdentity;
}

interface CrossProcessBackupLock {
  release(): void;
}

const backupDestinationLocks = new Map<string, Promise<void>>();
const BACKUP_LOCK_RETRY_MS = 25;

function validationGuardAgainstCheckout(path: string): void {
  try {
    guardAgainstCheckout(path);
  } catch {
    throw new BackupValidationError('destination_inside_checkout');
  }
}

function canonicalEntryPath(path: string): string {
  const absolute = resolve(path);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    throw new BackupValidationError('invalid_backup_destination');
  }
}

function fileIdentity(path: string): FileIdentity | undefined {
  try {
    const stats = statSync(path);
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

function identitiesMatch(a: FileIdentity | undefined, b: FileIdentity | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

function requiredDirectoryIdentity(path: string): FileIdentity {
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) {
      throw new BackupValidationError('invalid_backup_destination');
    }
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError('invalid_backup_destination');
  }
}

function assertDestinationDoesNotConflictWithLiveDatabase(db: Database, target: string): void {
  if (db.memory || db.name === '' || db.name === ':memory:') return;
  const liveEntries = new Set([canonicalEntryPath(db.name)]);
  try {
    liveEntries.add(realpathSync(resolve(db.name)));
  } catch {
    throw new BackupValidationError('invalid_backup_destination');
  }
  const protectedPaths = [...liveEntries].flatMap((livePath) => [
    livePath,
    `${livePath}-wal`,
    `${livePath}-shm`,
    `${livePath}-journal`,
  ]);
  const targetIdentity = fileIdentity(target);
  if (
    protectedPaths.some(
      (protectedPath) =>
        target === protectedPath || identitiesMatch(targetIdentity, fileIdentity(protectedPath)),
    )
  ) {
    throw new BackupValidationError('destination_conflicts_with_live_database');
  }
}

function backupLockDirectory(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const root = join(tmpdir(), `velograph-backup-locks-${uid ?? 'portable'}`);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new BackupValidationError('invalid_backup_destination');
    }
  }

  try {
    const stats = lstatSync(root);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (uid !== undefined && stats.uid !== uid)
    ) {
      throw new BackupValidationError('invalid_backup_destination');
    }
    chmodSync(root, 0o700);
    return realpathSync(root);
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError('invalid_backup_destination');
  }
}

function pathIsInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function backupLockPath(target: string): string {
  const key = createHash('sha256').update(target).digest('hex');
  return join(backupLockDirectory(), `${key}.sqlite3`);
}

function preparePrivateLockFile(path: string): void {
  try {
    createPrivateArtifact(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new BackupValidationError('invalid_backup_destination');
    }
  }

  try {
    const stats = lstatSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (uid !== undefined && stats.uid !== uid)
    ) {
      throw new BackupValidationError('invalid_backup_destination');
    }
    chmodSync(path, 0o600);
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError('invalid_backup_destination');
  }
}

function isSqliteLockContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

async function acquireCrossProcessBackupLock(target: string): Promise<CrossProcessBackupLock> {
  const path = backupLockPath(target);
  preparePrivateLockFile(path);

  let lockDb: Database | undefined;
  try {
    lockDb = new DatabaseConstructor(path, { timeout: BACKUP_LOCK_RETRY_MS });
    for (;;) {
      try {
        lockDb.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if (!isSqliteLockContention(error)) throw error;
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, BACKUP_LOCK_RETRY_MS);
        });
      }
    }
  } catch {
    closeQuietly(lockDb);
    throw new BackupValidationError('invalid_backup_destination');
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        lockDb?.exec('ROLLBACK');
      } catch {
        // Closing the connection releases the OS-level SQLite lock even when
        // an explicit rollback cannot be completed.
      }
      closeQuietly(lockDb);
    },
  };
}

function assertBackupParentStable(db: Database, prepared: PreparedBackupTarget): void {
  let currentTarget: string;
  try {
    currentTarget = canonicalEntryPath(prepared.target);
  } catch {
    throw new BackupValidationError('invalid_backup_destination');
  }
  if (
    currentTarget !== prepared.target ||
    !identitiesMatch(prepared.parentIdentity, fileIdentity(prepared.parent))
  ) {
    throw new BackupValidationError('invalid_backup_destination');
  }
  assertDestinationDoesNotConflictWithLiveDatabase(db, prepared.target);
}

function backupParentIsStable(db: Database, prepared: PreparedBackupTarget): boolean {
  try {
    assertBackupParentStable(db, prepared);
    return true;
  } catch {
    return false;
  }
}

async function withBackupDestinationLock<T>(
  db: Database,
  prepared: PreparedBackupTarget,
  operation: () => Promise<T>,
): Promise<T> {
  const target = prepared.target;
  const previous = backupDestinationLocks.get(target) ?? Promise.resolve();
  let release!: () => void;
  const ownTurn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.then(() => ownTurn);
  backupDestinationLocks.set(target, tail);
  await previous;
  let crossProcessLock: CrossProcessBackupLock | undefined;
  try {
    crossProcessLock = await acquireCrossProcessBackupLock(target);
    assertBackupParentStable(db, prepared);
    return await operation();
  } finally {
    crossProcessLock?.release();
    release();
    if (backupDestinationLocks.get(target) === tail) {
      backupDestinationLocks.delete(target);
    }
  }
}

function prepareBackupTarget(db: Database, destPath: string): PreparedBackupTarget {
  const lexicalTarget = resolve(destPath);
  const lexicalParent = dirname(lexicalTarget);
  validationGuardAgainstCheckout(lexicalParent);
  try {
    mkdirSync(lexicalParent, { recursive: true });
  } catch {
    throw new BackupValidationError('invalid_backup_destination');
  }
  const target = canonicalEntryPath(lexicalTarget);
  const parent = dirname(target);
  validationGuardAgainstCheckout(parent);
  if (pathIsInside(target, backupLockDirectory())) {
    throw new BackupValidationError('invalid_backup_destination');
  }
  assertDestinationDoesNotConflictWithLiveDatabase(db, target);
  return {
    target,
    parent,
    parentIdentity: requiredDirectoryIdentity(parent),
  };
}

/**
 * Export the live database to `destPath` using SQLite's online backup API
 * (PRD: backups use the backup API, never a copy of a live WAL database's
 * files). The destination is serialized per canonical path, must stay outside
 * a git checkout, and cannot alias the live database or any SQLite sidecar.
 */
export async function backupDatabase(
  db: Database,
  destPath: string,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const prepared = prepareBackupTarget(db, destPath);
  return withBackupDestinationLock(db, prepared, () =>
    backupDatabaseAtTarget(db, prepared, options),
  );
}

async function backupDatabaseAtTarget(
  db: Database,
  prepared: PreparedBackupTarget,
  options: BackupOptions,
): Promise<BackupResult> {
  const resolved = prepared.target;
  const parent = prepared.parent;
  const syncDirectory = options.syncDirectory ?? fsyncDirectory;
  const id = randomUUID();
  const stagedPath = join(parent, `.${basename(resolved)}.backup-${id}.tmp`);
  const previousPath = join(parent, `.${basename(resolved)}.previous-${id}.tmp`);
  const recoveryPath = join(parent, `.${basename(resolved)}.previous-install-${id}.tmp`);
  assertBackupParentStable(db, prepared);
  const hadPrevious = existsSync(resolved);
  let installed = false;
  let installedIdentity: FileIdentity | undefined;
  let previousRestored = false;
  try {
    if (hadPrevious) {
      assertBackupParentStable(db, prepared);
      createPrivateArtifact(previousPath);
      copyFileSync(resolved, previousPath);
      chmodSync(previousPath, 0o600);
      fsyncPath(previousPath);
      assertBackupParentStable(db, prepared);
    }

    assertBackupParentStable(db, prepared);
    createPrivateArtifact(stagedPath);
    const result = options.stageBackup
      ? await options.stageBackup(db, stagedPath)
      : await db.backup(stagedPath);
    // A non-cooperating process can replace the parent while SQLite has the
    // destination open. Reassert private mode before any validation that may
    // reject the changed parent, so a retained random-name stage is not left
    // broader than the source database.
    chmodSync(stagedPath, 0o600);
    assertBackupParentStable(db, prepared);

    let probe: Database | undefined;
    try {
      probe = new DatabaseConstructor(stagedPath, {
        readonly: true,
        fileMustExist: true,
      });
      validateCanonicalDatabase(probe);
    } finally {
      closeQuietly(probe);
    }
    removeSidecars(stagedPath);
    fsyncPath(stagedPath);

    // Node does not expose renameat(2), so bind the pathname to the originally
    // verified directory identity immediately before and after the single
    // synchronous rename. This closes observable symlink/directory swaps
    // during asynchronous staging while keeping the install same-filesystem.
    assertBackupParentStable(db, prepared);
    renameSync(stagedPath, resolved);
    installed = true;
    installedIdentity = fileIdentity(resolved);
    assertBackupParentStable(db, prepared);
    syncDirectory(parent);
    await options.afterInstall?.();
    assertBackupParentStable(db, prepared);

    removeArtifact(previousPath);
    return result;
  } catch (error) {
    if (installed && backupParentIsStable(db, prepared)) {
      try {
        // Another writer may have replaced this operation's inode. Never
        // roll back or delete a later successful backup.
        if (identitiesMatch(installedIdentity, fileIdentity(resolved))) {
          if (hadPrevious) {
            createPrivateArtifact(recoveryPath);
            copyFileSync(previousPath, recoveryPath);
            chmodSync(recoveryPath, 0o600);
            fsyncPath(recoveryPath);
            assertBackupParentStable(db, prepared);
            renameSync(recoveryPath, resolved);
            assertBackupParentStable(db, prepared);
            syncDirectory(parent);
            previousRestored = true;
          } else {
            assertBackupParentStable(db, prepared);
            removeArtifact(resolved);
            syncDirectory(parent);
          }
        }
      } catch {
        // The independently fsynced previous snapshot remains private and
        // separate when it cannot be reinstalled. Preserve the primary
        // failure; never delete the only known-good prior backup.
      }
    }
    throw error;
  } finally {
    // Do not follow a destination parent that changed identity during the
    // operation. The random private artifacts are safer retained than cleanup
    // through an untrusted replacement path.
    if (backupParentIsStable(db, prepared)) {
      removeArtifact(stagedPath);
      removeArtifact(recoveryPath);
      if (!hadPrevious || !installed || previousRestored) {
        removeArtifact(previousPath);
      }
    }
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

function applyRecoveryArtifactMetadata(path: string, metadata: DatabaseMetadata): void {
  const current = statSync(path);
  if (current.uid !== metadata.uid || current.gid !== metadata.gid) {
    chownSync(path, metadata.uid, metadata.gid);
  }
  chmodSync(path, 0o600);
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

async function reopenOriginal(
  dbPath: string,
  rollbackPath: string,
  recoveryInstallPath: string,
  metadata: DatabaseMetadata,
  replacementInstalled: boolean,
  reopen: (path: string) => Database,
): Promise<Database | undefined> {
  if (!replacementInstalled) {
    try {
      return reopen(dbPath);
    } catch {
      // The original path should still be intact. Install the independently
      // validated rollback snapshot from a copy if reopening nevertheless
      // fails, while retaining the source snapshot separately.
    }
  }

  let source: Database | undefined;
  let recoveryProbe: Database | undefined;
  try {
    createPrivateArtifact(recoveryInstallPath);
    source = openBackupSource(rollbackPath);
    await source.backup(recoveryInstallPath);
    closeQuietly(source);
    source = undefined;
    chmodSync(recoveryInstallPath, 0o600);

    recoveryProbe = new DatabaseConstructor(recoveryInstallPath, {
      readonly: true,
      fileMustExist: true,
    });
    validateCanonicalDatabase(recoveryProbe);
    recoveryProbe.close();
    recoveryProbe = undefined;
    removeSidecars(recoveryInstallPath);
    applyDatabaseMetadata(recoveryInstallPath, metadata);
    fsyncPath(recoveryInstallPath);

    removeSidecars(dbPath);
    renameSync(recoveryInstallPath, dbPath);
    fsyncDirectory(dirname(dbPath));
    removeSidecars(dbPath);
    fsyncDirectory(dirname(dbPath));
  } catch {
    return undefined;
  } finally {
    closeQuietly(recoveryProbe);
    closeQuietly(source);
    try {
      removeSidecars(rollbackPath);
    } catch {
      // Keep the validated main recovery snapshot even if sidecar cleanup
      // cannot be completed.
    }
    removeArtifact(recoveryInstallPath);
  }

  try {
    return reopen(dbPath);
  } catch {
    return undefined;
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
  const recoveryInstallPath = join(parent, `.${basename(resolvedDbPath)}.recovery-${id}.tmp`);
  const reopen = options.reopenDatabase ?? openDatabase;
  const source = openBackupSource(resolvedBackup);

  let staged: Database | undefined;
  let rollbackProbe: Database | undefined;
  let metadata: DatabaseMetadata | undefined;
  let liveClosed = false;
  let replacementInstalled = false;
  let cleanupRollback = true;
  try {
    mkdirSync(parent, { recursive: true });
    metadata = databaseMetadata(resolvedDbPath);

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
    applyRecoveryArtifactMetadata(rollbackPath, metadata);
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

    const recoveredDatabase = await reopenOriginal(
      resolvedDbPath,
      rollbackPath,
      recoveryInstallPath,
      metadata!,
      replacementInstalled,
      reopen,
    );
    cleanupRollback = recoveredDatabase !== undefined;
    const primaryCode = replacementInstalled ? 'restore_reopen_failed' : 'restore_cutover_failed';
    throw new RestoreDatabaseError(
      recoveredDatabase ? primaryCode : 'restore_recovery_failed',
      recoveredDatabase,
    );
  } finally {
    closeQuietly(staged);
    closeQuietly(rollbackProbe);
    closeQuietly(source);
    removeArtifact(stagedPath);
    removeArtifact(recoveryInstallPath);
    if (cleanupRollback) {
      removeArtifact(rollbackPath);
    }
  }
}
