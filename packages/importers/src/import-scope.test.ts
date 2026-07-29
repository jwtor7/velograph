import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '@velograph/db';
import { classifyImportFileName, parseHaeGpx } from './adapters.ts';
import { runImport } from './importer.ts';
import { inventoryFiles } from './inventory.ts';

const syntheticSouth = -48.5;
const syntheticWest = -123.5;
const syntheticGpx = new TextEncoder().encode(`<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
<trkpt lat="${syntheticSouth}" lon="${syntheticWest}"><time>2033-04-05T07:00:00Z</time></trkpt>
<trkpt lat="${syntheticSouth + 0.0001}" lon="${syntheticWest - 0.0001}"><time>2033-04-05T07:01:00Z</time></trkpt>
</trkseg></trk></gpx>`);

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('import scope classification (#53)', () => {
  it('classifies modelled, unmodelled, non-cycling, archive, and malformed names', () => {
    expect(classifyImportFileName('Outdoor Cycling-Heart Rate-20330405_070000.csv').kind).toBe(
      'supported',
    );
    expect(classifyImportFileName('Indoor Cycling-Respiratory Rate-20330405_070000.csv').kind).toBe(
      'unmodelled_metric',
    );
    expect(classifyImportFileName('Running-Route-20330405_070000.gpx').kind).toBe(
      'non_cycling_workout',
    );
    expect(classifyImportFileName('synthetic.zip').kind).toBe('archive');
    expect(classifyImportFileName('not-an-export.gpx').kind).toBe('unsupported');
  });

  it('normal-skips out-of-scope files without source rows, warnings, or quarantine', () => {
    db = openDatabase(':memory:');
    const result = runImport(
      db,
      [
        {
          name: 'Outdoor Cycling-Respiratory Rate-20330405_070000.csv',
          data: new TextEncoder().encode('synthetic out-of-scope content'),
        },
        {
          name: 'Running-Route-20330405_070000.gpx',
          data: syntheticGpx,
        },
      ],
      { now: Date.UTC(2033, 3, 6), timeZone: 'UTC' },
    );

    expect(result).toMatchObject({
      imported: 0,
      skipped: 2,
      skippedByCode: {
        unmodelled_metric: 1,
        non_cycling_workout: 1,
      },
      quarantined: 0,
      quarantinedFiles: [],
      workoutsCreated: 0,
      workoutsUpdated: 0,
    });
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM source_files').get() as { count: number }).count,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM workouts').get() as { count: number }).count,
    ).toBe(0);
  });

  it('keeps malformed in-scope files in quarantine', () => {
    db = openDatabase(':memory:');
    const result = runImport(
      db,
      [
        {
          name: 'Outdoor Cycling-Heart Rate-20330405_070000.csv',
          data: new TextEncoder().encode('not,a,valid,metric'),
        },
      ],
      { now: Date.UTC(2033, 3, 6), timeZone: 'UTC' },
    );

    expect(result).toMatchObject({ skipped: 0, quarantined: 1 });
    expect(result.quarantinedFiles).toEqual([
      {
        name: 'Outdoor Cycling-Heart Rate-20330405_070000.csv',
        code: 'no_valid_samples',
      },
    ]);
  });

  it('never defaults a non-cycling GPX route to outdoor cycling', () => {
    expect(() =>
      parseHaeGpx('Running-Route-20330405_070000.gpx', new TextDecoder().decode(syntheticGpx)),
    ).toThrowError(expect.objectContaining({ code: 'unsupported_file_type' }));
  });

  it('exposes aggregate skip classifications and exact duplicate status in inventory', () => {
    const same = new TextEncoder().encode('same synthetic bytes');
    const inventory = inventoryFiles([
      {
        name: 'Outdoor Cycling-Respiratory Rate-20330405_070000.csv',
        data: new Uint8Array([1]),
      },
      { name: 'Running-Route-20330405_070000.gpx', data: new Uint8Array([2]) },
      { name: 'Outdoor Cycling-Heart Rate-20330405_070000.csv', data: same },
      { name: 'Outdoor Cycling-Heart Rate-20330405_070000.csv', data: same },
      { name: 'synthetic.zip', data: new Uint8Array([3]) },
      { name: 'unrecognized.gpx', data: new Uint8Array([4]) },
    ]);

    expect(inventory.map((item) => item.classification)).toEqual([
      'unmodelled_metric',
      'non_cycling_workout',
      'recognized',
      'duplicate_in_selection',
      'recognized',
      'unsupported',
    ]);
  });
});
