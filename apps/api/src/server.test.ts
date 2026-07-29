import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { loadWorkoutData, openDatabase, Repository, type Database } from '@velograph/db';
import { FORMULA_VERSION } from '@velograph/analytics';
import { runImport } from '@velograph/importers';
import { sha256Hex, stableStringify } from '@velograph/shared';
import { loadSettings } from './analytics-service.ts';
import { createApiServer } from './server.ts';

const SYNTHETIC_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'synthetic',
);
const FIXTURES = join(SYNTHETIC_ROOT, 'rides');
const HARDENING_FIXTURES = join(SYNTHETIC_ROOT, 'import-hardening');

let db: Database;
let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  db = openDatabase(':memory:');
  new Repository(db).setSetting('analytics', { timeZone: 'UTC' });
  const files = readdirSync(FIXTURES)
    .filter((f) => /\.(csv|gpx)$/.test(f))
    .sort()
    .map((name) => ({ name, data: readFileSync(join(FIXTURES, name)) }));
  runImport(db, files, { now: Date.UTC(2031, 4, 1) });
  server = createApiServer({ db, now: () => Date.UTC(2031, 4, 2) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

describe('loopback API', () => {
  it('serves health with security headers', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('lists workouts with analytics summaries (RIDE-001)', async () => {
    const res = await fetch(`${base}/api/workouts`);
    const body = (await res.json()) as { workouts: { distanceM: number; hasRoute: boolean }[] };
    expect(body.workouts).toHaveLength(3);
    expect(body.workouts[0]!.distanceM).toBeGreaterThan(0);
    expect(body.workouts[0]!.hasRoute).toBe(true);
  });

  it('serves ride detail with metrics, route, and analytics (RIDE-003/004)', async () => {
    const list = (await (await fetch(`${base}/api/workouts`)).json()) as {
      workouts: { id: number }[];
    };
    const id = list.workouts[0]!.id;
    const res = await fetch(`${base}/api/workouts/${id}`);
    const body = (await res.json()) as {
      metrics: Record<string, unknown[]>;
      route: { points: unknown[] }[];
      analytics: { formulaVersion: string };
    };
    expect(Object.keys(body.metrics).sort()).toEqual([
      'cadence',
      'distance',
      'energy',
      'heart_rate',
    ]);
    expect(body.route.length).toBeGreaterThan(0);
    expect(body.analytics.formulaVersion).toBe('analytics-v2');
  });

  it('serves trends aggregates', async () => {
    const body = (await (await fetch(`${base}/api/trends`)).json()) as {
      rides: unknown[];
      weekly: { rideCount: number }[];
    };
    expect(body.rides).toHaveLength(3);
    expect(body.weekly.reduce((s, w) => s + w.rideCount, 0)).toBe(3);
  });

  it('rejects non-loopback Host headers', async () => {
    // fetch() forbids overriding Host, so speak HTTP over a raw socket.
    const { createConnection } = await import('node:net');
    const status = await new Promise<number>((resolve, reject) => {
      const sock = createConnection(port, '127.0.0.1', () => {
        sock.write(
          `GET /api/health HTTP/1.1\r\nHost: evil.example:80\r\nConnection: close\r\n\r\n`,
        );
      });
      let buf = '';
      sock.on('data', (d) => (buf += d.toString()));
      sock.on('end', () => resolve(Number(buf.split(' ')[1])));
      sock.on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('rejects cross-origin browser requests', async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    const other = await fetch(`${base}/api/health`, {
      headers: { Origin: `http://127.0.0.1:${port + 1}` },
    });
    expect(other.status).toBe(403);
    const same = await fetch(`${base}/api/health`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(same.status).toBe(200);
  });

  it('rejects cross-site browser fetch metadata while preserving local clients', async () => {
    const crossSite = await fetch(`${base}/api/health`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: 'cross_site_request' });

    const sameOrigin = await fetch(`${base}/api/health`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(sameOrigin.status).toBe(200);
    // Non-browser and local command-line clients usually omit fetch metadata.
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('requires the CSRF header on mutating requests', async () => {
    const res = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('imports via the API idempotently (IMP-001/IMP-003)', async () => {
    const name = 'Outdoor Cycling-Heart Rate-20310901_070000.csv';
    const csv = [
      'Date/Time,Avg (bpm),Source',
      '2031-09-01T07:00:00Z,120,Synth Watch X1',
      '2031-09-01T07:30:00Z,130,Synth Watch X1',
    ].join('\n');
    const payload = JSON.stringify({
      files: [
        { id: 'synthetic-heart-rate', name, dataBase64: Buffer.from(csv).toString('base64') },
      ],
    });
    const headers = { 'Content-Type': 'application/json', 'x-velograph-request': '1' };
    const first = (await (
      await fetch(`${base}/api/import`, { method: 'POST', headers, body: payload })
    ).json()) as { result: { imported: number; workoutsCreated: number } };
    expect(first.result.imported).toBe(1);
    expect(first.result.workoutsCreated).toBe(1);
    const second = (await (
      await fetch(`${base}/api/import`, { method: 'POST', headers, body: payload })
    ).json()) as { result: { imported: number; skippedDuplicates: number } };
    expect(second.result.imported).toBe(0);
    expect(second.result.skippedDuplicates).toBe(1);
  });

  it('returns a per-file ZIP quarantine while importing a valid sibling', async () => {
    const name = 'Outdoor Cycling-Cycling Cadence-20310902_070000.csv';
    const csv = readFileSync(join(HARDENING_FIXTURES, name));
    const payload = JSON.stringify({
      files: [
        { id: 'synthetic-cadence', name, dataBase64: csv.toString('base64') },
        {
          id: 'synthetic-malformed-zip',
          name: 'malformed-synthetic.zip',
          dataBase64: Buffer.from('not a zip').toString('base64'),
        },
      ],
    });
    const response = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-velograph-request': '1' },
      body: payload,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        imported: number;
        quarantined: number;
        quarantinedFiles: { name: string; code: string }[];
      };
    };
    expect(body.result).toMatchObject({ imported: 1, quarantined: 1 });
    expect(body.result.quarantinedFiles).toEqual([
      { name: 'malformed-synthetic.zip', code: 'io_error' },
    ]);
  });

  it('round-trips settings', async () => {
    const headers = { 'Content-Type': 'application/json', 'x-velograph-request': '1' };
    const put = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        settings: {
          hrZoneBounds: [110, 125, 140, 155, 170],
          timeZone: 'America/Toronto',
        },
      }),
    });
    expect(put.status).toBe(200);
    const got = (await (await fetch(`${base}/api/settings`)).json()) as {
      settings: { hrZoneBounds: number[]; timeZone: string };
    };
    expect(got.settings.hrZoneBounds).toEqual([110, 125, 140, 155, 170]);
    expect(got.settings.timeZone).toBe('America/Toronto');
  });

  it('rejects an invalid import timezone', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-velograph-request': '1' },
      body: JSON.stringify({ settings: { timeZone: 'Not/A_Zone' } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid analytics setting patches atomically', async () => {
    const before = (await (await fetch(`${base}/api/settings`)).json()) as {
      settings: Record<string, unknown>;
    };
    const headers = { 'Content-Type': 'application/json', 'x-velograph-request': '1' };
    const invalidPatches = [
      { movingSpeedThresholdMs: null },
      { movingSpeedThresholdMs: '1' },
      { movingSpeedThresholdMs: -1 },
      { minCoverageForEfficiency: 0 },
      { elevationHysteresisM: 101 },
      { hrZoneBounds: [90, 130, 130, 150, 170] },
      { hrZoneBounds: [90, 140, 130, 150, 170] },
      { unexpectedSetting: true },
    ];

    for (const settings of invalidPatches) {
      const response = await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ settings }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_settings' });
    }
    const after = (await (await fetch(`${base}/api/settings`)).json()) as {
      settings: Record<string, unknown>;
    };
    expect(after).toEqual(before);
  });

  it('rejects unexpected settings request-envelope keys', async () => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-velograph-request': '1' },
      body: JSON.stringify({ settings: {}, unexpected: true }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_settings' });
  });

  it('surfaces an analytics snapshot conflict without exposing stored values', async () => {
    const conflictDb = openDatabase(':memory:');
    const repo = new Repository(conflictDb);
    const workoutId = repo.createWorkout('outdoor_cycling', 1_000, 9_000, 'synthetic-test');
    const input = loadWorkoutData(conflictDb, workoutId)!;
    const settings = loadSettings(conflictDb);
    const settingsHash = sha256Hex(stableStringify(settings));
    const inputHash = sha256Hex(stableStringify(input));
    conflictDb
      .prepare(
        `INSERT INTO analytics_snapshots
           (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
         VALUES (?, 'workout', ?, ?, ?, ?, ?)`,
      )
      .run(
        workoutId,
        FORMULA_VERSION,
        settingsHash,
        inputHash,
        '{"SECRET_CONFLICTING_RESULT":true}',
        10_000,
      );
    const conflictServer = createApiServer({ db: conflictDb, now: () => 20_000 });
    await new Promise<void>((resolve) => conflictServer.listen(0, '127.0.0.1', resolve));
    const address = conflictServer.address();
    const conflictPort = typeof address === 'object' && address ? address.port : 0;

    try {
      const response = await fetch(
        `http://127.0.0.1:${conflictPort}/api/workouts/${workoutId}/repair`,
        {
          method: 'POST',
          headers: { 'x-velograph-request': '1' },
        },
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string };
      expect(body).toEqual({ error: 'analytics_snapshot_conflict' });
      expect(JSON.stringify(body)).not.toContain('SECRET_CONFLICTING_RESULT');
      expect(
        conflictDb
          .prepare(
            `SELECT result_json, created_at FROM analytics_snapshots
             WHERE workout_id = ?`,
          )
          .get(workoutId),
      ).toEqual({ result_json: '{"SECRET_CONFLICTING_RESULT":true}', created_at: 10_000 });
    } finally {
      await new Promise<void>((resolve, reject) =>
        conflictServer.close((error) => (error ? reject(error) : resolve())),
      );
      conflictDb.close();
    }
  });

  it('404s unknown API routes', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });
});
