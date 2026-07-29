import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { openDatabase, Repository, type Database } from '@velograph/db';
import { createApiServer } from './server.ts';
import { generateCorpus } from '../../../scripts/generate-fixtures.mjs';

/**
 * Path-based folder import (issue #51). Proves the actual point of the
 * issue end to end: pointing the API at a folder path — not a browser file
 * picker — produces complete rides with heart rate, cadence, distance,
 * energy, and route all attached to the correct workout.
 *
 * The export folder is built from the same synthetic fixture generator used
 * elsewhere (`scripts/generate-fixtures.mjs`), written to a throwaway temp
 * directory outside the checkout, mirroring Health Auto Export's real
 * shape: one CSV per metric per ride plus a route GPX and route CSV, with a
 * nested subfolder thrown in to exercise recursion.
 */

const headers = { 'Content-Type': 'application/json', 'x-velograph-request': '1' };

let exportDir: string;
let db: Database;
let server: Server;
let base: string;
const extraDirs: string[] = [];

interface PathPreviewResponse {
  preview: {
    confirmationToken: string;
    rides: { files: unknown[] }[];
    ungrouped: unknown[];
    skipped: { relativePath: string; reason: string }[];
    totalFiles: number;
    truncated: boolean;
    preflightComplete: boolean;
    preflight: { name: string; classification: string; outcomes: { code: string | null }[] }[];
  };
}

async function previewPath(path: string): Promise<PathPreviewResponse> {
  const res = await fetch(`${base}/api/import/path/inventory`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PathPreviewResponse;
}

function mutationDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'velograph-path-mutation-'));
  extraDirs.push(dir);
  return dir;
}

function persistentImportCounts(): Record<string, number> {
  const count = (sql: string): number => (db.prepare(sql).get() as { count: number }).count;
  return {
    importBatches: count('SELECT COUNT(*) AS count FROM import_batches'),
    sourceFiles: count('SELECT COUNT(*) AS count FROM source_files'),
    quarantined: count("SELECT COUNT(*) AS count FROM source_files WHERE status = 'quarantined'"),
    workouts: count('SELECT COUNT(*) AS count FROM workouts'),
    metricSeries: count('SELECT COUNT(*) AS count FROM metric_series'),
    metricSamples: count('SELECT COUNT(*) AS count FROM metric_samples'),
    routes: count('SELECT COUNT(*) AS count FROM routes'),
    routePoints: count('SELECT COUNT(*) AS count FROM route_points'),
  };
}

beforeAll(async () => {
  exportDir = mkdtempSync(join(tmpdir(), 'velograph-path-import-'));
  const corpus = generateCorpus({ rides: 4, seed: 4200 });
  let i = 0;
  const nested = join(exportDir, 'export-batch-2');
  mkdirSync(nested);
  for (const [name, content] of corpus) {
    // Alternate files between the root and a nested subfolder so the walk's
    // recursion is exercised, not just a flat directory.
    const dest = i++ % 3 === 0 ? join(nested, name) : join(exportDir, name);
    writeFileSync(dest, content);
  }

  db = openDatabase(':memory:');
  server = createApiServer({ db, now: () => Date.UTC(2031, 4, 2) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(exportDir, { recursive: true, force: true });
  for (const dir of extraDirs) rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/import/path/inventory', () => {
  it('previews the folder grouped by ride without importing anything', async () => {
    const res = await fetch(`${base}/api/import/path/inventory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: exportDir }),
    });
    expect(res.status).toBe(200);
    const rawBody = await res.text();
    expect(rawBody).not.toContain(exportDir);
    const body = JSON.parse(rawBody) as {
      preview: {
        confirmationToken: string;
        rides: { files: unknown[] }[];
        ungrouped: unknown[];
        totalFiles: number;
        preflightComplete: boolean;
        preflight: { classification: string }[];
      };
    };
    expect(body.preview.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(body.preview.rides).toHaveLength(4);
    for (const ride of body.preview.rides) {
      // Heart rate, cadence, distance, energy, route CSV, route GPX.
      expect(ride.files).toHaveLength(6);
    }
    expect(body.preview.totalFiles).toBe(24);
    expect(body.preview.preflightComplete).toBe(true);
    expect(body.preview.preflight).toHaveLength(24);
    expect(body.preview.preflight.every((item) => item.classification === 'recognized')).toBe(true);

    // Confirm the workouts list is untouched — preview never imports.
    const workouts = await fetch(`${base}/api/workouts`);
    expect(((await workouts.json()) as { workouts: unknown[] }).workouts).toHaveLength(0);
  });

  it('reports exact invalid and DB-ambiguous outcomes without preview writes', async () => {
    const dir = mutationDir();
    const stamp = '20400601_070000';
    writeFileSync(
      join(dir, `Outdoor Cycling-Cycling Cadence-${stamp}.csv`),
      'Date/Time,Cycling Cadence (count/min),Source\n' +
        '2040-06-01T07:00:00Z,88,Synthetic Watch\n',
    );
    writeFileSync(
      join(dir, `Outdoor Cycling-Heart Rate-${stamp}.csv`),
      'not,a,recognized,header\n1,2,3,4\n',
    );
    const repo = new Repository(db);
    const start = Date.UTC(2040, 5, 1, 7);
    const first = repo.createWorkout(
      'outdoor_cycling',
      start - 60_000,
      start + 60_000,
      'synthetic-test',
    );
    const second = repo.createWorkout(
      'outdoor_cycling',
      start - 120_000,
      start + 120_000,
      'synthetic-test',
    );
    const before = persistentImportCounts();

    const { preview } = await previewPath(dir);

    expect(preview.preflightComplete).toBe(true);
    expect(preview.preflight.map((item) => item.classification)).toEqual(['ambiguous', 'invalid']);
    expect(preview.preflight[0]!.outcomes[0]!.code).toBe('association_ambiguous');
    expect(preview.preflight[1]!.outcomes[0]!.code).toBe('unrecognized_headers');
    expect(persistentImportCounts()).toEqual(before);
    expect(db.inTransaction).toBe(false);

    repo.deleteWorkout(first);
    repo.deleteWorkout(second);
  });

  it('rejects a path resolving inside the repository checkout', async () => {
    const res = await fetch(`${base}/api/import/path/inventory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: join(process.cwd(), 'fixtures', 'synthetic', 'rides') }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'path_inside_checkout' });
  });

  it('requires the CSRF header like every other mutating route', async () => {
    const res = await fetch(`${base}/api/import/path/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: exportDir }),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/import/path', () => {
  it('requires an inventory confirmation token', async () => {
    const res = await fetch(`${base}/api/import/path`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: exportDir }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'preview_required' });
  });

  it('rejects mutation, addition, and same-size replacement after preview without writes', async () => {
    const before = persistentImportCounts();
    const changes: ((dir: string, path: string) => void)[] = [
      (_dir, path) => writeFileSync(path, 'changed-size'),
      (dir) => writeFileSync(join(dir, 'Outdoor Cycling-Cycling Cadence-20260101_070000.csv'), 'x'),
      (dir, path) => {
        const replaced = join(dir, 'replaced.csv');
        renameSync(path, replaced);
        writeFileSync(path, 'original');
        rmSync(replaced);
      },
    ];

    for (const change of changes) {
      const dir = mutationDir();
      const path = join(dir, 'Outdoor Cycling-Heart Rate-20260101_070000.csv');
      writeFileSync(path, 'original');
      const { preview } = await previewPath(dir);
      change(dir, path);

      const res = await fetch(`${base}/api/import/path`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: dir, confirmationToken: preview.confirmationToken }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'path_changed' });
      expect(persistentImportCounts()).toEqual(before);
    }
  });

  it('maps a deleted or type-changed preview root to path_changed without writes', async () => {
    const before = persistentImportCounts();
    const changes: ((dir: string) => void)[] = [
      (dir) => rmSync(dir, { recursive: true, force: true }),
      (dir) => {
        rmSync(dir, { recursive: true, force: true });
        writeFileSync(dir, 'synthetic non-directory');
      },
    ];

    for (const change of changes) {
      const dir = mutationDir();
      writeFileSync(join(dir, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');
      const { preview } = await previewPath(dir);
      change(dir);

      const res = await fetch(`${base}/api/import/path`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: dir, confirmationToken: preview.confirmationToken }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'path_changed' });
      expect(persistentImportCounts()).toEqual(before);
    }
  });

  it('imports a real-shaped export folder by path with complete metric coverage', async () => {
    const { preview } = await previewPath(exportDir);
    expect(preview.truncated).toBe(false);
    const res = await fetch(`${base}/api/import/path`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: exportDir, confirmationToken: preview.confirmationToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { imported: number; workoutsCreated: number; quarantined: number };
      skipped: unknown[];
      truncated: boolean;
    };
    expect(body.result.quarantined).toBe(0);
    expect(body.result.workoutsCreated).toBe(4);
    expect(body.result.imported).toBe(24);
    expect(body.truncated).toBe(false);
    expect(body.skipped).toHaveLength(0);

    const list = (await (await fetch(`${base}/api/workouts`)).json()) as {
      workouts: { id: number; distanceM: number | null; avgHr: number | null; hasRoute: boolean }[];
    };
    expect(list.workouts).toHaveLength(4);

    // Prove the coverage claim rather than assert it: every ride must carry
    // heart rate, cadence, distance, energy, and route.
    let coveredRides = 0;
    let totalMetricSlots = 0;
    let coveredMetricSlots = 0;
    for (const w of list.workouts) {
      const detail = (await (await fetch(`${base}/api/workouts/${w.id}`)).json()) as {
        metrics: Record<string, unknown[]>;
        route: { points: unknown[] }[];
      };
      const metricKeys = ['heart_rate', 'cadence', 'distance', 'energy'] as const;
      const present = metricKeys.filter(
        (k) => Array.isArray(detail.metrics[k]) && detail.metrics[k]!.length > 0,
      );
      const hasRoute = detail.route.length > 0 && detail.route[0]!.points.length > 0;
      totalMetricSlots += metricKeys.length + 1; // +1 for route
      coveredMetricSlots += present.length + (hasRoute ? 1 : 0);
      if (present.length === metricKeys.length && hasRoute) coveredRides++;
    }
    // This is the number this issue exists to prove — logged so the PR can
    // report the actual measured value, not an assertion of it.
    console.log(
      `path-import metric coverage: ${coveredRides}/${list.workouts.length} rides fully covered, ` +
        `${coveredMetricSlots}/${totalMetricSlots} metric+route slots present`,
    );
    expect(coveredRides).toBe(4);
    expect(coveredMetricSlots).toBe(totalMetricSlots);
  });

  it('previews an already imported folder as exact duplicates without writes', async () => {
    const before = persistentImportCounts();
    const { preview } = await previewPath(exportDir);

    expect(preview.preflightComplete).toBe(true);
    expect(preview.preflight).toHaveLength(24);
    expect(preview.preflight.every((item) => item.classification === 'duplicate')).toBe(true);
    expect(persistentImportCounts()).toEqual(before);
  });

  it('returns unsupported regular files in both preview and confirmation results', async () => {
    const dir = mutationDir();
    for (const [name, content] of generateCorpus({ rides: 1, seed: 4300 })) {
      writeFileSync(join(dir, name), content);
    }
    writeFileSync(join(dir, 'metadata.json'), '{}');
    writeFileSync(join(dir, 'notes.txt'), 'synthetic note');

    const { preview } = await previewPath(dir);
    const expectedSkipped = [
      { relativePath: 'metadata.json', reason: 'unsupported_file_type' },
      { relativePath: 'notes.txt', reason: 'unsupported_file_type' },
    ];
    expect(preview.skipped).toEqual(expectedSkipped);

    const res = await fetch(`${base}/api/import/path`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: dir, confirmationToken: preview.confirmationToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { quarantined: number };
      skipped: { relativePath: string; reason: string }[];
    };
    expect(body.result.quarantined).toBe(0);
    expect(body.skipped).toEqual(expectedSkipped);
  });
});
