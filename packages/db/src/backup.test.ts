import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './database.ts';
import { Repository } from './repository.ts';
import { backupDatabase, isVelographBackup, restoreDatabase } from './backup.ts';

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

describe('backupDatabase / restoreDatabase', () => {
  it('round-trips to an identical database via the SQLite backup API', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const backupPath = join(dir, 'exported.sqlite3');
      const db = openDatabase(dbPath);
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
      expect(isVelographBackup(backupPath)).toBe(true);

      // Mutate the live db after backup to prove restore reverts to the
      // snapshot rather than reading current live state.
      repo.deleteWorkout(workoutId);
      expect(repo.getWorkout(workoutId)).toBeUndefined();

      const restored = await restoreDatabase(db, dbPath, backupPath);
      const restoredRepo = new Repository(restored);
      const w = restoredRepo.getWorkout(workoutId);
      expect(w).toBeDefined();
      expect(w!.start_utc).toBe(1000);
      expect(
        restoredRepo.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get() as { n: number },
      ).toEqual({ n: 2 });
      restored.close();
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
      expect((failure as Error).message).toBe('data_path_inside_checkout');
      expect((failure as Error).message).not.toContain(dir);
      expect(existsSync(outPath)).toBe(false);
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
      expect((failure as Error).message).toBe('data_path_inside_checkout');
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
      await expect(backupDatabase(db, outPath)).rejects.toThrow('data_path_inside_checkout');
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
      await expect(restoreDatabase(db, dbPath, notABackup)).rejects.toThrow('invalid_backup_file');
      db.close();
    }));

  it('rejects restoring from a missing path', () =>
    withTempDir(async (dir) => {
      const dbPath = join(dir, 'live.sqlite3');
      const db = openDatabase(dbPath);
      await expect(
        restoreDatabase(db, dbPath, join(dir, 'does-not-exist.sqlite3')),
      ).rejects.toThrow('invalid_backup_file');
      db.close();
    }));
});
