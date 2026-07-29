import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { openDatabase, type Database } from '@velograph/db';
import type { ImportUploadLimits } from '@velograph/shared';
import { zipSync } from 'fflate';
import { createApiServer } from './server.ts';

const limits: ImportUploadLimits = {
  maxFiles: 2,
  maxFileBytes: 256,
  maxTotalDecodedBytes: 300,
  maxBodyBytes: 1024,
  maxNameLength: 80,
  maxIdLength: 24,
};
const headers = { 'Content-Type': 'application/json', 'x-velograph-request': '1' };

let db: Database;
let server: Server;
let base: string;

beforeAll(async () => {
  db = openDatabase(':memory:');
  server = createApiServer({
    db,
    now: () => Date.UTC(2034, 4, 2),
    importUploadLimits: limits,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  db.close();
});

function upload(id: string, name: string, data: Uint8Array | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return { id, name, dataBase64: Buffer.from(bytes).toString('base64') };
}

function persistentRows(): { batches: number; sources: number; workouts: number } {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    batches: count('import_batches'),
    sources: count('source_files'),
    workouts: count('workouts'),
  };
}

async function post(path: string, body: unknown | string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function postChunked(
  path: string,
  chunks: string[],
): Promise<{ status: number; body: unknown }> {
  const { request } = await import('node:http');
  const target = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

async function postThenDisconnect(path: string, body: unknown): Promise<void> {
  const { request } = await import('node:http');
  const target = new URL(`${base}${path}`);
  await new Promise<void>((resolve) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers,
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    req.on('error', finish);
    req.on('finish', () => {
      req.socket?.resetAndDestroy();
      finish();
    });
    req.end(JSON.stringify(body));
  });
}

describe('bounded strict upload API (#23/#26)', () => {
  it('returns selection-bound inventory without exposing content hashes', async () => {
    const response = await post('/api/import/inventory', {
      files: [
        upload('same-1', 'Outdoor Cycling-Heart Rate-20340501_070000.csv', 'A'),
        upload('same-2', 'Outdoor Cycling-Heart Rate-20340501_070000.csv', 'B'),
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      inventory: Record<string, unknown>[];
    };
    expect(body.inventory).toEqual([
      {
        id: 'same-1',
        name: 'Outdoor Cycling-Heart Rate-20340501_070000.csv',
        sizeBytes: 1,
        classification: 'recognized',
        detectedType: 'outdoor_cycling:heartrate:csv',
      },
      {
        id: 'same-2',
        name: 'Outdoor Cycling-Heart Rate-20340501_070000.csv',
        sizeBytes: 1,
        classification: 'recognized',
        detectedType: 'outdoor_cycling:heartrate:csv',
      },
    ]);
    expect(body.inventory.every((item) => !('sha256' in item))).toBe(true);
  });

  it('reports duplicate, unsupported, unmodelled, and non-cycling classifications', async () => {
    const same = new Uint8Array([9]);
    const response = await post('/api/import/inventory', {
      files: [
        upload('one', 'Outdoor Cycling-Heart Rate-20340501_070000.csv', same),
        upload('two', 'Outdoor Cycling-Heart Rate-20340501_070000.csv', same),
      ],
    });
    expect(response.status).toBe(200);
    const duplicateBody = (await response.json()) as {
      inventory: { classification: string }[];
    };
    expect(duplicateBody.inventory.map((item) => item.classification)).toEqual([
      'recognized',
      'duplicate_in_selection',
    ]);

    const classifications = await post('/api/import/inventory', {
      files: [
        upload('metric', 'Outdoor Cycling-Respiratory Rate-20340501_070000.csv', 'M'),
        upload('run', 'Running-Route-20340501_070000.gpx', 'R'),
      ],
    });
    expect(classifications.status).toBe(200);
    expect(
      (
        (await classifications.json()) as {
          inventory: { classification: string }[];
        }
      ).inventory.map((item) => item.classification),
    ).toEqual(['unmodelled_metric', 'non_cycling_workout']);

    const unsupported = await post('/api/import/inventory', {
      files: [upload('other', 'unrecognized.gpx', 'U')],
    });
    expect(unsupported.status).toBe(200);
    expect(
      (
        (await unsupported.json()) as {
          inventory: { classification: string }[];
        }
      ).inventory.map((item) => item.classification),
    ).toEqual(['unsupported']);
  });

  it('rejects oversized encoded bodies with 413 before parsing', async () => {
    const response = await post('/api/import', 'x'.repeat(limits.maxBodyBytes + 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'import_body_too_large' });
  });

  it('stops retaining a chunked body when the streaming cap is crossed', async () => {
    const response = await postChunked('/api/import', [
      'x'.repeat(Math.floor(limits.maxBodyBytes / 2)),
      'y'.repeat(Math.floor(limits.maxBodyBytes / 2) + 2),
    ]);
    expect(response).toEqual({
      status: 413,
      body: { error: 'import_body_too_large' },
    });
  });

  it('rejects excessive file count with 413', async () => {
    const response = await post('/api/import', {
      files: [
        upload('one', 'synthetic-one.csv', ''),
        upload('two', 'synthetic-two.csv', ''),
        upload('three', 'synthetic-three.csv', ''),
      ],
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'import_file_count_exceeded' });
  });

  it('rejects per-file and aggregate decoded expansion with 413', async () => {
    const perFile = await post('/api/import', {
      files: [
        upload(
          'large',
          'Outdoor Cycling-Heart Rate-20340501_070000.csv',
          new Uint8Array(limits.maxFileBytes + 1),
        ),
      ],
    });
    expect(perFile.status).toBe(413);
    expect(await perFile.json()).toEqual({ error: 'import_file_too_large' });

    const aggregate = await post('/api/import', {
      files: [
        upload('first', 'Outdoor Cycling-Heart Rate-20340501_070000.csv', new Uint8Array(151)),
        upload(
          'second',
          'Outdoor Cycling-Cycling Cadence-20340501_070000.csv',
          new Uint8Array(150),
        ),
      ],
    });
    expect(aggregate.status).toBe(413);
    expect(await aggregate.json()).toEqual({ error: 'import_total_size_exceeded' });
  });

  it.each([
    [
      'per-entry',
      zipSync({ 'synthetic.csv': new TextEncoder().encode('A'.repeat(limits.maxFileBytes + 1)) }),
    ],
    [
      'aggregate',
      zipSync({
        'synthetic-a.csv': new TextEncoder().encode('A'.repeat(151)),
        'synthetic-b.csv': new TextEncoder().encode('B'.repeat(151)),
      }),
    ],
  ])('applies loose-upload %s byte budgets to expanded ZIP contents', async (_case, archive) => {
    expect(archive.byteLength).toBeLessThanOrEqual(limits.maxFileBytes);
    const response = await post('/api/import', {
      files: [upload('archive', 'synthetic.zip', archive)],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        imported: 0,
        quarantined: 1,
        quarantinedFiles: [{ name: 'synthetic.zip', code: 'zip_limits_exceeded' }],
      },
    });
  });

  it.each(['abc', 'AB==', '%%%%'])('rejects non-canonical base64 atomically: %s', async (value) => {
    const before = persistentRows();
    const response = await post('/api/import', {
      files: [
        upload(
          'valid',
          'Outdoor Cycling-Heart Rate-20340501_070000.csv',
          'Date/Time,Avg (bpm)\n2034-05-01T07:00:00Z,120',
        ),
        {
          id: 'invalid',
          name: 'Outdoor Cycling-Cycling Cadence-20340501_070000.csv',
          dataBase64: value,
        },
      ],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_base64' });
    expect(persistentRows()).toEqual(before);
  });

  it('rejects mixed-schema requests atomically with a value-free stable code', async () => {
    const before = persistentRows();
    const privateMarker = 'private-synthetic-marker.csv';
    const response = await post('/api/import', {
      files: [
        upload(
          'valid',
          'Outdoor Cycling-Heart Rate-20340501_070000.csv',
          'Date/Time,Avg (bpm)\n2034-05-01T07:00:00Z,120',
        ),
        {
          id: 'invalid',
          name: privateMarker,
          dataBase64: '',
          extra: 'not allowed',
        },
      ],
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'invalid_import_payload' });
    expect(text).not.toContain(privateMarker);
    expect(persistentRows()).toEqual(before);
  });

  it('rejects duplicate client identities and empty selections', async () => {
    const duplicate = await post('/api/import', {
      files: [upload('same', 'synthetic-one.csv', ''), upload('same', 'synthetic-two.csv', '')],
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: 'duplicate_file_id' });

    const empty = await post('/api/import', { files: [] });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'no_files' });
  });

  it('rejects malformed JSON with a stable code', async () => {
    const response = await post('/api/import', '{"files":');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('does not commit an import whose loopback client disconnects after upload', async () => {
    const before = persistentRows();
    await postThenDisconnect('/api/import', {
      files: [
        upload(
          'cancelled',
          'Outdoor Cycling-Heart Rate-20340501_071500.csv',
          'Date/Time,Avg (bpm)\n2034-05-01T07:15:00Z,121',
        ),
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(persistentRows()).toEqual(before);
  });
});
