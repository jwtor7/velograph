import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databasePath, openDatabase, Repository } from '@velograph/db';
import { DEFAULT_MAX_GROUP_BYTES } from '@velograph/importers';
import { main, portableBasename } from './index.ts';

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
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env['VELO_DATA_DIR'];
  dataDir = mkdtempSync(join(tmpdir(), 'velo-cli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env['VELO_DATA_DIR'];
  else process.env['VELO_DATA_DIR'] = previousDataDir;
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
  it('derives a portable source filename from POSIX and Windows separators', () => {
    expect(
      portableBasename('/synthetic/export/Outdoor Cycling-Heart Rate-20310102_080000.csv'),
    ).toBe('Outdoor Cycling-Heart Rate-20310102_080000.csv');
    expect(
      portableBasename('C:\\synthetic\\export\\Outdoor Cycling-Heart Rate-20310102_080000.csv'),
    ).toBe('Outdoor Cycling-Heart Rate-20310102_080000.csv');
  });

  it('rejects missing, blank, flag-like, or repeated data-dir values before fallback', async () => {
    const fallback = join(dataDir, 'must-not-be-created');
    process.env['VELO_DATA_DIR'] = fallback;
    const fixture = join(FIXTURES, 'Outdoor Cycling-Heart Rate-20310402_073000.csv');

    expect(await main(['import', fixture, '--data-dir'])).toBe(2);
    expect(await main(['import', fixture, '--data-dir', ''])).toBe(2);
    expect(await main(['import', fixture, '--data-dir', '--confirm-replace'])).toBe(2);
    expect(
      await main(['import', fixture, '--data-dir', dataDir, '--data-dir', join(dataDir, 'other')]),
    ).toBe(2);
    expect(() => statSync(fallback)).toThrow();
  });

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

  it('requires explicit confirmation and then deletes all database state', async () => {
    const files = readdirSync(FIXTURES)
      .filter((f) => /\.(csv|gpx)$/.test(f))
      .map((f) => join(FIXTURES, f));
    expect(await main(['import', ...files, '--data-dir', dataDir])).toBe(0);

    const seeded = openDatabase(databasePath(dataDir));
    const seededRepo = new Repository(seeded);
    seededRepo.setSetting('analytics', {
      timeZone: 'Etc/UTC',
      hrZoneBounds: [90, 110, 130, 150, 170],
    });
    const migrationsBefore = seeded
      .prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid')
      .all();
    seeded.close();
    const before = workoutCount();

    expect(await main(['delete-all', '--data-dir', dataDir])).toBe(2);
    expect(console.error).toHaveBeenLastCalledWith('Delete-all requires --confirm-delete-all');
    expect(workoutCount()).toBe(before);

    expect(await main(['delete-all', '--confirm-delete-all', '--data-dir', dataDir])).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith('Deleted all local data');

    const cleared = openDatabase(databasePath(dataDir));
    try {
      for (const table of [
        'workouts',
        'workout_source_files',
        'source_files',
        'import_batches',
        'metric_series',
        'metric_samples',
        'routes',
        'route_points',
        'analytics_snapshots',
        'insight_runs',
        'notes_tags',
        'source_file_reprocessing_failures',
        'user_settings',
        'backup_manifests',
      ]) {
        expect(
          (cleared.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
            .count,
          table,
        ).toBe(0);
      }
      expect(
        cleared.prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid').all(),
      ).toEqual(migrationsBefore);
    } finally {
      cleared.close();
    }
  });

  it('routes folder imports through bounded recursive planning without following outside links', async () => {
    const source = mkdtempSync(join(tmpdir(), 'velo-cli-folder-'));
    const outside = mkdtempSync(join(tmpdir(), 'velo-cli-outside-'));
    try {
      const nested = join(source, 'nested');
      mkdirSync(nested);
      for (const name of readdirSync(FIXTURES).filter((file) => /\.(csv|gpx)$/.test(file))) {
        copyFileSync(join(FIXTURES, name), join(nested, name));
      }
      const outsideName = 'Outdoor Cycling-Heart Rate-20390101_010101.csv';
      const outsidePath = join(outside, outsideName);
      writeFileSync(outsidePath, 'invented malformed private source');
      try {
        symlinkSync(outsidePath, join(nested, outsideName));
      } catch {
        // Filesystems without symlink support still exercise recursive planning.
      }

      expect(await main(['import', source, '--data-dir', dataDir])).toBe(0);
      expect(workoutCount()).toBeGreaterThan(0);
      expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(outsideName);
      expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(source);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never prints quarantined source filenames', async () => {
    const source = mkdtempSync(join(tmpdir(), 'velo-cli-quarantine-'));
    try {
      const sensitiveLookingName = 'Outdoor Cycling-Heart Rate-20390101_010101.csv';
      const path = join(source, sensitiveLookingName);
      writeFileSync(path, 'invented malformed private source');

      expect(await main(['import', path, '--data-dir', dataDir])).toBe(0);
      const output = JSON.stringify(vi.mocked(console.log).mock.calls);
      expect(output).toContain('quarantined');
      expect(output).not.toContain(sensitiveLookingName);
      expect(output).not.toContain(source);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('reports normal import skips as compact value-free counts', async () => {
    const source = mkdtempSync(join(tmpdir(), 'velo-cli-normal-skips-'));
    try {
      const unmodelledName = 'Outdoor Cycling-Respiratory Rate-20330405_070000.csv';
      const nonCyclingName = 'Running-Route-20330405_070000.gpx';
      const unmodelledPath = join(source, unmodelledName);
      const nonCyclingPath = join(source, nonCyclingName);
      writeFileSync(unmodelledPath, 'invented out-of-scope metric');
      writeFileSync(nonCyclingPath, 'invented out-of-scope route');

      expect(await main(['import', unmodelledPath, nonCyclingPath, '--data-dir', dataDir])).toBe(0);
      const output = JSON.stringify(vi.mocked(console.log).mock.calls);
      expect(output).toContain('out-of-scope skipped: 2');
      expect(output).toContain('skipped [unmodelled_metric]: 1');
      expect(output).toContain('skipped [non_cycling_workout]: 1');
      expect(output).not.toContain(unmodelledName);
      expect(output).not.toContain(nonCyclingName);
      expect(output).not.toContain(source);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic path before reading it', async () => {
    const source = mkdtempSync(join(tmpdir(), 'velo-cli-symbolic-source-'));
    const aliasRoot = mkdtempSync(join(tmpdir(), 'velo-cli-symbolic-alias-'));
    const alias = join(aliasRoot, 'synthetic-folder-alias');
    try {
      try {
        symlinkSync(source, alias);
      } catch {
        return;
      }
      expect(await main(['import', alias, '--data-dir', dataDir])).toBe(1);
      const output = JSON.stringify([
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.error).mock.calls,
      ]);
      expect(output).toContain('Import failed: import_failed');
      expect(output).not.toContain(alias);
      expect(output).not.toContain(source);
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('rejects an oversized direct file before reading or mutating import state', async () => {
    const source = mkdtempSync(join(tmpdir(), 'velo-cli-oversized-'));
    try {
      const name = 'Outdoor Cycling-Heart Rate-20390101_010101.csv';
      const path = join(source, name);
      writeFileSync(path, '');
      truncateSync(path, DEFAULT_MAX_GROUP_BYTES + 1);

      expect(await main(['import', path, '--data-dir', dataDir])).toBe(1);
      expect(workoutCount()).toBe(0);
      const output = JSON.stringify([
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.error).mock.calls,
      ]);
      expect(output).toContain('Import failed: import_failed');
      expect(output).not.toContain(name);
      expect(output).not.toContain(source);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
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

  it('keeps delete-all startup failures value-free behind the spawned CLI boundary', () => {
    writeFileSync(databasePath(dataDir), 'synthetic invalid sqlite');
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRYPOINT, 'delete-all', '--confirm-delete-all', '--data-dir', dataDir],
      {
        encoding: 'utf8',
        env: { ...process.env, VELO_DATA_DIR: '' },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('Delete-all failed: delete_all_failed');
    expect(result.stderr).not.toContain(dataDir);
    expect(result.stderr).not.toContain(process.cwd());
    expect(result.stderr).not.toContain('SqliteError');
    expect(result.stderr).not.toContain(' at ');
  });
});
