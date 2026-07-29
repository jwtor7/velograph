import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { databasePath, openDatabase, type Database } from '@velograph/db';
import { runImport } from '@velograph/importers';
import { createApiServer } from './server.ts';

// Delete/backup/restore/repair (issue #38) need a real file-backed database
// (restore closes and reopens the live connection at a path), so this suite
// runs against a temp file rather than ':memory:'. The temp dir lives
// outside the checkout, per the repo's no-real-data-in-checkout rule.

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'synthetic',
  'rides',
);

let workDir: string;
let db: Database;
let server: Server;
let base: string;
const headers = { 'Content-Type': 'application/json', 'x-velograph-request': '1' };

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'velo-api-datamgmt-'));
  const dbPath = databasePath(workDir);
  db = openDatabase(dbPath);
  const files = readdirSync(FIXTURES)
    .filter((f) => /\.(csv|gpx)$/.test(f))
    .sort()
    .map((name) => ({ name, data: readFileSync(join(FIXTURES, name)) }));
  runImport(db, files, { now: Date.UTC(2031, 4, 1) });
  server = createApiServer({ db, dbPath, now: () => Date.UTC(2031, 4, 2) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(workDir, { recursive: true, force: true });
});

describe('DELETE /api/workouts/:id', () => {
  it('deletes a ride and every dependent row', async () => {
    const list = (await (await fetch(`${base}/api/workouts`)).json()) as {
      workouts: { id: number }[];
    };
    const id = list.workouts[0]!.id;

    const del = await fetch(`${base}/api/workouts/${id}`, { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { deleted: boolean; workoutId: number };
    expect(body).toMatchObject({ deleted: true, workoutId: id });

    expect((await fetch(`${base}/api/workouts/${id}`)).status).toBe(404);
    const after = (await (await fetch(`${base}/api/workouts`)).json()) as {
      workouts: { id: number }[];
    };
    expect(after.workouts.find((w) => w.id === id)).toBeUndefined();
    expect(after.workouts).toHaveLength(list.workouts.length - 1);
  });

  it('404s deleting an unknown id and requires the CSRF header', async () => {
    const missing = await fetch(`${base}/api/workouts/999999999`, { method: 'DELETE', headers });
    expect(missing.status).toBe(404);

    const noCsrf = await fetch(`${base}/api/workouts/1`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe('POST /api/workouts/:id/repair', () => {
  it('recomputes analytics for an existing workout', async () => {
    const list = (await (await fetch(`${base}/api/workouts`)).json()) as {
      workouts: { id: number }[];
    };
    const id = list.workouts[0]!.id;
    const res = await fetch(`${base}/api/workouts/${id}/repair`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repaired: boolean; analytics: { workoutId: number } };
    expect(body.repaired).toBe(true);
    expect(body.analytics.workoutId).toBe(id);
  });

  it('404s repairing an unknown id', async () => {
    const res = await fetch(`${base}/api/workouts/999999999/repair`, {
      method: 'POST',
      headers,
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/backup and /api/restore', () => {
  it('rejects a backup path inside the repository checkout', async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const res = await fetch(`${base}/api/backup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: join(repoRoot, 'should-not-be-written.sqlite3') }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('destination_inside_checkout');
  });

  it('backs up, mutates, and restores back to the snapshot', async () => {
    const backupPath = join(workDir, 'export.sqlite3');
    const backup = await fetch(`${base}/api/backup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: backupPath }),
    });
    expect(backup.status).toBe(200);

    const before = (await (await fetch(`${base}/api/workouts`)).json()) as {
      workouts: { id: number }[];
    };
    const victimId = before.workouts[0]!.id;
    const del = await fetch(`${base}/api/workouts/${victimId}`, { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    expect((await fetch(`${base}/api/workouts/${victimId}`)).status).toBe(404);

    const restore = await fetch(`${base}/api/restore`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: backupPath }),
    });
    expect(restore.status).toBe(200);

    const after = (await (await fetch(`${base}/api/workouts/${victimId}`)).json()) as {
      workout: { id: number };
    };
    expect(after.workout.id).toBe(victimId);
    const list = (await (await fetch(`${base}/api/workouts`)).json()) as {
      workouts: { id: number }[];
    };
    expect(list.workouts).toHaveLength(before.workouts.length);
  });

  it('rejects restoring from a non-database file', async () => {
    const res = await fetch(`${base}/api/restore`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: join(workDir, 'export.sqlite3') + '-does-not-exist' }),
    });
    expect(res.status).toBe(400);
  });
});
