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

  it('associates by internal sample times, not filename stamps', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    // Same content windows, deliberately misleading filename stamps.
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
    runImport(db, files, { now: FIXED_NOW });
    expect(repo.countRows('workouts')).toBe(1);
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
