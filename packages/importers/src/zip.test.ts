import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { extractZip, DEFAULT_ZIP_LIMITS } from './zip.ts';

const mkZip = (entries: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));

describe('guarded ZIP extraction', () => {
  it('extracts flat entries', () => {
    const z = mkZip({ 'a.csv': 'x', 'sub/b.gpx': 'y' });
    const out = extractZip(z);
    expect(out.map((e) => e.name)).toEqual(['a.csv', 'b.gpx']);
  });

  it('rejects path traversal names', () => {
    const z = mkZip({ '../evil.csv': 'x' });
    expect(() => extractZip(z)).toThrowError(
      expect.objectContaining({ code: 'zip_entry_rejected' }),
    );
  });

  it('rejects absolute paths and backslashes', () => {
    expect(() => extractZip(mkZip({ '/etc/passwd': 'x' }))).toThrowError(
      expect.objectContaining({ code: 'zip_entry_rejected' }),
    );
    expect(() => extractZip(mkZip({ 'a\\b.csv': 'x' }))).toThrowError(
      expect.objectContaining({ code: 'zip_entry_rejected' }),
    );
  });

  it('rejects nested archives', () => {
    expect(() => extractZip(mkZip({ 'inner.zip': 'x' }))).toThrowError(
      expect.objectContaining({ code: 'zip_entry_rejected' }),
    );
  });

  it('enforces the entry-count limit', () => {
    const z = mkZip(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.csv`, 'x'])));
    expect(() => extractZip(z, { ...DEFAULT_ZIP_LIMITS, maxEntries: 3 })).toThrowError(
      expect.objectContaining({ code: 'zip_limits_exceeded' }),
    );
  });

  it('enforces decompressed-size caps (bomb guard)', () => {
    const big = 'A'.repeat(200_000);
    const z = mkZip({ 'big.csv': big });
    expect(() => extractZip(z, { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 50_000 })).toThrowError(
      expect.objectContaining({ code: 'zip_limits_exceeded' }),
    );
    expect(() => extractZip(z, { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 50_000 })).toThrowError(
      expect.objectContaining({ code: 'zip_limits_exceeded' }),
    );
  });

  it('skips macOS resource-fork noise', () => {
    const z = mkZip({ '__MACOSX/a.csv': 'x', 'a.csv': 'real' });
    const out = extractZip(z);
    expect(out).toHaveLength(1);
    expect(new TextDecoder().decode(out[0]!.data)).toBe('real');
  });

  it('rejects garbage input as io_error', () => {
    expect(() => extractZip(strToU8('not a zip'))).toThrowError(
      expect.objectContaining({ code: 'io_error' }),
    );
  });
});
