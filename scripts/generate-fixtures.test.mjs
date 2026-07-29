import { describe, expect, it } from 'vitest';
import { generateCorpus, generateRide, rideDefs, SYNTHETIC_SOURCE } from './generate-fixtures.mjs';
import { scanFile, SYNTHETIC_GEO_BOX } from './privacy-scan.mjs';

describe('synthetic fixture generator', () => {
  it('is byte-deterministic for the same seed', () => {
    const a = generateCorpus({ rides: 3, seed: 1000 });
    const b = generateCorpus({ rides: 3, seed: 1000 });
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const key of a.keys()) expect(a.get(key)).toEqual(b.get(key));
  });

  it('produces different data for a different seed', () => {
    const a = generateCorpus({ rides: 1, seed: 1000 });
    const b = generateCorpus({ rides: 1, seed: 2000 });
    const name = [...a.keys()].find((k) => k.includes('Heart Rate'));
    expect(a.get(name)).not.toEqual(b.get(name));
  });

  it('keeps every route point inside the synthetic geo box', () => {
    for (const def of rideDefs(4, 1000)) {
      for (const p of generateRide(def).route) {
        expect(p.lat).toBeGreaterThanOrEqual(SYNTHETIC_GEO_BOX.latMin);
        expect(p.lat).toBeLessThanOrEqual(SYNTHETIC_GEO_BOX.latMax);
        expect(p.lon).toBeGreaterThanOrEqual(SYNTHETIC_GEO_BOX.lonMin);
        expect(p.lon).toBeLessThanOrEqual(SYNTHETIC_GEO_BOX.lonMax);
      }
    }
  });

  it('emits only synthetic source strings and passes the privacy scanner', () => {
    const corpus = generateCorpus({ rides: 3, seed: 1000 });
    for (const [name, content] of corpus) {
      if (name.endsWith('.csv') && !name.includes('Route')) {
        expect(content).toContain(SYNTHETIC_SOURCE);
      }
      const violations = scanFile(`fixtures/synthetic/rides/${name}`, Buffer.from(content));
      expect(violations).toEqual([]);
    }
  });

  it('creates the expected Health Auto Export-shaped file set per ride', () => {
    const corpus = generateCorpus({ rides: 1, seed: 1000 });
    const names = [...corpus.keys()];
    for (const kind of [
      'Heart Rate',
      'Cycling Cadence',
      'Cycling Distance',
      'Active Energy',
      'Route',
    ]) {
      expect(names.some((n) => n.includes(kind) && n.endsWith('.csv'))).toBe(true);
    }
    expect(names.some((n) => n.endsWith('.gpx'))).toBe(true);
  });

  it('gives ride 1 a recording gap that splits the GPX into segments', () => {
    const corpus = generateCorpus({ rides: 2, seed: 1000 });
    const gpxName = [...corpus.keys()].filter((n) => n.endsWith('.gpx'))[1];
    const segCount = (corpus.get(gpxName).match(/<trkseg>/g) ?? []).length;
    expect(segCount).toBeGreaterThanOrEqual(2);
  });
});
