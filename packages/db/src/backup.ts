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
  rollbackBackup?: (source: Database, destination: string) => Promise<unknown>;
  /** @internal Deterministic fault-injection seam. */
  afterLiveClose?: () => void | Promise<void>;
  /** @internal Deterministic fault-injection seam. */
  afterInstall?: () => void | Promise<void>;
  /** @internal Deterministic fault-injection seam after a safe existing-file reopen. */
  afterReopen?: (db: Database) => void;
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
 * be proven, callers must fail closed; the private rollback snapshot remains
 * in its protected operation directory for manual recovery.
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
  dev: bigint;
  ino: bigint;
}

interface PreparedBackupTarget {
  target: string;
  parent: string;
  parentIdentity: FileIdentity;
  lockKey: string;
}

interface PreparedRestoreTarget {
  target: string;
  parent: string;
  parentIdentity: FileIdentity;
  originalIdentity: FileIdentity;
}

interface PrivateOperationDirectory {
  path: string;
  parent: string;
  parentIdentity: FileIdentity;
  identity: FileIdentity;
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
    const stats = statSync(path, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

function identitiesMatch(a: FileIdentity | undefined, b: FileIdentity | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

function stableCanonicalDirectory(path: string, expected: FileIdentity): boolean {
  try {
    const stats = lstatSync(path);
    const identity = lstatSync(path, { bigint: true });
    return (
      !stats.isSymbolicLink() &&
      stats.isDirectory() &&
      realpathSync(path) === path &&
      identitiesMatch(expected, { dev: identity.dev, ino: identity.ino })
    );
  } catch {
    return false;
  }
}

function requiredDirectoryIdentity(path: string): FileIdentity {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(path) !== path) {
      throw new BackupValidationError('invalid_backup_destination');
    }
    const identity = lstatSync(path, { bigint: true });
    return { dev: identity.dev, ino: identity.ino };
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

function backupLockPath(lockKey: string): string {
  const key = createHash('sha256').update(lockKey).digest('hex');
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

async function acquireCrossProcessBackupLock(lockKey: string): Promise<CrossProcessBackupLock> {
  const path = backupLockPath(lockKey);
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
    !stableCanonicalDirectory(prepared.parent, prepared.parentIdentity)
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
  const lockKey = prepared.lockKey;
  const previous = backupDestinationLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const ownTurn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.then(() => ownTurn);
  backupDestinationLocks.set(lockKey, tail);
  await previous;
  let crossProcessLock: CrossProcessBackupLock | undefined;
  try {
    crossProcessLock = await acquireCrossProcessBackupLock(lockKey);
    assertBackupParentStable(db, prepared);
    return await operation();
  } finally {
    crossProcessLock?.release();
    release();
    if (backupDestinationLocks.get(lockKey) === tail) {
      backupDestinationLocks.delete(lockKey);
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
  const parentIdentity = requiredDirectoryIdentity(parent);
  return {
    target,
    parent,
    parentIdentity,
    // macOS commonly uses a case-insensitive filesystem. Conservatively lock
    // the verified parent directory rather than a case-sensitive spelling of
    // one entry so aliases cannot acquire independent process locks.
    lockKey: `parent:${parentIdentity.dev}:${parentIdentity.ino}`,
  };
}

/**
 * Export the live database to `destPath` using SQLite's online backup API
 * (PRD: backups use the backup API, never a copy of a live WAL database's
 * files). Operations are conservatively serialized per verified parent
 * identity so case aliases cannot bypass the lock. The destination must stay
 * outside a git checkout and cannot alias the live database or a sidecar.
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
  assertBackupParentStable(db, prepared);
  const hadPrevious = existsSync(resolved);
  let operationDirectory: PrivateOperationDirectory | undefined;
  let stagedPath: string | undefined;
  let previousPath: string | undefined;
  let recoveryPath: string | undefined;
  let installed = false;
  let stagedIdentity!: FileIdentity;
  let installedIdentity: FileIdentity | undefined;
  let previousRestored = false;
  let previousSnapshotCreated = false;
  let retainOperationDirectory = false;
  try {
    try {
      operationDirectory = createPrivateOperationDirectory(
        parent,
        prepared.parentIdentity,
        'backup',
      );
      assertBackupOperationStable(db, prepared, operationDirectory);
    } catch (error) {
      if (error instanceof BackupValidationError) throw error;
      throw new BackupValidationError('invalid_backup_destination');
    }
    stagedPath = join(operationDirectory.path, 'stage.sqlite3');
    previousPath = join(operationDirectory.path, 'previous.sqlite3');
    recoveryPath = join(operationDirectory.path, 'recovery.sqlite3');

    if (hadPrevious) {
      assertBackupOperationStable(db, prepared, operationDirectory);
      createPrivateArtifact(previousPath);
      assertBackupOperationStable(db, prepared, operationDirectory);
      copyFileSync(resolved, previousPath);
      chmodSync(previousPath, 0o600);
      fsyncPath(previousPath);
      previousSnapshotCreated = true;
      assertBackupOperationStable(db, prepared, operationDirectory);
    }

    assertBackupOperationStable(db, prepared, operationDirectory);
    createPrivateArtifact(stagedPath);
    assertBackupOperationStable(db, prepared, operationDirectory);
    let result: BackupResult;
    try {
      result = options.stageBackup
        ? await options.stageBackup(db, stagedPath)
        : await db.backup(stagedPath);
    } catch (error) {
      if (!backupOperationIsStable(db, prepared, operationDirectory)) {
        throw new BackupValidationError('invalid_backup_destination');
      }
      throw error;
    }
    chmodSync(stagedPath, 0o600);
    assertBackupOperationStable(db, prepared, operationDirectory);

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
    stagedIdentity = requiredRegularFileIdentity(stagedPath);

    // Node does not expose renameat(2), so bind the pathname to the originally
    // verified directory identity immediately before and after the single
    // synchronous rename. This closes observable symlink/directory swaps
    // during asynchronous staging while keeping the install same-filesystem.
    assertBackupOperationStable(db, prepared, operationDirectory);
    renameSync(stagedPath, resolved);
    installed = true;
    installedIdentity = stagedIdentity;
    if (!regularFileHasIdentity(resolved, installedIdentity)) {
      throw new BackupValidationError('invalid_backup_destination');
    }
    assertBackupParentStable(db, prepared);
    syncDirectory(parent);
    await options.afterInstall?.();
    assertBackupParentStable(db, prepared);

    return result;
  } catch (error) {
    if (
      installed &&
      operationDirectory &&
      previousPath &&
      recoveryPath &&
      backupOperationIsStable(db, prepared, operationDirectory)
    ) {
      try {
        // Another writer may have replaced this operation's inode. Never
        // roll back or delete a later successful backup.
        if (identitiesMatch(installedIdentity, fileIdentity(resolved))) {
          if (hadPrevious) {
            createPrivateArtifact(recoveryPath);
            assertBackupOperationStable(db, prepared, operationDirectory);
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
    retainOperationDirectory =
      installed && hadPrevious && previousSnapshotCreated && !previousRestored;
    if (!backupParentIsStable(db, prepared) && !(error instanceof BackupValidationError)) {
      throw new BackupValidationError('invalid_backup_destination');
    }
    throw error;
  } finally {
    // Do not follow a destination parent or operation directory that changed
    // identity. A retained mode-0700 directory is safer than cleanup through
    // an untrusted replacement path.
    if (operationDirectory && !retainOperationDirectory) {
      removePrivateOperationDirectory(operationDirectory);
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

function createPrivateOperationDirectory(
  parent: string,
  parentIdentity: FileIdentity,
  kind: 'backup' | 'restore',
): PrivateOperationDirectory {
  if (!stableCanonicalDirectory(parent, parentIdentity)) {
    throw new Error('operation_parent_invalid');
  }
  const path = join(parent, `.velograph-${kind}-${randomUUID()}`);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  const stats = lstatSync(path);
  const identity = lstatSync(path, { bigint: true });
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o777) !== 0o700 ||
    (uid !== undefined && stats.uid !== uid)
  ) {
    throw new Error('private_operation_directory_invalid');
  }
  if (!stableCanonicalDirectory(parent, parentIdentity)) {
    throw new Error('operation_parent_changed');
  }
  return {
    path,
    parent,
    parentIdentity,
    identity: { dev: identity.dev, ino: identity.ino },
  };
}

function privateOperationDirectoryIsStable(operation: PrivateOperationDirectory): boolean {
  if (!stableCanonicalDirectory(operation.parent, operation.parentIdentity)) return false;
  try {
    const stats = lstatSync(operation.path);
    const identity = lstatSync(operation.path, { bigint: true });
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    return (
      !stats.isSymbolicLink() &&
      stats.isDirectory() &&
      (stats.mode & 0o777) === 0o700 &&
      (uid === undefined || stats.uid === uid) &&
      identitiesMatch(operation.identity, { dev: identity.dev, ino: identity.ino })
    );
  } catch {
    return false;
  }
}

function assertBackupOperationStable(
  db: Database,
  prepared: PreparedBackupTarget,
  operation: PrivateOperationDirectory,
): void {
  assertBackupParentStable(db, prepared);
  if (!privateOperationDirectoryIsStable(operation)) {
    throw new BackupValidationError('invalid_backup_destination');
  }
}

function backupOperationIsStable(
  db: Database,
  prepared: PreparedBackupTarget,
  operation: PrivateOperationDirectory,
): boolean {
  try {
    assertBackupOperationStable(db, prepared, operation);
    return true;
  } catch {
    return false;
  }
}

function removePrivateOperationDirectory(operation: PrivateOperationDirectory): void {
  if (!privateOperationDirectoryIsStable(operation)) return;
  try {
    rmSync(operation.path, { recursive: true, force: true });
  } catch {
    // A private random-name directory is safer than masking the operation
    // outcome or following a replacement path during cleanup.
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

function requiredRegularFileIdentity(path: string): FileIdentity {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('regular_file_identity_invalid');
  }
  const identity = lstatSync(path, { bigint: true });
  return { dev: identity.dev, ino: identity.ino };
}

function regularFileHasIdentity(path: string, expected: FileIdentity): boolean {
  try {
    const stats = lstatSync(path);
    const identity = lstatSync(path, { bigint: true });
    return (
      !stats.isSymbolicLink() &&
      stats.isFile() &&
      identitiesMatch(expected, { dev: identity.dev, ino: identity.ino })
    );
  } catch {
    return false;
  }
}

function prepareRestoreTarget(liveDb: Database, dbPath: string): PreparedRestoreTarget {
  try {
    if (!liveDb.open || liveDb.memory || liveDb.name === '' || liveDb.name === ':memory:') {
      throw new Error('restore_requires_file_database');
    }
    const liveTarget = realpathSync(resolve(liveDb.name));
    const parent = dirname(liveTarget);
    const parentIdentity = requiredRawDirectoryIdentity(parent);
    const originalIdentity = requiredRegularFileIdentity(liveTarget);
    const target = realpathSync(resolve(dbPath));
    if (
      target !== liveTarget ||
      !identitiesMatch(originalIdentity, requiredRegularFileIdentity(target))
    ) {
      throw new Error('restore_live_database_mismatch');
    }
    const prepared = {
      target,
      parent,
      parentIdentity,
      originalIdentity,
    };
    if (!restoreTargetIsStable(prepared, originalIdentity)) {
      throw new Error('restore_parent_invalid');
    }
    return prepared;
  } catch {
    throw new RestoreValidationError('restore_stage_failed');
  }
}

function requiredRawDirectoryIdentity(path: string): FileIdentity {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(path) !== path) {
    throw new Error('directory_identity_invalid');
  }
  const identity = lstatSync(path, { bigint: true });
  return { dev: identity.dev, ino: identity.ino };
}

function restoreTargetIsStable(
  prepared: PreparedRestoreTarget,
  expectedIdentity: FileIdentity,
): boolean {
  if (!stableCanonicalDirectory(prepared.parent, prepared.parentIdentity)) return false;
  try {
    return (
      realpathSync(prepared.target) === prepared.target &&
      regularFileHasIdentity(prepared.target, expectedIdentity)
    );
  } catch {
    return false;
  }
}

function assertRestoreTargetStable(
  prepared: PreparedRestoreTarget,
  expectedIdentity: FileIdentity,
): void {
  if (!restoreTargetIsStable(prepared, expectedIdentity)) {
    throw new Error('restore_target_changed');
  }
}

function restoreOperationIsStable(
  prepared: PreparedRestoreTarget,
  operation: PrivateOperationDirectory,
  expectedIdentity: FileIdentity,
): boolean {
  return (
    restoreTargetIsStable(prepared, expectedIdentity) &&
    privateOperationDirectoryIsStable(operation)
  );
}

function assertRestoreOperationStable(
  prepared: PreparedRestoreTarget,
  operation: PrivateOperationDirectory,
  expectedIdentity: FileIdentity,
): void {
  assertRestoreTargetStable(prepared, expectedIdentity);
  if (!privateOperationDirectoryIsStable(operation)) {
    throw new Error('restore_operation_directory_changed');
  }
}

function openExpectedCanonicalDatabase(
  prepared: PreparedRestoreTarget,
  expectedIdentity: FileIdentity,
  afterReopen?: (db: Database) => void,
): Database {
  assertRestoreTargetStable(prepared, expectedIdentity);
  let reopened: Database | undefined;
  try {
    reopened = new DatabaseConstructor(prepared.target, { fileMustExist: true });
    assertRestoreTargetStable(prepared, expectedIdentity);
    if (
      reopened.memory ||
      reopened.name === '' ||
      reopened.name === ':memory:' ||
      realpathSync(resolve(reopened.name)) !== prepared.target
    ) {
      throw new Error('restore_reopen_identity_mismatch');
    }
    validateCanonicalDatabase(reopened);
    reopened.pragma('foreign_keys = ON');
    reopened.pragma('synchronous = NORMAL');
    if (reopened.pragma('journal_mode', { simple: true }) !== 'wal') {
      reopened.pragma('journal_mode = WAL');
    }
    afterReopen?.(reopened);
    if (!reopened.open) {
      throw new Error('restore_reopen_closed');
    }
    assertRestoreTargetStable(prepared, expectedIdentity);
    return reopened;
  } catch (error) {
    closeQuietly(reopened);
    throw error;
  }
}

async function reopenOriginal(
  prepared: PreparedRestoreTarget,
  operation: PrivateOperationDirectory,
  rollbackPath: string,
  rollbackIdentity: FileIdentity,
  recoveryInstallPath: string,
  metadata: DatabaseMetadata,
  replacementInstalled: boolean,
  installedIdentity: FileIdentity | undefined,
  afterReopen?: (db: Database) => void,
): Promise<Database | undefined> {
  if (!replacementInstalled) {
    try {
      return openExpectedCanonicalDatabase(prepared, prepared.originalIdentity, afterReopen);
    } catch {
      // The original path should still be intact. Install the independently
      // validated rollback snapshot from a copy if reopening nevertheless
      // fails, while retaining the source snapshot separately.
    }
  }

  const currentIdentity = replacementInstalled ? installedIdentity : prepared.originalIdentity;
  if (
    !currentIdentity ||
    !restoreOperationIsStable(prepared, operation, currentIdentity) ||
    !regularFileHasIdentity(rollbackPath, rollbackIdentity)
  ) {
    return undefined;
  }

  let source: Database | undefined;
  let recoveryProbe: Database | undefined;
  try {
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    createPrivateArtifact(recoveryInstallPath);
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    source = openBackupSource(rollbackPath);
    await source.backup(recoveryInstallPath);
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    if (!regularFileHasIdentity(rollbackPath, rollbackIdentity)) {
      throw new Error('restore_rollback_identity_changed');
    }
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
    const recoveryIdentity = requiredRegularFileIdentity(recoveryInstallPath);

    assertRestoreOperationStable(prepared, operation, currentIdentity);
    removeSidecars(prepared.target);
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    renameSync(recoveryInstallPath, prepared.target);
    assertRestoreTargetStable(prepared, recoveryIdentity);
    fsyncDirectory(prepared.parent);
    removeSidecars(prepared.target);
    assertRestoreTargetStable(prepared, recoveryIdentity);
    fsyncDirectory(prepared.parent);
    return openExpectedCanonicalDatabase(prepared, recoveryIdentity, afterReopen);
  } catch {
    return undefined;
  } finally {
    closeQuietly(recoveryProbe);
    closeQuietly(source);
    if (privateOperationDirectoryIsStable(operation)) {
      try {
        removeSidecars(rollbackPath);
      } catch {
        // Keep the validated main recovery snapshot even if sidecar cleanup
        // cannot be completed.
      }
    }
  }
}

/**
 * Restore the live database from a backup file. Both incoming stage and
 * original rollback snapshots are produced through SQLite's online backup
 * API inside a verified mode-0700 operation directory, validated, closed,
 * permissioned, and fsynced while `liveDb` remains usable. The canonical live
 * parent and expected inode are checked around each asynchronous boundary.
 * The final same-filesystem rename is the replacement commit point.
 *
 * Any failure after the live handle closes reinstalls and reopens the original
 * snapshot only when the parent and expected inode remain bound. Reopen always
 * requires an existing canonical database. The caller must swap its old
 * handle reference for either the successful return value or
 * `RestoreDatabaseError.recoveredDatabase`.
 */
export async function restoreDatabase(
  liveDb: Database,
  dbPath: string,
  backupPath: string,
  options: RestoreOptions = {},
): Promise<Database> {
  const prepared = prepareRestoreTarget(liveDb, dbPath);
  const resolvedBackup = resolve(backupPath);
  const source = openBackupSource(resolvedBackup);

  let operationDirectory: PrivateOperationDirectory | undefined;
  let stagedPath: string | undefined;
  let rollbackPath: string | undefined;
  let recoveryInstallPath: string | undefined;
  let staged: Database | undefined;
  let rollbackProbe: Database | undefined;
  let metadata: DatabaseMetadata | undefined;
  let stagedIdentity!: FileIdentity;
  let rollbackIdentity: FileIdentity | undefined;
  let liveClosed = false;
  let replacementInstalled = false;
  let installedIdentity: FileIdentity | undefined;
  let retainOperationDirectory = false;
  try {
    try {
      operationDirectory = createPrivateOperationDirectory(
        prepared.parent,
        prepared.parentIdentity,
        'restore',
      );
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    } catch {
      throw new RestoreValidationError('restore_stage_failed');
    }
    stagedPath = join(operationDirectory.path, 'stage.sqlite3');
    rollbackPath = join(operationDirectory.path, 'rollback.sqlite3');
    recoveryInstallPath = join(operationDirectory.path, 'recovery.sqlite3');
    metadata = databaseMetadata(prepared.target);

    try {
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      createPrivateArtifact(stagedPath);
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      if (options.stageBackup) {
        await options.stageBackup(source, stagedPath);
      } else {
        await source.backup(stagedPath);
      }
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
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
    stagedIdentity = requiredRegularFileIdentity(stagedPath);
    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);

    // The request barrier is active before this function is called. Refuse
    // an incomplete checkpoint before taking the rollback snapshot or
    // closing the live handle.
    checkpointDatabase(liveDb);
    try {
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      createPrivateArtifact(rollbackPath);
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      if (options.rollbackBackup) {
        await options.rollbackBackup(liveDb, rollbackPath);
      } else {
        await liveDb.backup(rollbackPath);
      }
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
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
    rollbackIdentity = requiredRegularFileIdentity(rollbackPath);
    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);

    try {
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      await options.beforeSwap?.();
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    } catch {
      throw new RestoreValidationError('restore_stage_failed');
    }

    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    try {
      liveDb.close();
      liveClosed = true;
    } catch (error) {
      liveClosed = !liveDb.open;
      throw error;
    }

    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    await options.afterLiveClose?.();
    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);

    renameSync(stagedPath, prepared.target);
    replacementInstalled = true;
    installedIdentity = stagedIdentity;
    assertRestoreOperationStable(prepared, operationDirectory, installedIdentity);
    fsyncDirectory(prepared.parent);
    removeSidecars(prepared.target);
    assertRestoreOperationStable(prepared, operationDirectory, installedIdentity);
    fsyncDirectory(prepared.parent);

    assertRestoreOperationStable(prepared, operationDirectory, installedIdentity);
    await options.afterInstall?.();
    assertRestoreOperationStable(prepared, operationDirectory, installedIdentity);

    const restored = openExpectedCanonicalDatabase(
      prepared,
      installedIdentity,
      options.afterReopen,
    );
    return restored;
  } catch (error) {
    if (!liveClosed) {
      throw normalizePreCutoverError(error);
    }

    const recoveredDatabase =
      operationDirectory && rollbackPath && rollbackIdentity && recoveryInstallPath && metadata
        ? await reopenOriginal(
            prepared,
            operationDirectory,
            rollbackPath,
            rollbackIdentity,
            recoveryInstallPath,
            metadata,
            replacementInstalled,
            installedIdentity,
            options.afterReopen,
          )
        : undefined;
    retainOperationDirectory = recoveredDatabase === undefined;
    const primaryCode = replacementInstalled ? 'restore_reopen_failed' : 'restore_cutover_failed';
    throw new RestoreDatabaseError(
      recoveredDatabase ? primaryCode : 'restore_recovery_failed',
      recoveredDatabase,
    );
  } finally {
    closeQuietly(staged);
    closeQuietly(rollbackProbe);
    closeQuietly(source);
    if (operationDirectory && !retainOperationDirectory) {
      removePrivateOperationDirectory(operationDirectory);
    }
  }
}
