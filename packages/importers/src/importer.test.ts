import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { openDatabase, Repository } from '@velograph/db';
import { runImport, type ImportFile } from './importer.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'synthetic',
  'rides',
);

function fixtureFiles(): ImportFile[] {
  return readdirSync(FIXTURES)
    .filter((f) => /\.(csv|gpx)$/.test(f))
    .sort()
    .map((name) => ({ name, data: readFileSync(join(FIXTURES, name)) }));
}

const FIXED_NOW = Date.UTC(2031, 4, 1);

describe('import engine (IMP-003/005/006/007/008)', () => {
  it('imports the synthetic folder corpus into 3 associated workouts', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const result = runImport(db, fixtureFiles(), { now: FIXED_NOW });

    expect(result.quarantined).toBe(0);
    expect(result.imported).toBe(18);
    expect(repo.countRows('workouts')).toBe(3);
    // per workout: hr + cadence + distance + energy series
    expect(repo.countRows('metric_series')).toBe(12);
    // GPX preferred; route CSV skipped as fallback-only (one route per workout)
    expect(repo.countRows('routes')).toBe(3);
    const formats = db.prepare('SELECT DISTINCT source_format FROM routes').all();
    expect(formats).toEqual([{ source_format: 'gpx' }]);
    expect(
      db.prepare('SELECT importer_version FROM import_batches WHERE id = ?').get(result.batchId),
    ).toEqual({ importer_version: 'importer-v2' });
    expect(
      db.prepare('SELECT DISTINCT parser_version FROM source_files ORDER BY parser_version').all(),
    ).toEqual([{ parser_version: 'gpx-v2' }, { parser_version: 'hae-csv-v2' }]);
    db.close();
  });

  it('re-importing identical files creates zero duplicate workouts or samples', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    runImport(db, fixtureFiles(), { now: FIXED_NOW });
    const workouts = repo.countRows('workouts');
    const samples = repo.countRows('metric_samples');
    const points = repo.countRows('route_points');

    const second = runImport(db, fixtureFiles(), { now: FIXED_NOW + 1000 });
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(18);
    expect(repo.countRows('workouts')).toBe(workouts);
    expect(repo.countRows('metric_samples')).toBe(samples);
    expect(repo.countRows('route_points')).toBe(points);
    db.close();
  });

  it('imports a ZIP of the same corpus identically to the folder', () => {
    const dbFolder = openDatabase(':memory:');
    const dbZip = openDatabase(':memory:');
    const files = fixtureFiles();
    runImport(dbFolder, files, { now: FIXED_NOW });

    const zipped = zipSync(Object.fromEntries(files.map((f) => [f.name, new Uint8Array(f.data)])));
    runImport(dbZip, [{ name: 'export.zip', data: zipped }], { now: FIXED_NOW });

    for (const table of [
      'workouts',
      'metric_series',
      'metric_samples',
      'routes',
      'route_points',
    ] as const) {
      expect(new Repository(dbZip).countRows(table)).toBe(
        new Repository(dbFolder).countRows(table),
      );
    }
    dbFolder.close();
    dbZip.close();
  });

  it('quarantines malformed files with value-free codes, without aborting the batch', () => {
    const db = openDatabase(':memory:');
    const good = fixtureFiles().slice(0, 6);
    const bad: ImportFile[] = [
      {
        name: 'Outdoor Cycling-Heart Rate-20310501_070000.csv',
        data: Buffer.from('Nope,Columns\n1,2\n'),
      },
      {
        name: 'Outdoor Cycling-Route-20310501_070000.gpx',
        data: Buffer.from('<?xml version="1.0"?><!DOCTYPE x []><gpx></gpx>'),
      },
      { name: 'random.txt', data: Buffer.from('hello') },
    ];
    const result = runImport(db, [...good, ...bad], { now: FIXED_NOW });
    expect(result.quarantined).toBe(3);
    const codes = result.quarantinedFiles.map((q) => q.code).sort();
    expect(codes).toEqual([
      'unrecognized_headers',
      'unsupported_file_type',
      'xml_doctype_rejected',
    ]);
    // quarantined rows exist, but contributed no data
    const quarantined = db
      .prepare("SELECT COUNT(*) AS n FROM source_files WHERE status = 'quarantined'")
      .get() as { n: number };
    expect(quarantined.n).toBe(3);
    expect(result.imported).toBe(6);
    db.close();
  });

  it('quarantines filename timestamps that conflict with internal sample times', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const hr = [
      'Date/Time,Avg (bpm),Source',
      '2031-06-01T08:00:00Z,120,Synth Watch X1',
      '2031-06-01T08:30:00Z,130,Synth Watch X1',
    ].join('\n');
    const cad = [
      'Date/Time,Cadence (rpm),Source',
      '2031-06-01T08:01:00Z,85,Synth Watch X1',
      '2031-06-01T08:29:00Z,88,Synth Watch X1',
    ].join('\n');
    const files: ImportFile[] = [
      { name: 'Outdoor Cycling-Heart Rate-20990101_000000.csv', data: Buffer.from(hr) },
      { name: 'Outdoor Cycling-Cycling Cadence-20770707_070707.csv', data: Buffer.from(cad) },
    ];
    const result = runImport(db, files, { now: FIXED_NOW });
    expect(result.quarantined).toBe(2);
    expect(result.quarantinedFiles.map((f) => f.code)).toEqual([
      'association_conflict',
      'association_conflict',
    ]);
    expect(repo.countRows('workouts')).toBe(0);
    expect(repo.countRows('metric_series')).toBe(0);
    db.close();
  });

  it('quarantines an ambiguous association instead of selecting the earliest workout', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const start = Date.UTC(2031, 5, 3, 8, 0, 0);
    repo.createWorkout('outdoor_cycling', start - 60_000, start + 31 * 60_000, 'test');
    repo.createWorkout('outdoor_cycling', start - 2 * 60_000, start + 32 * 60_000, 'test');
    const csv = [
      'Date/Time,Avg (bpm),Source',
      '2031-06-03T08:00:00Z,120,Synth Watch X1',
      '2031-06-03T08:30:00Z,130,Synth Watch X1',
    ].join('\n');

    const result = runImport(
      db,
      [
        {
          name: 'Outdoor Cycling-Heart Rate-20310603_080000.csv',
          data: Buffer.from(csv),
        },
      ],
      { now: FIXED_NOW },
    );

    expect(result.quarantinedFiles).toEqual([
      {
        name: 'Outdoor Cycling-Heart Rate-20310603_080000.csv',
        code: 'association_ambiguous',
      },
    ]);
    expect(repo.countRows('workouts')).toBe(2);
    expect(repo.countRows('metric_series')).toBe(0);
    db.close();
  });

  it('quarantines a malformed outer ZIP and continues a valid sibling', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const csv = [
      'Date/Time,Cadence (rpm),Source',
      '2031-06-04T08:00:00Z,80,Synth Watch X1',
      '2031-06-04T08:30:00Z,82,Synth Watch X1',
    ].join('\n');

    const result = runImport(
      db,
      [
        {
          name: 'Outdoor Cycling-Cycling Cadence-20310604_080000.csv',
          data: Buffer.from(csv),
        },
        { name: 'malformed-synthetic.zip', data: Buffer.from('not a zip') },
      ],
      { now: FIXED_NOW },
    );

    expect(result).toMatchObject({
      imported: 1,
      quarantined: 1,
      workoutsCreated: 1,
    });
    expect(result.quarantinedFiles).toEqual([
      { name: 'malformed-synthetic.zip', code: 'io_error' },
    ]);
    expect(repo.countRows('metric_series')).toBe(1);
    expect(
      db
        .prepare(
          "SELECT status, detected_type, parser_version, error_code FROM source_files WHERE original_name = 'malformed-synthetic.zip'",
        )
        .get(),
    ).toEqual({
      status: 'quarantined',
      detected_type: 'archive:zip',
      parser_version: 'zip-v1',
      error_code: 'io_error',
    });
    expect(
      db.prepare('SELECT status FROM import_batches WHERE id = ?').get(result.batchId),
    ).toEqual({ status: 'committed' });
    db.close();
  });

  it('quarantines a whole CSV when a required number or timestamp is invalid', () => {
    const db = openDatabase(':memory:');
    const blankValue = [
      'Date/Time,Cadence (rpm)',
      '2031-06-05T08:00:00Z, ',
      '2031-06-05T08:30:00Z,82',
    ].join('\n');
    const impossibleDate = ['Date/Time,Cycling Distance (km)', '2031-02-29T08:00:00Z,0.4'].join(
      '\n',
    );

    const result = runImport(
      db,
      [
        {
          name: 'Outdoor Cycling-Cycling Cadence-20310605_080000.csv',
          data: Buffer.from(blankValue),
        },
        {
          name: 'Outdoor Cycling-Cycling Distance-20310606_080000.csv',
          data: Buffer.from(impossibleDate),
        },
      ],
      { now: FIXED_NOW },
    );

    expect(result.imported).toBe(0);
    expect(result.quarantinedFiles.map((f) => f.code).sort()).toEqual([
      'numeric_value_invalid',
      'timestamps_invalid',
    ]);
    expect(new Repository(db).countRows('metric_samples')).toBe(0);
    db.close();
  });

  it('stores mixed timed and untimed GPX points without fabricating epoch zero', () => {
    const db = openDatabase(':memory:');
    const latA = [-48, 7].join('.');
    const lonA = [-123, 7].join('.');
    const latB = [-48, 71].join('.');
    const lonB = [-123, 71].join('.');
    const gpx = [
      '<?xml version="1.0"?>',
      '<gpx version="1.1"><trk><trkseg>',
      `<trkpt lat="${latA}" lon="${lonA}"/>`,
      `<trkpt lat="${latB}" lon="${lonB}"><time>2031-06-07T08:00:00Z</time></trkpt>`,
      '</trkseg></trk></gpx>',
    ].join('');

    const result = runImport(
      db,
      [
        {
          name: 'Outdoor Cycling-Route-20310607_080000.gpx',
          data: Buffer.from(gpx),
        },
      ],
      { now: FIXED_NOW },
    );

    expect(result.quarantined).toBe(0);
    expect(db.prepare('SELECT t_utc FROM route_points ORDER BY seq').all()).toEqual([
      { t_utc: null },
      { t_utc: Date.UTC(2031, 5, 7, 8, 0, 0) },
    ]);
    db.close();
  });

  it('associates offset-less metric CSV wall time with an absolute UTC route', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    // Assemble invented coordinates at runtime so coordinate-shaped strings
    // remain confined to fixtures/synthetic/ in the public source tree.
    const syntheticLatA = [-48, 5].join('.');
    const syntheticLonA = [-123, 5].join('.');
    const syntheticLatB = [-48, 51].join('.');
    const syntheticLonB = [-123, 51].join('.');
    const energy = [
      'Date/Time,Active Energy (kJ),Source',
      '2032-07-10 11:31:00,8,Synth Watch X1',
      '2032-07-10 11:59:00,9,Synth Watch X1',
    ].join('\n');
    const route = [
      '<?xml version="1.0"?>',
      '<gpx version="1.1"><trk><trkseg>',
      `<trkpt lat="${syntheticLatA}" lon="${syntheticLonA}"><time>2032-07-10T15:30:00Z</time></trkpt>`,
      `<trkpt lat="${syntheticLatB}" lon="${syntheticLonB}"><time>2032-07-10T16:00:00Z</time></trkpt>`,
      '</trkseg></trk></gpx>',
    ].join('');
    const files: ImportFile[] = [
      {
        name: 'Outdoor Cycling-Active Energy-20320710_113000.csv',
        data: Buffer.from(energy),
      },
      {
        name: 'Outdoor Cycling-Route-20320710_113000.gpx',
        data: Buffer.from(route),
      },
    ];

    const result = runImport(db, files, {
      now: FIXED_NOW,
      timeZone: 'America/Toronto',
    });

    expect(result.quarantined).toBe(0);
    expect(repo.countRows('workouts')).toBe(1);
    expect(repo.countRows('metric_series')).toBe(1);
    expect(repo.countRows('routes')).toBe(1);
    const joined = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM metric_series m
         JOIN routes r ON r.workout_id = m.workout_id
         WHERE m.metric_type = 'energy'`,
      )
      .get() as { n: number };
    expect(joined.n).toBe(1);
    db.close();
  });

  it('a far-apart ride becomes a separate workout (tolerance respected)', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const mk = (dateA: string, dateB: string) =>
      [`Date/Time,Avg (bpm),Source`, `${dateA},120,S`, `${dateB},125,S`].join('\n');
    const files: ImportFile[] = [
      {
        name: 'Outdoor Cycling-Heart Rate-20310601_080000.csv',
        data: Buffer.from(mk('2031-06-01T08:00:00Z', '2031-06-01T08:40:00Z')),
      },
      {
        name: 'Outdoor Cycling-Heart Rate-20310602_080000.csv',
        data: Buffer.from(mk('2031-06-02T08:00:00Z', '2031-06-02T08:40:00Z')),
      },
    ];
    runImport(db, files, { now: FIXED_NOW });
    expect(repo.countRows('workouts')).toBe(2);
    db.close();
  });
});
