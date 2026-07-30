import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request, type ClientRequest, type Server } from 'node:http';
import { openDatabase, Repository, type Database } from '@velograph/db';
import { systemTimeZone } from '@velograph/shared';
import { createApiServer } from './server.ts';

const MUTATION_HEADERS = {
  'Content-Type': 'application/json',
  'x-velograph-request': '1',
};

let db: Database;
let server: Server;
let base: string;

function seedSyntheticState(): void {
  const repo = new Repository(db);
  const start = Date.UTC(2033, 3, 5, 6, 7, 8);
  const batchId = repo.createBatch('synthetic-api-delete-all', start);
  const sourceFileId = repo.insertSourceFile({
    batchId,
    sha256: 'synthetic-api-delete-all-hash',
    originalName: 'synthetic-api-ride.csv',
    detectedType: 'metric:heart_rate',
    parserVersion: 'synthetic-v1',
    status: 'imported',
    sizeBytes: 12,
  });
  const workoutId = repo.createWorkout(
    'outdoor_cycling',
    start,
    start + 60_000,
    'synthetic-api-delete-all',
  );
  repo.linkSourceFileToWorkout(workoutId, sourceFileId);
  repo.insertMetricSeries({
    workoutId,
    sourceFileId,
    metric: 'heart_rate',
    unit: 'bpm',
    source: null,
    samples: [
      { t: start, value: 100 },
      { t: start + 60_000, value: 105 },
    ],
  });
  repo.setSetting('analytics', {
    timeZone: 'Pacific/Honolulu',
    hrZoneBounds: [90, 110, 130, 150, 170],
    movingSpeedThresholdMs: 2,
    minCoverageForEfficiency: 0.8,
    elevationHysteresisM: 2,
  });
  db.prepare(
    `INSERT INTO analytics_snapshots
       (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
     VALUES (NULL, 'global', 'synthetic-v1', 'settings-hash', 'input-hash', '{}', ?)`,
  ).run(start);
  db.prepare(
    `INSERT INTO insight_runs
       (workout_id, provider, model_id, prompt_version, schema_version, input_hash,
        payload_json, output_json, validation_status, created_at)
     VALUES (NULL, 'disabled', NULL, 'synthetic-v1', 'synthetic-v1', 'input-hash',
             '{}', NULL, 'not_run', ?)`,
  ).run(start);
}

function rowCount(table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

function beginPartialImport(payload: string): Promise<{
  request: ClientRequest;
  remainder: string;
  response: Promise<{ status: number; body: unknown }>;
}> {
  const target = new URL(`${base}/api/import`);
  const splitAt = Math.max(1, Math.floor(payload.length / 2));
  const first = payload.slice(0, splitAt);
  const remainder = payload.slice(splitAt);

  return new Promise((resolve, reject) => {
    let resolveResponse: (value: { status: number; body: unknown }) => void = () => {};
    let rejectResponse: (reason: unknown) => void = () => {};
    const response = new Promise<{ status: number; body: unknown }>(
      (responseResolve, responseReject) => {
        resolveResponse = responseResolve;
        rejectResponse = responseReject;
      },
    );
    const partialRequest = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          ...MUTATION_HEADERS,
          Expect: '100-continue',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolveResponse({
              status: res.statusCode ?? 0,
              body: JSON.parse(body) as unknown,
            });
          } catch (error) {
            rejectResponse(error);
          }
        });
      },
    );
    partialRequest.once('error', (error) => {
      reject(error);
      rejectResponse(error);
    });
    partialRequest.once('continue', () => {
      partialRequest.write(first);
      resolve({ request: partialRequest, remainder, response });
    });
    partialRequest.flushHeaders();
  });
}

async function waitForDeleteAdmission(): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${base}/api/workouts`);
    if (response.status === 503) return response;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('delete_all_admission_timeout');
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  seedSyntheticState();
  server = createApiServer({ db, now: () => Date.UTC(2033, 3, 6) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  db.close();
});

describe('DELETE /api/data', () => {
  it('requires an exact explicit confirmation without mutating state', async () => {
    const before = {
      workouts: rowCount('workouts'),
      settings: rowCount('user_settings'),
      snapshots: rowCount('analytics_snapshots'),
    };

    const response = await fetch(`${base}/api/data`, {
      method: 'DELETE',
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ confirmed: false }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'delete_all_confirmation_required' });
    expect({
      workouts: rowCount('workouts'),
      settings: rowCount('user_settings'),
      snapshots: rowCount('analytics_snapshots'),
    }).toEqual(before);

    const unexpectedKey = await fetch(`${base}/api/data`, {
      method: 'DELETE',
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ confirmed: true, unexpected: true }),
    });
    expect(unexpectedKey.status).toBe(409);
    expect(rowCount('workouts')).toBe(before.workouts);
  });

  it('returns a value-free result, clears persisted state, and exposes default settings', async () => {
    const migrationsBefore = db
      .prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid')
      .all();

    const response = await fetch(`${base}/api/data`, {
      method: 'DELETE',
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ confirmed: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    for (const table of [
      'workouts',
      'source_files',
      'import_batches',
      'metric_series',
      'metric_samples',
      'analytics_snapshots',
      'insight_runs',
      'user_settings',
    ]) {
      expect(rowCount(table), table).toBe(0);
    }
    expect(db.prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid').all()).toEqual(
      migrationsBefore,
    );

    const workouts = await (await fetch(`${base}/api/workouts`)).json();
    expect(workouts).toEqual({ workouts: [] });
    const settings = (await (await fetch(`${base}/api/settings`)).json()) as {
      settings: {
        hrZoneBounds: number[] | null;
        movingSpeedThresholdMs: number;
        minCoverageForEfficiency: number;
        elevationHysteresisM: number;
        timeZone: string;
      };
    };
    expect(settings.settings).toMatchObject({
      hrZoneBounds: null,
      movingSpeedThresholdMs: 1,
      minCoverageForEfficiency: 0.7,
      elevationHysteresisM: 1,
    });
    expect(settings.settings.timeZone).toBe(systemTimeZone());
  });

  it('returns a stable error and rolls back all rows when deletion fails', async () => {
    const before = {
      workouts: rowCount('workouts'),
      sources: rowCount('source_files'),
      settings: rowCount('user_settings'),
      snapshots: rowCount('analytics_snapshots'),
      insights: rowCount('insight_runs'),
    };
    db.exec(`
      CREATE TRIGGER synthetic_api_delete_all_failure
      BEFORE DELETE ON user_settings
      BEGIN
        SELECT RAISE(ABORT, 'synthetic_private_value');
      END;
    `);

    const response = await fetch(`${base}/api/data`, {
      method: 'DELETE',
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ confirmed: true }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'delete_all_failed' });
    expect(JSON.stringify(body)).not.toContain('synthetic_private_value');
    expect({
      workouts: rowCount('workouts'),
      sources: rowCount('source_files'),
      settings: rowCount('user_settings'),
      snapshots: rowCount('analytics_snapshots'),
      insights: rowCount('insight_runs'),
    }).toEqual(before);
  });

  it('waits for an already-admitted import, rejects new work, and deletes last', async () => {
    const csv = [
      'Date/Time,Avg (bpm),Source',
      '2037-08-09T10:00:00Z,117,Synthetic Concurrent Device',
      '2037-08-09T10:01:00Z,121,Synthetic Concurrent Device',
    ].join('\n');
    const importPayload = JSON.stringify({
      files: [
        {
          id: 'synthetic-concurrent-import',
          name: 'Outdoor Cycling-Heart Rate-20370809_100000.csv',
          dataBase64: Buffer.from(csv).toString('base64'),
        },
      ],
    });
    const partialImport = await beginPartialImport(importPayload);

    const deleteResponsePromise = fetch(`${base}/api/data`, {
      method: 'DELETE',
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ confirmed: true }),
    });
    const rejected = await waitForDeleteAdmission();
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: 'delete_all_in_progress' });

    partialImport.request.end(partialImport.remainder);
    const importResponse = await partialImport.response;
    const deleteResponse = await deleteResponsePromise;

    expect(importResponse.status).toBe(200);
    expect(importResponse.body).toMatchObject({
      result: { imported: 1, workoutsCreated: 1 },
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ deleted: true });
    expect(rowCount('workouts')).toBe(0);
    expect(rowCount('source_files')).toBe(0);
    expect(rowCount('user_settings')).toBe(0);
  });
});
