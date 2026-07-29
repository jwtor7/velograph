import { describe, expect, it } from 'vitest';
import { LEAK_MARKER, SYNTHETIC_GEO_BOX, scanFile } from './privacy-scan.mjs';

const buf = (s) => Buffer.from(s, 'utf8');
const rules = (violations) => violations.map((v) => v.rule);
// A real-world (public landmark) coordinate pair, assembled at runtime so this
// test file itself never contains a literal coordinate for the scanner to flag.
const realLat = [43, 653226].join('.');
const realLon = ['-79', 383184].join('.');

describe('privacy scanner (PRD §12.2)', () => {
  it('blocks the deliberate synthetic leak marker anywhere', () => {
    const v = scanFile('src/app.ts', buf(`const x = "${LEAK_MARKER}";`));
    expect(rules(v)).toContain('leak-marker-canary');
  });

  it('blocks CSV and GPX files outside fixtures/synthetic/', () => {
    expect(rules(scanFile('data/ride.csv', buf('a,b\n')))).toContain(
      'data-file-outside-synthetic-fixtures',
    );
    expect(rules(scanFile('ride.gpx', buf('<gpx/>')))).toContain(
      'data-file-outside-synthetic-fixtures',
    );
  });

  it('allows synthetic fixtures with in-box coordinates', () => {
    const lat = (SYNTHETIC_GEO_BOX.latMin + SYNTHETIC_GEO_BOX.latMax) / 2;
    const lon = (SYNTHETIC_GEO_BOX.lonMin + SYNTHETIC_GEO_BOX.lonMax) / 2;
    const csv = `Timestamp,Latitude,Longitude\n2031-04-02T07:30:00Z,${lat.toFixed(6)},${lon.toFixed(6)}\n`;
    expect(
      scanFile('fixtures/synthetic/rides/Outdoor Cycling-Route-20310402_073000.csv', buf(csv)),
    ).toEqual([]);
  });

  it('blocks coordinates outside the synthetic box even under fixtures/', () => {
    const csv = `Timestamp,Latitude,Longitude\n2031-04-02T07:30:00Z,${realLat},${realLon}\n`;
    const v = scanFile('fixtures/synthetic/rides/x.csv', buf(csv));
    expect(rules(v)).toContain('gps-coordinates-outside-synthetic-box');
  });

  it('blocks coordinate pairs in source/docs files', () => {
    const v = scanFile('docs/notes.md', buf(`start was ${realLat}, ${realLon} that day`));
    expect(rules(v)).toContain('gps-coordinates-outside-synthetic-box');
  });

  it('blocks GPX lat/lon attributes outside fixtures', () => {
    const gpxLine = `<trkpt lat="${realLat}" lon="${realLon}"></trkpt>`;
    const v = scanFile('apps/web/sample.txt', buf(gpxLine));
    expect(rules(v)).toContain('gps-latitude-outside-synthetic-box');
  });

  it('blocks Health Auto Export filenames outside fixtures', () => {
    const v = scanFile('Outdoor Cycling-Heart Rate-20250101_101500.csv', buf('a\n'));
    expect(rules(v)).toContain('health-auto-export-filename-outside-fixtures');
  });

  it('blocks Apple Health source/device strings', () => {
    const device = ['Ap', 'ple ', 'Watch'].join('');
    const v = scanFile(
      'fixtures/synthetic/rides/x.csv',
      buf(`Date,Source\n2031,${device} Series 9\n`),
    );
    expect(rules(v)).toContain('apple-device-string');
  });

  it('blocks home-directory absolute paths', () => {
    const path = ['/Us', 'ers/', 'somebody/', 'Health/export.csv'].join('');
    const v = scanFile('docs/guide.md', buf(`see ${path}`));
    expect(rules(v)).toContain('home-directory-absolute-path');
  });

  it('blocks SQLite magic bytes regardless of extension', () => {
    const v = scanFile('assets/blob.bin', buf('SQLite format 3\u0000rest'));
    expect(rules(v)).toContain('sqlite-magic-bytes');
  });

  it('blocks archives and sqlite/env/auth files by name', () => {
    expect(rules(scanFile('backup.zip', buf('x')))).toContain('archive-file');
    expect(rules(scanFile('app.db', buf('x')))).toContain('sqlite-file-extension');
    expect(rules(scanFile('.env.local', buf('x')))).toContain('env-file');
    expect(rules(scanFile('config/auth.json', buf('{}')))).toContain('provider-auth-cache-file');
  });

  it('blocks secret patterns', () => {
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    expect(rules(scanFile('src/config.ts', buf(`const k = "${key}";`)))).toContain(
      'aws-access-key',
    );
    const gh = 'ghp_' + 'a'.repeat(36);
    expect(rules(scanFile('src/config.ts', buf(gh)))).toContain('github-token');
  });

  it('blocks unexpected binary files but allows bundled images', () => {
    const bin = Buffer.concat([buf('junk'), Buffer.from([0, 1, 2, 3])]);
    expect(rules(scanFile('assets/blob.dat', bin))).toContain('unexpected-binary-file');
    expect(rules(scanFile('assets/logo.png', bin))).toEqual([]);
  });

  it('passes clean source files', () => {
    expect(scanFile('packages/analytics/src/index.ts', buf('export const v = 1;\n'))).toEqual([]);
  });
});
