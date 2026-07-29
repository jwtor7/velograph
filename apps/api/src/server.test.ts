import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { openDatabase, type Database } from '@velograph/db';
import { runImport } from '@velograph/importers';
import { createApiServer } from './server.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'synthetic',
  'rides',
);

let db: Database;
let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  db = openDatabase(':memory:');
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
    expect(body.analytics.formulaVersion).toBe('analytics-v1');
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
      files: [{ name, dataBase64: Buffer.from(csv).toString('base64') }],
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

  it('404s unknown API routes', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });
});
