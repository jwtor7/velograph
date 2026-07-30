import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '@velograph/db';
import { classifyImportFileName, parseHaeGpx } from './adapters.ts';
import { runImport } from './importer.ts';

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
    expect(classifyImportFileName('Outdoor Cycling-Heart Rate-20330405_070000.gpx').kind).toBe(
      'unsupported',
    );
    expect(classifyImportFileName('Outdoor Cycling-Route-synthetic.gpx').kind).toBe('unsupported');
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
        code: 'unrecognized_headers',
      },
    ]);
  });

  it('never defaults a non-cycling GPX route to outdoor cycling', () => {
    expect(() =>
      parseHaeGpx('Running-Route-20330405_070000.gpx', new TextDecoder().decode(syntheticGpx)),
    ).toThrowError(expect.objectContaining({ code: 'unsupported_file_type' }));
  });

  it('quarantines noncanonical cycling GPX names classified as unsupported', () => {
    db = openDatabase(':memory:');
    const names = [
      'Outdoor Cycling-Route-synthetic.gpx',
      'Outdoor Cycling-Heart Rate-20330405_070000.gpx',
    ];
    const files = names.map((name, index) => ({
      name,
      data: new TextEncoder().encode(
        `${new TextDecoder().decode(syntheticGpx)}${' '.repeat(index)}`,
      ),
    }));
    const result = runImport(db, files, { now: Date.UTC(2033, 3, 6), timeZone: 'UTC' });

    expect(result).toMatchObject({ imported: 0, skipped: 0, quarantined: 2 });
    expect(result.quarantinedFiles).toEqual(
      [...names].sort().map((name) => ({ name, code: 'unsupported_file_type' })),
    );
  });
});
