import { describe, expect, it } from 'vitest';
import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointDatabase, MIGRATIONS_DIR, openDatabase } from './database.ts';
import { listMigrations, readAppliedMigrations } from './migrate.ts';
import { Repository } from './repository.ts';
import {
  BackupValidationError,
  RestoreDatabaseError,
  RestoreValidationError,
  backupDatabase,
  isVelographBackup,
  restoreDatabase,
  restoreDatabaseWithReport,
  type BackupValidationErrorCode,
  type RestoreOptions,
  type RestoreValidationErrorCode,
} from './backup.ts';

// Backups contain real health data (PRD §12.2) — every temp dir here is
// created outside the checkout via the OS temp directory, never under the
// repo, and is removed at the end of each test.

const BACKUP_LOCK_CHILD = fileURLToPath(new URL('./backup-lock-child.ts', import.meta.url));

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'velo-backup-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });
  }
  throw new Error('test_barrier_timeout');
}

async function waitForEitherPath(
  expectedPath: string,
  unexpectedPath: string,
): Promise<'expected' | 'unexpected'> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(unexpectedPath)) return 'unexpected';
    if (existsSync(expectedPath)) return 'expected';
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });
  }
  throw new Error('test_barrier_timeout');
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  if (!child.stderr) throw new Error('child_stderr_unavailable');
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('exit', (code) => resolveChild({ code, stderr }));
  });
}

function operationFiles(dir: string, kind: 'backup' | 'restore'): string[] {
  const files: string[] = [];
  const walk = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryRelative = join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(join(current, entry.name), entryRelative);
      } else if (entry.isFile()) {
        files.push(entryRelative);
      }
    }
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(`.velograph-${kind}-`)) {
      walk(join(dir, entry.name), entry.name);
    }
  }
  return files.sort();
}

function operationDirectories(dir: string, kind: 'backup' | 'restore'): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`.velograph-${kind}-`))
    .sort();
}

function restoreArtifacts(dir: string): string[] {
  return operationFiles(dir, 'restore');
}

function backupArtifacts(dir: string): string[] {
  return operationFiles(dir, 'backup');
}

async function expectValidationError(
  operation: Promise<unknown>,
  code: RestoreValidationErrorCode,
): Promise<void> {
  try {
    await operation;
    throw new Error('expected_restore_to_fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreValidationError);
    expect((error as RestoreValidationError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

async function expectBackupValidationError(
  operation: Promise<unknown>,
  code: BackupValidationErrorCode,
): Promise<void> {
  try {
    await operation;
    throw new Error('expected_backup_to_fail');
  } catch (error) {
    expect(error).toBeInstanceOf(BackupValidationError);
    expect((error as BackupValidationError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

function writeRestoreState(db: Database, value: string): void {
  db.prepare(
    `INSERT INTO user_settings (key, value_json) VALUES ('restore-state', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
  ).run(JSON.stringify(value));
}

function readRestoreState(db: Database): string {
  const row = db
    .prepare("SELECT value_json FROM user_settings WHERE key = 'restore-state'")
    .get() as { value_json: string };
  return JSON.parse(row.value_json) as string;
}

async function createRestoreScenario(dir: string): Promise<{
  db: Database;
  dbPath: string;
  backupPath: string;
}> {
  const dbPath = join(dir, 'live.sqlite3');
  const backupPath = join(dir, 'exported.sqlite3');
  const db = openDatabase(dbPath);
  writeRestoreState(db, 'from-backup');
  await backupDatabase(db, backupPath);
  writeRestoreState(db, 'current-live');
  return { db, dbPath, backupPath };
}

async function expectRecoveredOriginal(
  dir: string,
  options: RestoreOptions,
  expectedCode: 'restore_cutover_failed' | 'restore_reopen_failed',
): Promise<void> {
  const { db, dbPath, backupPath } = await createRestoreScenario(dir);
  chmodSync(dbPath, 0o600);
  let recovered: Database | undefined;
  try {
    await restoreDatabase(db, dbPath, backupPath, options);
    throw new Error('expected_restore_to_fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreDatabaseError);
    const restoreError = error as RestoreDatabaseError;
    expect(restoreError.code).toBe(expectedCode);
    expect(restoreError.message).toBe(expectedCode);
    recovered = restoreError.recoveredDatabase;
  }
  expect(db.open).toBe(false);
  expect(recovered?.open).toBe(true);
  expect(readRestoreState(recovered!)).toBe('current-live');
  expect(recovered!.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  expect(restoreArtifacts(dir)).toEqual([]);
  recovered!.close();
}

describe('backupDatabase / restoreDatabase', () => {
  it('rejects a WAL checkpoint that another connection keeps busy', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'busy.sqlite3');
      const writer = openDatabase(dbPath);
      const reader = openDatabase(dbPath);
      try {
        writer.pragma('busy_timeout = 1');
        writer
          .prepare("INSERT INTO user_settings (key, value_json) VALUES ('checkpoint', '1')")
          .run();
        reader.exec('BEGIN');
        reader.prepare("SELECT value_json FROM user_settings WHERE key = 'checkpoint'").get();
        writer.prepare("UPDATE user_settings SET value_json = '2' WHERE key = 'checkpoint'").run();

        expect(() => checkpointDatabase(writer)).toThrow('wal_checkpoint_busy');
      } finally {
        reader.exec('ROLLBACK');
        reader.close();
        checkpointDatabase(writer);
        writer.close();
      }
    }));

  it('round-trips to an identical database via the SQLite backup API', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const backupPath = join(dir, 'exported.sqlite3');
      const db = openDatabase(dbPath);
      chmodSync(dbPath, 0o600);
      const originalMetadata = statSync(dbPath);
      const repo = new Repository(db);
      const batchId = repo.createBatch('test-importer', 1);
      const sourceFileId = repo.insertSourceFile({
        batchId,
        sha256: 'round-trip-hash',
        originalName: 'ride.csv',
        detectedType: 'metric:heart_rate',
        parserVersion: 'test-v1',
        status: 'imported',
        sizeBytes: 42,
      });
      const workoutId = repo.createWorkout('outdoor_cycling', 1000, 2000, 'import');
      repo.insertMetricSeries({
        workoutId,
        sourceFileId,
        metric: 'heart_rate',
        unit: 'bpm',
        source: null,
        samples: [
          { t: 1000, value: 100 },
          { t: 2000, value: 140 },
        ],
      });

      const result = await backupDatabase(db, backupPath);
      expect(result.totalPages).toBeGreaterThan(0);
      expect(result.manifest).toEqual(
        expect.objectContaining({
          formatVersion: 1,
          appVersion: '0.1.0',
          schemaVersion: '0004_backup_manifest.sql',
          includedCategories: expect.objectContaining({
            credentials: false,
            rawSourceFiles: false,
            normalizedData: true,
          }),
        }),
      );
      expect(existsSync(backupPath)).toBe(true);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(isVelographBackup(backupPath)).toBe(true);

      // Mutate the live db after backup to prove restore reverts to the
      // snapshot rather than reading current live state.
      repo.deleteWorkout(workoutId);
      expect(repo.getWorkout(workoutId)).toBeUndefined();

      let artifactMetadata: { mode: number; uid: number; gid: number }[] = [];
      const restoreResult = await restoreDatabaseWithReport(db, dbPath, backupPath, {
        beforeSwap: () => {
          artifactMetadata = restoreArtifacts(dir).map((name) => {
            const stats = statSync(join(dir, name));
            return { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
          });
        },
      });
      const restored = restoreResult.database;
      expect(restoreResult.report).toEqual({
        backupFormatVersion: 1,
        backupAppVersion: '0.1.0',
        schemaVersion: '0004_backup_manifest.sql',
        manifestVerified: true,
        checksumsVerified: true,
        databaseIntegrity: 'ok',
        foreignKeys: 'ok',
        legacyBackup: false,
        migrationsApplied: [],
      });
      const restoredRepo = new Repository(restored);
      const w = restoredRepo.getWorkout(workoutId);
      expect(w).toBeDefined();
      expect(w!.start_utc).toBe(1000);
      expect(
        restoredRepo.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get() as { n: number },
      ).toEqual({ n: 2 });
      expect(artifactMetadata).toEqual([
        { mode: 0o600, uid: originalMetadata.uid, gid: originalMetadata.gid },
        { mode: 0o600, uid: originalMetadata.uid, gid: originalMetadata.gid },
      ]);
      const restoredMetadata = statSync(dbPath);
      expect(restoredMetadata.mode & 0o777).toBe(0o600);
      expect(restoredMetadata.uid).toBe(originalMetadata.uid);
      expect(restoredMetadata.gid).toBe(originalMetadata.gid);
      expect(restoreArtifacts(dir)).toEqual([]);
      restored.close();
    }));

  it('rejects a backup whose normalized data no longer matches its manifest checksum', () =>
    withTempDir(async (dir) => {
      const { db, dbPath, backupPath } = await createRestoreScenario(dir);
      const tampered = new DatabaseConstructor(backupPath);
      tampered
        .prepare("UPDATE user_settings SET value_json = '\"tampered\"' WHERE key = 'restore-state'")
        .run();
      tampered.close();

      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath),
        'invalid_backup_checksum',
      );
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      expect(isVelographBackup(backupPath)).toBe(false);
      db.close();
    }));

  it('detects adjacent 64-bit integer tampering without numeric precision loss', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const backupPath = join(dir, 'exported.sqlite3');
      const db = openDatabase(dbPath);
      db.exec(`
        INSERT INTO import_batches (
          id, created_at, status, importer_version, counts_json
        ) VALUES (1, 1000, 'committed', 'synthetic-test', '{}');
        INSERT INTO source_files (
          id, batch_id, sha256, original_name, detected_type, parser_version,
          retention_state, status, error_code, size_bytes
        ) VALUES (
          1, 1, '${'a'.repeat(64)}', 'synthetic.csv', 'csv', 'synthetic-test',
          'hash_only', 'imported', NULL, 9007199254740992
        );
      `);
      await backupDatabase(db, backupPath);

      const tampered = new DatabaseConstructor(backupPath);
      tampered.exec('UPDATE source_files SET size_bytes = 9007199254740993 WHERE id = 1');
      tampered.close();

      expect(isVelographBackup(backupPath)).toBe(false);
      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath),
        'invalid_backup_checksum',
      );
      expect(db.open).toBe(true);
      db.close();
    }));

  it('rejects an unknown future backup format before touching the live handle', () =>
    withTempDir(async (dir) => {
      const { db, dbPath, backupPath } = await createRestoreScenario(dir);
      const future = new DatabaseConstructor(backupPath);
      future.prepare('UPDATE backup_manifests SET format_version = 99 WHERE id = 1').run();
      future.close();

      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath),
        'incompatible_backup_format',
      );
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      db.close();
    }));

  it('rejects tampered manifest metadata before touching the live handle', () =>
    withTempDir(async (dir) => {
      const { db, dbPath, backupPath } = await createRestoreScenario(dir);
      const tampered = new DatabaseConstructor(backupPath);
      tampered.prepare("UPDATE backup_manifests SET app_version = '9.9.9' WHERE id = 1").run();
      tampered.close();

      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath),
        'invalid_backup_checksum',
      );
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      db.close();
    }));

  it('restores a released legacy migration prefix and reports the compatibility upgrade', () =>
    withTempDir(async (dir) => {
      const backupPath = join(dir, 'legacy.sqlite3');
      const legacy = new DatabaseConstructor(backupPath);
      legacy.pragma('foreign_keys = ON');
      legacy.exec(readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8'));
      legacy.exec(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
      );
      legacy
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_init.sql', 1000)")
        .run();
      writeRestoreState(legacy, 'legacy-backup');
      legacy.close();

      const dbPath = join(dir, 'live.sqlite3');
      const live = openDatabase(dbPath);
      writeRestoreState(live, 'current-live');
      const result = await restoreDatabaseWithReport(live, dbPath, backupPath);

      expect(readRestoreState(result.database)).toBe('legacy-backup');
      expect(result.report).toEqual({
        backupFormatVersion: null,
        backupAppVersion: null,
        schemaVersion: listMigrations(MIGRATIONS_DIR).at(-1)!.name,
        manifestVerified: false,
        checksumsVerified: false,
        databaseIntegrity: 'ok',
        foreignKeys: 'ok',
        legacyBackup: true,
        migrationsApplied: listMigrations(MIGRATIONS_DIR)
          .slice(1)
          .map((migration) => migration.name),
      });
      expect(
        readAppliedMigrations(result.database).every((migration) =>
          /^[a-f0-9]{64}$/.test(migration.checksum),
        ),
      ).toBe(true);
      result.database.close();

      const reopened = openDatabase(dbPath);
      expect(readRestoreState(reopened)).toBe('legacy-backup');
      const upgradedBackupPath = join(dir, 'upgraded.sqlite3');
      await backupDatabase(reopened, upgradedBackupPath);
      expect(isVelographBackup(upgradedBackupPath)).toBe(true);
      writeRestoreState(reopened, 'changed-after-upgrade');

      const roundTrip = await restoreDatabaseWithReport(reopened, dbPath, upgradedBackupPath);
      expect(readRestoreState(roundTrip.database)).toBe('legacy-backup');
      expect(roundTrip.report.manifestVerified).toBe(true);
      expect(roundTrip.report.checksumsVerified).toBe(true);
      expect(roundTrip.report.legacyBackup).toBe(false);
      roundTrip.database.close();
    }));

  it('rejects a backup destination inside a git checkout (guardAgainstCheckout)', () =>
    withTempDir(async (dir) => {
      // Simulate "inside a checkout" without touching the real repo: create a
      // fake .git marker in the temp dir and target a path beneath it.
      writeFileSync(join(dir, '.git'), '');
      const outPath = join(dir, 'nested', 'out.sqlite3');
      const db = openDatabase(':memory:');
      const failure = await backupDatabase(db, outPath).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('destination_inside_checkout');
      expect((failure as Error).message).not.toContain(dir);
      expect(existsSync(outPath)).toBe(false);
      db.close();
    }));

  it('rejects the live database, its sidecars, and aliases as backup destinations', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const db = openDatabase(dbPath);
      writeRestoreState(db, 'still-live');

      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        await expectBackupValidationError(
          backupDatabase(db, `${dbPath}${suffix}`),
          'destination_conflicts_with_live_database',
        );
      }

      const hardLink = join(dir, 'live-alias.sqlite3');
      linkSync(dbPath, hardLink);
      await expectBackupValidationError(
        backupDatabase(db, hardLink),
        'destination_conflicts_with_live_database',
      );

      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('still-live');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      db.close();
    }));

  it('reserves the persistent backup lock and its SQLite sidecar names', () =>
    withTempDir(async (dir) => {
      const db = openDatabase(join(dir, 'live.sqlite3'));
      await backupDatabase(db, join(dir, 'export.sqlite3'));

      const lockDirectory = join(dir, '.velograph-backup.lock');
      const lockPath = join(lockDirectory, 'lock.sqlite3');
      expect(statSync(lockDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(lockPath).mode & 0o777).toBe(0o600);

      chmodSync(lockPath, 0o644);
      await expectBackupValidationError(
        backupDatabase(db, join(dir, 'second-export.sqlite3')),
        'invalid_backup_destination',
      );
      expect(statSync(lockPath).mode & 0o777).toBe(0o644);
      chmodSync(lockPath, 0o600);

      await expectBackupValidationError(
        backupDatabase(db, lockDirectory),
        'invalid_backup_destination',
      );
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        await expectBackupValidationError(
          backupDatabase(db, `${lockPath}${suffix}`),
          'invalid_backup_destination',
        );
      }
      await expectBackupValidationError(
        backupDatabase(db, join(dir, '.VELOGRAPH-BACKUP.LOCK')),
        'invalid_backup_destination',
      );

      expect(statSync(lockDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(lockPath).mode & 0o777).toBe(0o600);
      expect(db.open).toBe(true);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      db.close();
    }));

  it('refuses to follow a substituted persistent backup lock', () =>
    withTempDir(async (dir) => {
      const protectedPath = join(dir, 'synthetic-protected.txt');
      const lockDirectory = join(dir, '.velograph-backup.lock');
      writeFileSync(protectedPath, 'synthetic protected content');
      symlinkSync(protectedPath, lockDirectory);
      const db = openDatabase(join(dir, 'live.sqlite3'));

      await expectBackupValidationError(
        backupDatabase(db, join(dir, 'export.sqlite3')),
        'invalid_backup_destination',
      );

      expect(readFileSync(protectedPath, 'utf8')).toBe('synthetic protected content');
      expect(db.open).toBe(true);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      db.close();
    }));

  it('rejects an ABA lock entry substitution across the SQLite open boundary', () =>
    withTempDir(async (dir) => {
      const lockDirectory = join(dir, '.velograph-backup.lock');
      const lockPath = join(lockDirectory, 'lock.sqlite3');
      const movedLockPath = join(lockDirectory, 'moved-lock.sqlite3');
      const substituteLockPath = join(lockDirectory, 'substitute-lock.sqlite3');
      const db = openDatabase(join(dir, 'live.sqlite3'));
      await backupDatabase(db, join(dir, 'first-export.sqlite3'));

      await expectBackupValidationError(
        backupDatabase(db, join(dir, 'second-export.sqlite3'), {
          beforeLockOpen: () => {
            renameSync(lockPath, movedLockPath);
            writeFileSync(lockPath, '', { mode: 0o600 });
          },
          afterLockOpen: () => {
            renameSync(lockPath, substituteLockPath);
            renameSync(movedLockPath, lockPath);
          },
        }),
        'invalid_backup_destination',
      );

      expect(statSync(lockPath).mode & 0o777).toBe(0o600);
      expect(statSync(substituteLockPath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(dir, 'second-export.sqlite3'))).toBe(false);
      expect(db.open).toBe(true);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      db.close();
    }));

  it('rejects a destination whose verified parent is swapped before install', () =>
    withTempDir(async (dir) => {
      const liveDir = join(dir, 'live');
      const destinationDir = join(dir, 'destination');
      const movedDestinationDir = join(dir, 'destination-moved');
      mkdirSync(liveDir);
      mkdirSync(destinationDir);
      const dbPath = join(liveDir, 'live.sqlite3');
      const destinationPath = join(destinationDir, 'live.sqlite3');
      const db = openDatabase(dbPath);
      writeRestoreState(db, 'before-parent-swap');
      const liveEntriesBefore = readdirSync(liveDir).sort();

      await expectBackupValidationError(
        backupDatabase(db, destinationPath, {
          stageBackup: async (source, stagedPath) => {
            renameSync(destinationDir, movedDestinationDir);
            symlinkSync(liveDir, destinationDir, 'dir');
            return source.backup(stagedPath);
          },
        }),
        'invalid_backup_destination',
      );

      expect(backupArtifacts(liveDir)).toEqual([]);
      expect(readdirSync(liveDir).sort()).toEqual(liveEntriesBefore);
      const retainedDirectories = operationDirectories(movedDestinationDir, 'backup');
      expect(retainedDirectories).toHaveLength(1);
      expect(statSync(join(movedDestinationDir, retainedDirectories[0]!)).mode & 0o777).toBe(0o700);
      const retainedStages = backupArtifacts(movedDestinationDir);
      expect(retainedStages).toHaveLength(1);
      expect(statSync(join(movedDestinationDir, retainedStages[0]!)).mode & 0o777).toBe(0o600);
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('before-parent-swap');
      writeRestoreState(db, 'after-parent-swap');
      checkpointDatabase(db);
      db.close();

      const reopened = openDatabase(dbPath);
      expect(readRestoreState(reopened)).toBe('after-parent-swap');
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
      reopened.close();
    }));

  it('atomically replaces an existing permissive backup with a private validated snapshot', () =>
    withTempDir(async (dir) => {
      const db = openDatabase(join(dir, 'live.sqlite3'));
      const backupPath = join(dir, 'export.sqlite3');
      writeRestoreState(db, 'previous-backup');
      await backupDatabase(db, backupPath);
      chmodSync(backupPath, 0o644);
      writeRestoreState(db, 'replacement-backup');

      let observedStageMode: number | undefined;
      await backupDatabase(db, backupPath, {
        stageBackup: async (source, stagedPath) => {
          observedStageMode = statSync(stagedPath).mode & 0o777;
          return source.backup(stagedPath);
        },
      });

      expect(observedStageMode).toBe(0o600);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(backupArtifacts(dir)).toEqual([]);
      const probe = openDatabase(backupPath);
      expect(readRestoreState(probe)).toBe('replacement-backup');
      probe.close();
      db.close();
    }));

  it('preserves an existing backup and cleans the private stage when backup copy fails', () =>
    withTempDir(async (dir) => {
      const db = openDatabase(join(dir, 'live.sqlite3'));
      const backupPath = join(dir, 'export.sqlite3');
      writeRestoreState(db, 'previous-backup');
      await backupDatabase(db, backupPath);
      chmodSync(backupPath, 0o644);
      writeRestoreState(db, 'replacement-backup');

      await expect(
        backupDatabase(db, backupPath, {
          stageBackup: async (_source, stagedPath) => {
            expect(statSync(stagedPath).mode & 0o777).toBe(0o600);
            writeFileSync(stagedPath, 'synthetic partial write');
            throw new Error('simulated_backup_copy_failure');
          },
        }),
      ).rejects.toThrow('simulated_backup_copy_failure');

      expect(statSync(backupPath).mode & 0o777).toBe(0o644);
      expect(backupArtifacts(dir)).toEqual([]);
      const probe = openDatabase(backupPath);
      expect(readRestoreState(probe)).toBe('previous-backup');
      probe.close();
      db.close();
    }));

  it('restores the previous backup if a post-install durability step fails', () =>
    withTempDir(async (dir) => {
      const db = openDatabase(join(dir, 'live.sqlite3'));
      const backupPath = join(dir, 'export.sqlite3');
      writeRestoreState(db, 'previous-backup');
      await backupDatabase(db, backupPath);
      chmodSync(backupPath, 0o644);
      writeRestoreState(db, 'replacement-backup');

      await expect(
        backupDatabase(db, backupPath, {
          afterInstall: () => {
            const priorArtifacts = backupArtifacts(dir).filter(
              (name) => basename(name) === 'previous.sqlite3',
            );
            expect(priorArtifacts).toHaveLength(1);
            expect(statSync(join(dir, priorArtifacts[0]!)).mode & 0o777).toBe(0o600);
            throw new Error('simulated_post_install_failure');
          },
        }),
      ).rejects.toThrow('simulated_post_install_failure');

      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(backupArtifacts(dir)).toEqual([]);
      const probe = openDatabase(backupPath);
      expect(readRestoreState(probe)).toBe('previous-backup');
      probe.close();
      db.close();
    }));

  it('serializes same-destination backups so a failed writer cannot clobber a later success', () =>
    withTempDir(async (dir) => {
      const db = openDatabase(join(dir, 'live.sqlite3'));
      const backupPath = join(dir, 'export.sqlite3');
      writeRestoreState(db, 'previous-backup');
      await backupDatabase(db, backupPath);
      writeRestoreState(db, 'first-attempt');

      let markFirstInstalled!: () => void;
      const firstInstalled = new Promise<void>((resolve) => {
        markFirstInstalled = resolve;
      });
      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = backupDatabase(db, backupPath, {
        afterInstall: async () => {
          markFirstInstalled();
          await holdFirst;
          throw new Error('simulated_first_backup_failure');
        },
      });

      await firstInstalled;
      writeRestoreState(db, 'second-success');
      let secondStarted = false;
      const second = backupDatabase(db, backupPath, {
        stageBackup: (source, destination) => {
          secondStarted = true;
          return source.backup(destination);
        },
      });
      await Promise.resolve();
      expect(secondStarted).toBe(false);

      releaseFirst();
      await expect(first).rejects.toThrow('simulated_first_backup_failure');
      await second;
      expect(secondStarted).toBe(true);
      expect(backupArtifacts(dir)).toEqual([]);

      const probe = openDatabase(backupPath);
      expect(readRestoreState(probe)).toBe('second-success');
      probe.close();
      db.close();
    }));

  it(
    'serializes same-destination processes with distinct TMPDIR roots',
    () =>
      withTempDir(async (dir) => {
        const backupPath = join(dir, 'shared-export.sqlite3');
        const firstDbPath = join(dir, 'first.sqlite3');
        const secondDbPath = join(dir, 'second.sqlite3');
        const seedDbPath = join(dir, 'seed.sqlite3');
        const firstReady = join(dir, 'first-ready');
        const releaseFirst = join(dir, 'release-first');
        const secondAttempting = join(dir, 'second-attempting');
        const secondContended = join(dir, 'second-contended');
        const secondStarted = join(dir, 'second-started');
        const firstTmpRoot = join(dir, 'first-tmp');
        const secondTmpRoot = join(dir, 'second-tmp');
        mkdirSync(firstTmpRoot);
        mkdirSync(secondTmpRoot);

        const seed = openDatabase(seedDbPath);
        seed
          .prepare(
            `INSERT INTO user_settings (key, value_json) VALUES ('backup-lock-state', ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
          )
          .run(JSON.stringify('previous-backup'));
        await backupDatabase(seed, backupPath);
        seed.close();
        openDatabase(firstDbPath).close();
        openDatabase(secondDbPath).close();

        const children: ChildProcess[] = [];
        const childResults: Promise<{ code: number | null; stderr: string }>[] = [];
        try {
          const first = spawn(
            process.execPath,
            [
              BACKUP_LOCK_CHILD,
              'hold-and-fail',
              firstDbPath,
              backupPath,
              firstReady,
              releaseFirst,
              join(dir, 'first-started'),
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, TMPDIR: firstTmpRoot },
            },
          );
          children.push(first);
          const firstResult = waitForChild(first);
          childResults.push(firstResult);
          await waitForPath(firstReady);

          const second = spawn(
            process.execPath,
            [
              BACKUP_LOCK_CHILD,
              'succeed',
              secondDbPath,
              backupPath,
              secondAttempting,
              join(dir, 'unused-release'),
              secondStarted,
              secondContended,
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, TMPDIR: secondTmpRoot },
            },
          );
          children.push(second);
          const secondResult = waitForChild(second);
          childResults.push(secondResult);
          await waitForPath(secondAttempting);
          expect(await waitForEitherPath(secondContended, secondStarted)).toBe('expected');

          writeFileSync(releaseFirst, 'release');
          const [firstExit, secondExit] = await Promise.all([firstResult, secondResult]);
          expect(firstExit).toEqual({ code: 0, stderr: '' });
          expect(secondExit).toEqual({ code: 0, stderr: '' });
          expect(existsSync(secondStarted)).toBe(true);

          const probe = openDatabase(backupPath);
          const row = probe
            .prepare("SELECT value_json FROM user_settings WHERE key = 'backup-lock-state'")
            .get() as { value_json: string };
          expect(JSON.parse(row.value_json)).toBe('second-success');
          probe.close();

          const persistentLockDirectory = join(dir, '.velograph-backup.lock');
          const persistentLock = join(persistentLockDirectory, 'lock.sqlite3');
          expect(statSync(persistentLockDirectory).mode & 0o777).toBe(0o700);
          expect(statSync(persistentLock).mode & 0o777).toBe(0o600);
          const lockBytes = readFileSync(persistentLock);
          expect(lockBytes.includes(Buffer.from(dir))).toBe(false);
          expect(lockBytes.includes(Buffer.from('second-success'))).toBe(false);
        } finally {
          if (!existsSync(releaseFirst)) writeFileSync(releaseFirst, 'release');
          for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          }
          await Promise.allSettled(childResults);
        }
      }),
    15_000,
  );

  it(
    'serializes case-alias destinations across separate processes by parent identity',
    () =>
      withTempDir(async (dir) => {
        const firstBackupPath = join(dir, 'case-export.sqlite3');
        const caseAliasPath = join(dir, 'CASE-EXPORT.SQLITE3');
        const firstDbPath = join(dir, 'case-first.sqlite3');
        const secondDbPath = join(dir, 'case-second.sqlite3');
        const seedDbPath = join(dir, 'case-seed.sqlite3');
        const firstReady = join(dir, 'case-first-ready');
        const releaseFirst = join(dir, 'case-release-first');
        const secondAttempting = join(dir, 'case-second-attempting');
        const secondContended = join(dir, 'case-second-contended');
        const secondStarted = join(dir, 'case-second-started');

        const seed = openDatabase(seedDbPath);
        writeRestoreState(seed, 'previous-backup');
        await backupDatabase(seed, firstBackupPath);
        seed.close();
        openDatabase(firstDbPath).close();
        openDatabase(secondDbPath).close();

        const children: ChildProcess[] = [];
        const childResults: Promise<{ code: number | null; stderr: string }>[] = [];
        try {
          const first = spawn(
            process.execPath,
            [
              BACKUP_LOCK_CHILD,
              'hold-and-fail',
              firstDbPath,
              firstBackupPath,
              firstReady,
              releaseFirst,
              join(dir, 'case-first-started'),
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          children.push(first);
          const firstResult = waitForChild(first);
          childResults.push(firstResult);
          await waitForPath(firstReady);

          const second = spawn(
            process.execPath,
            [
              BACKUP_LOCK_CHILD,
              'succeed',
              secondDbPath,
              caseAliasPath,
              secondAttempting,
              join(dir, 'case-unused-release'),
              secondStarted,
              secondContended,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          children.push(second);
          const secondResult = waitForChild(second);
          childResults.push(secondResult);
          await waitForPath(secondAttempting);
          expect(await waitForEitherPath(secondContended, secondStarted)).toBe('expected');

          writeFileSync(releaseFirst, 'release');
          const [firstExit, secondExit] = await Promise.all([firstResult, secondResult]);
          expect(firstExit).toEqual({ code: 0, stderr: '' });
          expect(secondExit).toEqual({ code: 0, stderr: '' });
          expect(existsSync(secondStarted)).toBe(true);

          const probe = openDatabase(caseAliasPath);
          const row = probe
            .prepare("SELECT value_json FROM user_settings WHERE key = 'backup-lock-state'")
            .get() as { value_json: string };
          expect(JSON.parse(row.value_json)).toBe('second-success');
          probe.close();
        } finally {
          if (!existsSync(releaseFirst)) writeFileSync(releaseFirst, 'release');
          for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          }
          await Promise.allSettled(childResults);
        }
      }),
    15_000,
  );

  it('retains the independent previous snapshot until rollback directory sync is proven', () =>
    withTempDir(async (dir) => {
      const db = openDatabase(join(dir, 'live.sqlite3'));
      const backupPath = join(dir, 'export.sqlite3');
      writeRestoreState(db, 'previous-backup');
      await backupDatabase(db, backupPath);
      writeRestoreState(db, 'replacement-backup');
      let directorySyncs = 0;

      await expect(
        backupDatabase(db, backupPath, {
          syncDirectory: () => {
            directorySyncs += 1;
            if (directorySyncs === 2) {
              throw new Error('simulated_rollback_directory_sync_failure');
            }
          },
          afterInstall: () => {
            throw new Error('simulated_post_install_failure');
          },
        }),
      ).rejects.toThrow('simulated_post_install_failure');

      expect(directorySyncs).toBe(2);
      const retained = backupArtifacts(dir).filter((name) => basename(name) === 'previous.sqlite3');
      expect(retained).toHaveLength(1);
      const retainedPath = join(dir, retained[0]!);
      expect(statSync(retainedPath).mode & 0o777).toBe(0o600);
      expect(isVelographBackup(retainedPath)).toBe(true);
      const retainedProbe = openDatabase(retainedPath);
      expect(readRestoreState(retainedProbe)).toBe('previous-backup');
      retainedProbe.close();

      const destinationProbe = openDatabase(backupPath);
      expect(readRestoreState(destinationProbe)).toBe('previous-backup');
      destinationProbe.close();
      db.close();
    }));

  it('rejects an outside symlink alias whose canonical destination is a checkout', () =>
    withTempDir(async (dir) => {
      const checkout = join(dir, 'synthetic-checkout');
      const outside = join(dir, 'outside');
      mkdirSync(checkout);
      mkdirSync(outside);
      writeFileSync(join(checkout, '.git'), '');
      symlinkSync(checkout, join(outside, 'checkout-alias'), 'dir');

      const outPath = join(outside, 'checkout-alias', 'new', 'out.sqlite3');
      const db = openDatabase(':memory:');
      const failure = await backupDatabase(db, outPath).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('destination_inside_checkout');
      expect((failure as Error).message).not.toContain(dir);
      expect(existsSync(join(checkout, 'new', 'out.sqlite3'))).toBe(false);
      db.close();
    }));

  it('rejects a nested symlink alias into a checkout', () =>
    withTempDir(async (dir) => {
      const checkout = join(dir, 'synthetic-checkout');
      const checkoutSubdir = join(checkout, 'private');
      const outside = join(dir, 'outside', 'nested');
      mkdirSync(checkoutSubdir, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(checkout, '.git'), '');
      symlinkSync(checkoutSubdir, join(outside, 'data-alias'), 'dir');

      const outPath = join(outside, 'data-alias', 'deeper', 'out.sqlite3');
      const db = openDatabase(':memory:');
      await expect(backupDatabase(db, outPath)).rejects.toThrow('destination_inside_checkout');
      expect(existsSync(join(checkoutSubdir, 'deeper', 'out.sqlite3'))).toBe(false);
      db.close();
    }));

  it('creates missing directories for a safe external destination', () =>
    withTempDir(async (dir) => {
      const outPath = join(dir, 'safe', 'nested', 'out.sqlite3');
      const db = openDatabase(':memory:');

      const result = await backupDatabase(db, outPath);

      expect(result.totalPages).toBeGreaterThan(0);
      expect(existsSync(outPath)).toBe(true);
      expect(isVelographBackup(outPath)).toBe(true);
      db.close();
    }));

  it('rejects restoring from a file that is not a Velograph database', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const notABackup = join(dir, 'not-a-backup.txt');
      writeFileSync(notABackup, 'definitely not sqlite');
      const db = openDatabase(dbPath);
      await expectValidationError(
        restoreDatabase(db, dbPath, notABackup),
        'invalid_backup_integrity',
      );
      expect(db.open).toBe(true);
      db.close();
    }));

  it('rejects restoring from a missing path', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const db = openDatabase(dbPath);
      await expectValidationError(
        restoreDatabase(db, dbPath, join(dir, 'does-not-exist.sqlite3')),
        'invalid_backup_file',
      );
      expect(db.open).toBe(true);
      db.close();
    }));

  it('keeps the original handle and database intact when interrupted before the atomic swap', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const backupPath = join(dir, 'exported.sqlite3');
      const db = openDatabase(dbPath);
      db.prepare(
        "INSERT INTO user_settings (key, value_json) VALUES ('restore-state', '\"before\"')",
      ).run();
      await backupDatabase(db, backupPath);
      db.prepare(
        "UPDATE user_settings SET value_json = '\"after\"' WHERE key = 'restore-state'",
      ).run();

      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath, {
          beforeSwap: () => {
            throw new Error('simulated_shutdown_before_swap');
          },
        }),
        'restore_stage_failed',
      );

      expect(db.open).toBe(true);
      expect(
        db.prepare("SELECT value_json FROM user_settings WHERE key = 'restore-state'").get(),
      ).toEqual({ value_json: '"after"' });
      expect(readdirSync(dir).some((name) => name.includes('.restore-'))).toBe(false);
      expect(restoreArtifacts(dir)).toEqual([]);
      const probe = openDatabase(dbPath);
      expect(probe.pragma('integrity_check', { simple: true })).toBe('ok');
      probe.close();
      db.close();
    }));

  it('rejects a forged-current database with an incomplete schema', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const forgedPath = join(dir, 'forged.sqlite3');
      const forged = new DatabaseConstructor(forgedPath);
      forged.exec(`
        CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL,
          checksum TEXT NOT NULL
        );
        CREATE TABLE workouts (id INTEGER PRIMARY KEY);
      `);
      const insertMigration = forged.prepare(
        'INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)',
      );
      for (const migration of listMigrations(MIGRATIONS_DIR)) {
        insertMigration.run(migration.name, 1000, migration.checksum);
      }
      forged.close();

      const db = openDatabase(dbPath);
      writeRestoreState(db, 'current-live');
      expect(isVelographBackup(forgedPath)).toBe(false);
      await expectValidationError(restoreDatabase(db, dbPath, forgedPath), 'invalid_backup_schema');
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      expect(restoreArtifacts(dir)).toEqual([]);
      db.close();
    }));

  it('rejects an unknown future migration before staging cutover', () =>
    withTempDir(async (dir) => {
      const { db, dbPath, backupPath } = await createRestoreScenario(dir);
      const tampered = new DatabaseConstructor(backupPath);
      tampered
        .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run('9999_future.sql', 2000);
      tampered.close();

      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath),
        'invalid_backup_migrations',
      );
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      expect(restoreArtifacts(dir)).toEqual([]);
      db.close();
    }));

  it('rejects a staged database whose claimed old schema cannot migrate', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const incompatiblePath = join(dir, 'incompatible.sqlite3');
      const incompatible = new DatabaseConstructor(incompatiblePath);
      incompatible.exec(`
        CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE workouts (id INTEGER PRIMARY KEY);
      `);
      incompatible.close();

      const db = openDatabase(dbPath);
      writeRestoreState(db, 'current-live');
      await expectValidationError(
        restoreDatabase(db, dbPath, incompatiblePath),
        'invalid_backup_migration',
      );
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      expect(restoreArtifacts(dir)).toEqual([]);
      db.close();
    }));

  it('rejects canonical schema containing foreign-key violations', () =>
    withTempDir(async (dir) => {
      const { db, dbPath, backupPath } = await createRestoreScenario(dir);
      const tampered = new DatabaseConstructor(backupPath);
      tampered.pragma('foreign_keys = OFF');
      tampered
        .prepare(
          `INSERT INTO source_files (
            batch_id, sha256, original_name, detected_type, parser_version,
            status, size_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          999,
          'synthetic-invalid-reference',
          'invented.csv',
          'metric:test',
          'test-v1',
          'imported',
          1,
        );
      tampered.close();

      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath),
        'invalid_backup_foreign_keys',
      );
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      expect(restoreArtifacts(dir)).toEqual([]);
      db.close();
    }));

  it('keeps the live handle usable when the stage copy fails', () =>
    withTempDir(async (dir) => {
      const { db, dbPath, backupPath } = await createRestoreScenario(dir);
      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath, {
          stageBackup: async () => {
            throw new Error('native_error_must_not_escape');
          },
        }),
        'restore_stage_failed',
      );
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      expect(restoreArtifacts(dir)).toEqual([]);
      db.close();
    }));

  it('does not write a restore stage through a substituted live parent', () =>
    withTempDir(async (dir) => {
      const liveParent = join(dir, 'restore-stage-parent');
      const movedParent = join(dir, 'restore-stage-parent-moved');
      const substituteParent = join(dir, 'restore-stage-substitute');
      mkdirSync(liveParent);
      mkdirSync(substituteParent);
      const { db, dbPath, backupPath } = await createRestoreScenario(liveParent);

      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath, {
          stageBackup: async (source, destination) => {
            renameSync(liveParent, movedParent);
            symlinkSync(substituteParent, liveParent, 'dir');
            return source.backup(destination);
          },
        }),
        'restore_stage_failed',
      );

      expect(readdirSync(substituteParent)).toEqual([]);
      const retainedDirectories = operationDirectories(movedParent, 'restore');
      expect(retainedDirectories).toHaveLength(1);
      expect(statSync(join(movedParent, retainedDirectories[0]!)).mode & 0o777).toBe(0o700);
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      db.close();
      rmSync(liveParent, { force: true });
    }));

  it('does not write a rollback snapshot through a substituted live parent', () =>
    withTempDir(async (dir) => {
      const liveParent = join(dir, 'rollback-parent');
      const movedParent = join(dir, 'rollback-parent-moved');
      const substituteParent = join(dir, 'rollback-substitute');
      mkdirSync(liveParent);
      mkdirSync(substituteParent);
      const { db, dbPath, backupPath } = await createRestoreScenario(liveParent);

      await expectValidationError(
        restoreDatabase(db, dbPath, backupPath, {
          rollbackBackup: async (source, destination) => {
            renameSync(liveParent, movedParent);
            symlinkSync(substituteParent, liveParent, 'dir');
            return source.backup(destination);
          },
        }),
        'restore_rollback_failed',
      );

      expect(readdirSync(substituteParent)).toEqual([]);
      const retainedDirectories = operationDirectories(movedParent, 'restore');
      expect(retainedDirectories).toHaveLength(1);
      expect(statSync(join(movedParent, retainedDirectories[0]!)).mode & 0o777).toBe(0o700);
      expect(db.open).toBe(true);
      expect(readRestoreState(db)).toBe('current-live');
      db.close();
      rmSync(liveParent, { force: true });
    }));

  it('reopens the original database when cutover fails immediately after close', () =>
    withTempDir((dir) =>
      expectRecoveredOriginal(
        dir,
        {
          afterLiveClose: () => {
            throw new Error('simulated_post_close_failure');
          },
        },
        'restore_cutover_failed',
      ),
    ));

  it('fails closed after a post-close parent swap without creating or adopting a database', () =>
    withTempDir(async (dir) => {
      const liveParent = join(dir, 'post-close-parent');
      const movedParent = join(dir, 'post-close-parent-moved');
      const substituteParent = join(dir, 'post-close-substitute');
      mkdirSync(liveParent);
      mkdirSync(substituteParent);
      const { db, dbPath, backupPath } = await createRestoreScenario(liveParent);

      let caught: RestoreDatabaseError | undefined;
      try {
        await restoreDatabase(db, dbPath, backupPath, {
          afterLiveClose: () => {
            renameSync(liveParent, movedParent);
            symlinkSync(substituteParent, liveParent, 'dir');
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(RestoreDatabaseError);
        caught = error as RestoreDatabaseError;
      }

      expect(caught?.code).toBe('restore_recovery_failed');
      expect(caught?.recoveredDatabase).toBeUndefined();
      expect(db.open).toBe(false);
      expect(existsSync(join(substituteParent, 'live.sqlite3'))).toBe(false);
      expect(readdirSync(substituteParent)).toEqual([]);

      const retainedDirectories = operationDirectories(movedParent, 'restore');
      expect(retainedDirectories).toHaveLength(1);
      expect(statSync(join(movedParent, retainedDirectories[0]!)).mode & 0o777).toBe(0o700);
      const retainedRollback = restoreArtifacts(movedParent).filter(
        (name) => basename(name) === 'rollback.sqlite3',
      );
      expect(retainedRollback).toHaveLength(1);
      expect(statSync(join(movedParent, retainedRollback[0]!)).mode & 0o777).toBe(0o600);

      const original = openDatabase(join(movedParent, 'live.sqlite3'));
      expect(readRestoreState(original)).toBe('current-live');
      expect(original.pragma('integrity_check', { simple: true })).toBe('ok');
      original.close();
      rmSync(liveParent, { force: true });
    }));

  it('reinstalls the original database when failure occurs after replacement install', () =>
    withTempDir((dir) =>
      expectRecoveredOriginal(
        dir,
        {
          afterInstall: () => {
            throw new Error('simulated_post_install_failure');
          },
        },
        'restore_reopen_failed',
      ),
    ));

  it('reinstalls and reopens the original when replacement reopen fails', () =>
    withTempDir(async (dir) => {
      let reopenCalls = 0;
      await expectRecoveredOriginal(
        dir,
        {
          afterReopen: () => {
            reopenCalls += 1;
            if (reopenCalls === 1) throw new Error('simulated_replacement_open_failure');
          },
        },
        'restore_reopen_failed',
      );
      expect(reopenCalls).toBe(2);
    }));

  it('retains a separate private recovery snapshot when original reopen cannot be proven', () =>
    withTempDir(async (dir) => {
      const { db, dbPath, backupPath } = await createRestoreScenario(dir);
      chmodSync(dbPath, 0o640);

      let caught: RestoreDatabaseError | undefined;
      try {
        await restoreDatabase(db, dbPath, backupPath, {
          afterInstall: () => {
            throw new Error('simulated_post_install_failure');
          },
          afterReopen: () => {
            throw new Error('simulated_recovery_open_failure');
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(RestoreDatabaseError);
        caught = error as RestoreDatabaseError;
      }

      expect(caught?.code).toBe('restore_recovery_failed');
      expect(caught?.message).toBe('restore_recovery_failed');
      expect(caught?.message).not.toContain(dir);
      expect(caught?.recoveredDatabase).toBeUndefined();
      expect(db.open).toBe(false);

      const retained = restoreArtifacts(dir).filter(
        (name) => basename(name) === 'rollback.sqlite3',
      );
      expect(retained).toHaveLength(1);
      const retainedPath = join(dir, retained[0]!);
      expect(statSync(retainedPath).mode & 0o777).toBe(0o600);
      // This is a private canonical recovery snapshot, not a manifest-backed
      // user export. Restore validation uses the dedicated recovery path.
      expect(isVelographBackup(retainedPath)).toBe(false);
      const retainedProbe = openDatabase(retainedPath);
      expect(readRestoreState(retainedProbe)).toBe('current-live');
      retainedProbe.close();

      // Recovery installed an independent copy at the live path. The
      // injected open still prevents the operation from claiming recovery,
      // while a direct probe proves both copies contain the original data.
      expect(statSync(dbPath).mode & 0o777).toBe(0o640);
      const liveProbe = openDatabase(dbPath);
      expect(readRestoreState(liveProbe)).toBe('current-live');
      liveProbe.close();
    }));
});
