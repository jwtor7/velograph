import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { extractZip, DEFAULT_ZIP_LIMITS } from './zip.ts';

const mkZip = (entries: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));

function signatureOffset(data: Uint8Array, signature: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset <= data.length - 4; offset++) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error('signature not found');
}

function forgeFirstDeclaredSize(
  source: Uint8Array,
  centralSize: number,
  localSize: number,
): Uint8Array {
  const data = source.slice();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const central = signatureOffset(data, 0x02014b50);
  const local = view.getUint32(central + 42, true);
  view.setUint32(central + 24, centralSize, true);
  view.setUint32(local + 22, localSize, true);
  return data;
}

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

  it('preflights aggregate declared size before inflating any entry', () => {
    const z = mkZip({ 'first.csv': 'A'.repeat(60_000), 'second.csv': 'B'.repeat(60_000) });
    const started: string[] = [];
    expect(() =>
      extractZip(
        z,
        { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 100_000, maxTotalBytes: 100_000 },
        { onEntryStart: (name) => started.push(name) },
      ),
    ).toThrowError(expect.objectContaining({ code: 'zip_limits_exceeded' }));
    expect(started).toEqual([]);
  });

  it('skips hidden and resource entries before size checks and inflation', () => {
    const z = mkZip({
      '__MACOSX/resource.csv': 'A'.repeat(50_000),
      '.hidden.csv': 'B'.repeat(50_000),
      'visible.csv': 'ok',
    });
    const started: string[] = [];
    const out = extractZip(
      z,
      { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 10, maxTotalBytes: 10 },
      { onEntryStart: (name) => started.push(name) },
    );
    expect(started).toEqual(['visible.csv']);
    expect(out.map((entry) => entry.name)).toEqual(['visible.csv']);
  });

  it('rejects central/local declared-size disagreement during preflight', () => {
    const original = mkZip({ 'ride.csv': 'synthetic' });
    const forged = forgeFirstDeclaredSize(original, 1, 2);
    expect(() => extractZip(forged)).toThrowError(
      expect.objectContaining({ code: 'zip_entry_rejected' }),
    );
  });

  it('caps highly compressible forged output before materializing it or starting a later entry', () => {
    const maxOutputBytes = 50_000;
    const bomb = new Uint8Array(10_000_000).fill(65);
    const original = zipSync({
      'bomb.csv': bomb,
      'later.csv': strToU8('must-not-start'),
    });
    expect(original.length).toBeLessThan(maxOutputBytes);
    const forged = forgeFirstDeclaredSize(original, 1, 1);

    for (const limits of [
      { maxEntryBytes: maxOutputBytes, maxTotalBytes: 1_000_000 },
      { maxEntryBytes: 1_000_000, maxTotalBytes: maxOutputBytes },
    ]) {
      const started: string[] = [];
      let observed = 0;
      expect(() =>
        extractZip(
          forged,
          { ...DEFAULT_ZIP_LIMITS, ...limits },
          {
            onEntryStart: (name) => started.push(name),
            onChunk: (_name, bytes) => {
              observed += bytes;
            },
          },
        ),
      ).toThrowError(expect.objectContaining({ code: 'zip_limits_exceeded' }));
      expect(started).toEqual(['bomb.csv']);
      expect(observed).toBe(0);
    }
  });

  it('rejects a forged declared size that differs from final streamed output', () => {
    const original = mkZip({ 'ride.csv': 'synthetic-output' });
    const forged = forgeFirstDeclaredSize(original, 1, 1);
    expect(() => extractZip(forged)).toThrowError(
      expect.objectContaining({ code: 'zip_entry_rejected' }),
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
