import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDatabase, Repository } from '@velograph/db';
import { ImportAbortedError, preflightImportCancellable, type ImportFile } from './importer.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HARDENING = join(ROOT, 'fixtures', 'synthetic', 'import-hardening');

function fixture(name: string): ImportFile {
  return { name, data: readFileSync(join(HARDENING, name)) };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function countRows(db: ReturnType<typeof openDatabase>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('exact import preflight', () => {
  it('uses the real parser, duplicate inventory, and DB association rules, then rolls back', async () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const ambiguousStart = Date.UTC(2031, 5, 3, 8);
    repo.createWorkout(
      'outdoor_cycling',
      ambiguousStart - 60_000,
      ambiguousStart + 31 * 60_000,
      'synthetic-test',
    );
    repo.createWorkout(
      'outdoor_cycling',
      ambiguousStart - 2 * 60_000,
      ambiguousStart + 32 * 60_000,
      'synthetic-test',
    );
    const before = {
      batches: countRows(db, 'import_batches'),
      sources: countRows(db, 'source_files'),
      workouts: repo.countRows('workouts'),
      series: repo.countRows('metric_series'),
    };

    const duplicate: ImportFile = {
      name: 'Outdoor Cycling-Cycling Cadence-20310605_080000.csv',
      data: bytes('Date/Time,Cadence (rpm)\n2031-06-05T08:00:00Z,79\n2031-06-05T08:30:00Z,82\n'),
    };
    const items = await preflightImportCancellable(
      db,
      [
        fixture('Outdoor Cycling-Cycling Cadence-20310604_080000.csv'),
        duplicate,
        { ...duplicate, data: new Uint8Array(duplicate.data) },
        fixture('Outdoor Cycling-Heart Rate-20310603_080000.csv'),
        {
          name: 'Outdoor Cycling-Heart Rate-20310606_080000.csv',
          data: bytes('not,a,recognized,header\n1,2,3,4\n'),
        },
        { name: 'unrecognized.gpx', data: bytes('<gpx/>') },
        {
          name: 'Outdoor Cycling-Respiratory Rate-20310606_080000.csv',
          data: bytes('synthetic out-of-scope content'),
        },
        { name: 'Running-Route-20310606_080000.gpx', data: bytes('<gpx/>') },
      ],
      { now: Date.UTC(2031, 5, 7), timeZone: 'UTC' },
    );

    expect(items.map((item) => item.classification)).toEqual([
      'recognized',
      'recognized',
      'duplicate',
      'ambiguous',
      'invalid',
      'unsupported',
      'unmodelled_metric',
      'non_cycling_workout',
    ]);
    expect(items[3]!.outcomes).toEqual([
      {
        classification: 'ambiguous',
        code: 'association_ambiguous',
        detectedType: 'metric:heart_rate',
        count: 1,
      },
    ]);
    expect(items[4]!.outcomes[0]).toMatchObject({
      classification: 'invalid',
      code: 'unrecognized_headers',
    });
    expect(items[5]!.outcomes[0]).toMatchObject({
      classification: 'unsupported',
      code: 'unsupported_file_type',
    });
    expect({
      batches: countRows(db, 'import_batches'),
      sources: countRows(db, 'source_files'),
      workouts: repo.countRows('workouts'),
      series: repo.countRows('metric_series'),
    }).toEqual(before);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('observes cancellation without leaving a transaction or preview writes', async () => {
    const db = openDatabase(':memory:');
    const controller = new AbortController();
    controller.abort();

    await expect(
      preflightImportCancellable(
        db,
        [fixture('Outdoor Cycling-Cycling Cadence-20310604_080000.csv')],
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(ImportAbortedError);
    expect(db.inTransaction).toBe(false);
    expect(countRows(db, 'import_batches')).toBe(0);
    db.close();
  });
});
