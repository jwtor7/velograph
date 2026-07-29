import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databasePath, openDatabase, Repository } from '@velograph/db';
import { main } from './index.ts';

// Every temp dir here is created outside the checkout (never under the repo)
// via the OS temp directory, matching the repo's no-real-data-in-checkout rule.

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'synthetic',
  'rides',
);
const CLI_ENTRYPOINT = fileURLToPath(new URL('./index.ts', import.meta.url));

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'velo-cli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

function firstWorkoutId(): number {
  const db = openDatabase(databasePath(dataDir));
  try {
    return new Repository(db).listWorkouts()[0]!.id;
  } finally {
    db.close();
  }
}

function workoutCount(): number {
  const db = openDatabase(databasePath(dataDir));
  try {
    return new Repository(db).listWorkouts().length;
  } finally {
    db.close();
  }
}

describe('velograph CLI', () => {
  it('prints usage and exits 2 for no/unknown command', async () => {
    expect(await main([])).toBe(2);
    expect(await main(['bogus'])).toBe(2);
  });

  it('imports, deletes, and repairs a workout end to end', async () => {
    const files = readdirSync(FIXTURES)
      .filter((f) => /\.(csv|gpx)$/.test(f))
      .map((f) => join(FIXTURES, f));
    expect(await main(['import', ...files, '--data-dir', dataDir])).toBe(0);
    const before = workoutCount();
    expect(before).toBeGreaterThan(0);

    const id = firstWorkoutId();
    expect(await main(['repair', String(id), '--data-dir', dataDir])).toBe(0);
    expect(await main(['delete', String(id), '--data-dir', dataDir])).toBe(0);
    expect(workoutCount()).toBe(before - 1);

    // Deleting forgets the content hash: the identical file re-imports
    // instead of being skipped as a duplicate (issue #38 idempotency).
    expect(await main(['import', ...files, '--data-dir', dataDir])).toBe(0);
    expect(workoutCount()).toBe(before);
  });

  it('reports not-found (exit 1) for delete/repair on an unknown id', async () => {
    const files = readdirSync(FIXTURES)
      .filter((f) => /\.(csv|gpx)$/.test(f))
      .map((f) => join(FIXTURES, f));
    await main(['import', ...files, '--data-dir', dataDir]);
    expect(await main(['delete', '999999999', '--data-dir', dataDir])).toBe(1);
    expect(await main(['repair', '999999999', '--data-dir', dataDir])).toBe(1);
  });

  it('backs up and restores via the CLI', async () => {
    const files = readdirSync(FIXTURES)
      .filter((f) => /\.(csv|gpx)$/.test(f))
      .map((f) => join(FIXTURES, f));
    await main(['import', ...files, '--data-dir', dataDir]);
    const before = workoutCount();
    // Backups carry real health data; write inside this test's own outside-
    // the-checkout temp data dir, never a shared/global path.
    const backupPath = join(dataDir, 'export.sqlite3');

    expect(await main(['backup', backupPath, '--data-dir', dataDir])).toBe(0);
    expect(readFileSync(backupPath).subarray(0, 16).toString('latin1')).toContain(
      'SQLite format 3',
    );

    const id = firstWorkoutId();
    await main(['delete', String(id), '--data-dir', dataDir]);
    expect(workoutCount()).toBe(before - 1);

    expect(await main(['restore', backupPath, '--confirm-replace', '--data-dir', dataDir])).toBe(0);
    expect(workoutCount()).toBe(before);
  });

  it('requires an explicit replace confirmation for restore', async () => {
    const error = vi.mocked(console.error);
    expect(await main(['restore', join(dataDir, 'backup.sqlite3'), '--data-dir', dataDir])).toBe(2);
    expect(error).toHaveBeenLastCalledWith('Restore requires --confirm-replace');
  });

  it('rejects a backup destination inside the repository checkout', async () => {
    const files = readdirSync(FIXTURES)
      .filter((f) => /\.(csv|gpx)$/.test(f))
      .map((f) => join(FIXTURES, f));
    await main(['import', ...files, '--data-dir', dataDir]);
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const error = vi.mocked(console.error);
    error.mockClear();
    expect(
      await main(['backup', join(repoRoot, 'should-not-exist.sqlite3'), '--data-dir', dataDir]),
    ).toBe(1);
    expect(error).toHaveBeenLastCalledWith('Backup failed: destination_inside_checkout');
    expect(JSON.stringify(error.mock.calls)).not.toContain(repoRoot);
  });

  it('reports value-free backup destination failures without changing the live database', async () => {
    const files = readdirSync(FIXTURES)
      .filter((f) => /\.(csv|gpx)$/.test(f))
      .map((f) => join(FIXTURES, f));
    await main(['import', ...files, '--data-dir', dataDir]);
    const before = workoutCount();
    const error = vi.mocked(console.error);

    error.mockClear();
    expect(await main(['backup', databasePath(dataDir), '--data-dir', dataDir])).toBe(1);
    expect(error).toHaveBeenLastCalledWith(
      'Backup failed: destination_conflicts_with_live_database',
    );

    const notDirectory = join(dataDir, 'synthetic-not-a-directory');
    writeFileSync(notDirectory, 'invented');
    error.mockClear();
    expect(
      await main(['backup', join(notDirectory, 'export.sqlite3'), '--data-dir', dataDir]),
    ).toBe(1);
    expect(error).toHaveBeenLastCalledWith('Backup failed: invalid_backup_destination');
    expect(JSON.stringify(error.mock.calls)).not.toContain(dataDir);
    expect(workoutCount()).toBe(before);
  });

  it('reports a stable value-free code for an invalid restore source', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await main([
          'restore',
          join(dataDir, 'missing.sqlite3'),
          '--confirm-replace',
          '--data-dir',
          dataDir,
        ]),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith('Restore failed: invalid_backup_file');
    } finally {
      error.mockRestore();
    }
  });

  it('keeps corrupt live-database startup failures behind the spawned CLI boundary', () => {
    writeFileSync(databasePath(dataDir), 'synthetic invalid sqlite');
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRYPOINT, 'backup', join(dataDir, 'synthetic-export.sqlite3'), '--data-dir', dataDir],
      {
        encoding: 'utf8',
        env: { ...process.env, VELO_DATA_DIR: '' },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('Backup failed: backup_failed');
    expect(result.stderr).not.toContain(dataDir);
    expect(result.stderr).not.toContain(process.cwd());
    expect(result.stderr).not.toContain('SqliteError');
    expect(result.stderr).not.toContain(' at ');
  });
});
