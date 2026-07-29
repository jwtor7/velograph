import { describe, expect, it } from 'vitest';
import DatabaseConstructor, { type Database } from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointDatabase, openDatabase } from './database.ts';
import { Repository } from './repository.ts';
import {
  RestoreDatabaseError,
  RestoreValidationError,
  backupDatabase,
  isVelographBackup,
  restoreDatabase,
  type RestoreOptions,
  type RestoreValidationErrorCode,
} from './backup.ts';

// Backups contain real health data (PRD §12.2) — every temp dir here is
// created outside the checkout via the OS temp directory, never under the
// repo, and is removed at the end of each test.

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'velo-backup-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function restoreArtifacts(dir: string): string[] {
  return readdirSync(dir).filter(
    (name) =>
      name.includes('.restore-') || name.includes('.rollback-') || name.includes('.recovery-'),
  );
}

function backupArtifacts(dir: string): string[] {
  return readdirSync(dir).filter(
    (name) => name.includes('.backup-') || name.includes('.previous-'),
  );
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
      expect(existsSync(backupPath)).toBe(true);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(isVelographBackup(backupPath)).toBe(true);

      // Mutate the live db after backup to prove restore reverts to the
      // snapshot rather than reading current live state.
      repo.deleteWorkout(workoutId);
      expect(repo.getWorkout(workoutId)).toBeUndefined();

      let artifactMetadata: { mode: number; uid: number; gid: number }[] = [];
      const restored = await restoreDatabase(db, dbPath, backupPath, {
        beforeSwap: () => {
          artifactMetadata = restoreArtifacts(dir).map((name) => {
            const stats = statSync(join(dir, name));
            return { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
          });
        },
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

  it('rejects a backup destination inside a git checkout (guardAgainstCheckout)', () =>
    withTempDir(async (dir) => {
      // Simulate "inside a checkout" without touching the real repo: create a
      // fake .git marker in the temp dir and target a path beneath it.
      writeFileSync(join(dir, '.git'), '');
      const outPath = join(dir, 'nested', 'out.sqlite3');
      const db = openDatabase(':memory:');
      await expect(backupDatabase(db, outPath)).rejects.toThrow(/checkout/);
      expect(existsSync(outPath)).toBe(false);
      db.close();
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
            const priorArtifacts = backupArtifacts(dir).filter((name) =>
              name.includes('.previous-'),
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
          applied_at INTEGER NOT NULL
        );
        INSERT INTO schema_migrations (name, applied_at)
          VALUES ('0001_init.sql', 1000);
        CREATE TABLE workouts (id INTEGER PRIMARY KEY);
      `);
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
          reopenDatabase: (path) => {
            reopenCalls += 1;
            if (reopenCalls === 1) throw new Error('simulated_replacement_open_failure');
            return openDatabase(path);
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
          reopenDatabase: () => {
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

      const retained = restoreArtifacts(dir).filter((name) => name.includes('.rollback-'));
      expect(retained).toHaveLength(1);
      const retainedPath = join(dir, retained[0]!);
      expect(statSync(retainedPath).mode & 0o777).toBe(0o600);
      expect(isVelographBackup(retainedPath)).toBe(true);
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
