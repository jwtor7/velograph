import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { openDatabase, type Database } from '@velograph/db';
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
});

describe('POST /api/import/path/inventory', () => {
  it('previews the folder grouped by ride without importing anything', async () => {
    const res = await fetch(`${base}/api/import/path/inventory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: exportDir }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      preview: { rides: { files: unknown[] }[]; ungrouped: unknown[]; totalFiles: number };
    };
    expect(body.preview.rides).toHaveLength(4);
    for (const ride of body.preview.rides) {
      // Heart rate, cadence, distance, energy, route CSV, route GPX.
      expect(ride.files).toHaveLength(6);
    }
    expect(body.preview.totalFiles).toBe(24);

    // Confirm the workouts list is untouched — preview never imports.
    const workouts = await fetch(`${base}/api/workouts`);
    expect(((await workouts.json()) as { workouts: unknown[] }).workouts).toHaveLength(0);
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
  it('imports a real-shaped export folder by path with complete metric coverage', async () => {
    const res = await fetch(`${base}/api/import/path`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: exportDir }),
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
});
