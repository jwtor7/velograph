import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { openDatabase, type Database } from '@velograph/db';
import DatabaseConstructor from 'better-sqlite3';
import { createApiServer } from './server.ts';

interface TileInput {
  z: number;
  x: number;
  tmsRow: number;
  data: Buffer;
}

interface PackageOptions {
  format?: 'png' | 'jpg' | 'webp';
  tiles?: TileInput[];
  metadata?: Record<string, string>;
}

let workDir: string;
let sequence = 0;

beforeAll(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'velo-basemap-api-')));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('offline MBTiles API', () => {
  it('distinguishes a missing conventional package from an invalid explicit path', async () => {
    const missing = join(workDir, 'missing-default.mbtiles');
    const conventional = await startApi(missing, false);
    try {
      const response = await fetch(`${conventional.base}/api/basemap`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: 'not_configured' });
    } finally {
      await conventional.close();
    }

    const explicit = await startApi(missing, true);
    try {
      const response = await fetch(`${explicit.base}/api/basemap`);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ state: 'invalid' });
      expect(text).not.toContain(workDir);
    } finally {
      await explicit.close();
    }
  });

  it('returns only sanitized, bounded manifest metadata', async () => {
    const path = createPackage({
      metadata: {
        name: '<b>Synthetic Atlas</b> &amp; Co',
        attribution: '<a href="https://invalid.example">Invented Cartographers</a>',
        bounds: '-80.1,40.2,-79.2,41.4',
        tile_size: '256',
      },
    });
    const api = await startApi(path, true);
    try {
      const response = await fetch(`${api.base}/api/basemap`);
      expect(await response.json()).toEqual({
        state: 'ready',
        format: 'raster-mbtiles',
        name: 'Synthetic Atlas & Co',
        attribution: 'Invented Cartographers',
        minZoom: 1,
        maxZoom: 1,
        bounds: [-80.1, 40.2, -79.2, 41.4],
      });
    } finally {
      await api.close();
    }
  });

  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ] as const)(
    'serves %s tiles using XYZ-to-TMS rows without browser persistence',
    async (format, mime) => {
      const data = tileBytes(format, 0x36);
      const path = createPackage({
        format,
        tiles: [{ z: 1, x: 0, tmsRow: 1, data }],
      });
      const api = await startApi(path, true);
      try {
        // XYZ y=0 maps to TMS row 1 at zoom 1.
        const response = await fetch(`${api.base}/api/basemap/tiles/1/0/0`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(mime);
        expect(response.headers.get('content-length')).toBe(String(data.byteLength));
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
        expect((await fetch(`${api.base}/api/basemap/tiles/1/0/1`)).status).toBe(404);
        const crossSite = await fetch(`${api.base}/api/basemap/tiles/1/0/0`, {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        });
        expect(crossSite.status).toBe(403);
        expect(crossSite.headers.get('cache-control')).toBe('no-store');
      } finally {
        await api.close();
      }
    },
  );

  it('rejects symlink and hard-link aliases, checkout packages, and relative overrides', async () => {
    const target = createPackage();
    const alias = join(workDir, 'basemap-alias.mbtiles');
    symlinkSync(target, alias);
    const hardLink = join(workDir, 'basemap-hard-link.mbtiles');
    linkSync(target, hardLink);

    const checkout = join(workDir, 'synthetic-checkout');
    mkdirSync(checkout);
    writeFileSync(join(checkout, '.git'), '');
    const checkoutPackage = createPackage({}, join(checkout, 'basemap.mbtiles'));
    const canonicalParent = join(workDir, 'canonical-parent');
    mkdirSync(canonicalParent);
    const ancestorTarget = createPackage({}, join(canonicalParent, 'basemap.mbtiles'));
    const ancestorAlias = join(workDir, 'ancestor-alias');
    symlinkSync(canonicalParent, ancestorAlias);
    const ancestorSymlinkPath = join(ancestorAlias, 'basemap.mbtiles');

    for (const [path, required] of [
      [alias, true],
      [hardLink, true],
      [checkoutPackage, true],
      [ancestorSymlinkPath, true],
      ['relative-basemap.mbtiles', false],
    ] as const) {
      const api = await startApi(path, required);
      try {
        const text = await (await fetch(`${api.base}/api/basemap`)).text();
        expect(JSON.parse(text)).toEqual({ state: 'invalid' });
        expect(text).not.toContain(workDir);
        expect(text).not.toContain(path);
      } finally {
        await api.close();
      }
    }
    expect(ancestorTarget).toBe(join(canonicalParent, 'basemap.mbtiles'));
  });

  it('rejects an invalid SQLite schema without exposing its path', async () => {
    const path = nextPath();
    const malformed = new DatabaseConstructor(path);
    malformed.exec('CREATE TABLE invented_not_tiles (value TEXT)');
    malformed.close();

    const api = await startApi(path, true);
    try {
      const text = await (await fetch(`${api.base}/api/basemap`)).text();
      expect(JSON.parse(text)).toEqual({ state: 'invalid' });
      expect(text).not.toContain(path);
    } finally {
      await api.close();
    }
  });

  it('rejects generated required columns before evaluating their values', async () => {
    const path = nextPath();
    const generated = new DatabaseConstructor(path);
    generated.exec(`
      CREATE TABLE metadata (name TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE tiles (
        zoom_level INTEGER NOT NULL,
        tile_column INTEGER NOT NULL,
        tile_row INTEGER NOT NULL,
        tile_data BLOB GENERATED ALWAYS AS (zeroblob(8388608)) VIRTUAL
      );
      INSERT INTO metadata VALUES
        ('name', 'Synthetic generated-column package'),
        ('format', 'png'),
        ('scheme', 'tms'),
        ('minzoom', '1'),
        ('maxzoom', '1');
      INSERT INTO tiles (zoom_level, tile_column, tile_row) VALUES (1, 0, 1);
    `);
    generated.close();

    const api = await startApi(path, true);
    try {
      expect(await (await fetch(`${api.base}/api/basemap`)).json()).toEqual({
        state: 'invalid',
      });
    } finally {
      await api.close();
    }
  });

  it('rejects virtual metadata tables before invoking value callbacks', async () => {
    const path = nextPath();
    const virtual = new DatabaseConstructor(path);
    virtual.exec(`
      CREATE VIRTUAL TABLE metadata USING fts5(name, value);
      CREATE TABLE tiles (
        zoom_level INTEGER NOT NULL,
        tile_column INTEGER NOT NULL,
        tile_row INTEGER NOT NULL,
        tile_data BLOB NOT NULL
      );
      CREATE UNIQUE INDEX tile_index
        ON tiles (zoom_level, tile_column, tile_row);
    `);
    virtual
      .prepare('INSERT INTO metadata (name, value) VALUES (?, ?)')
      .run('attribution', 'x'.repeat(128 * 1024));
    virtual
      .prepare(
        'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (1, 0, 1, ?)',
      )
      .run(tileBytes('png'));
    virtual.close();

    const api = await startApi(path, true);
    try {
      expect(await (await fetch(`${api.base}/api/basemap`)).json()).toEqual({
        state: 'invalid',
      });
    } finally {
      await api.close();
    }
  });

  it('bounds oversized metadata and startup tile materialization in SQL', async () => {
    const metadataBomb = createPackage({
      metadata: { attribution: 'x'.repeat(128 * 1024) },
    });
    const metadataApi = await startApi(metadataBomb, true);
    try {
      expect(await (await fetch(`${metadataApi.base}/api/basemap`)).json()).toEqual({
        state: 'invalid',
      });
    } finally {
      await metadataApi.close();
    }

    const tileBomb = createPackage({
      tiles: [
        {
          z: 1,
          x: 0,
          tmsRow: 1,
          data: Buffer.concat([tileBytes('png'), Buffer.alloc(2 * 1024 * 1024)]),
        },
      ],
    });
    const tileApi = await startApi(tileBomb, true);
    try {
      expect(await (await fetch(`${tileApi.base}/api/basemap`)).json()).toEqual({
        state: 'invalid',
      });
    } finally {
      await tileApi.close();
    }
  });

  it.each(['png', 'jpg', 'webp'] as const)(
    'rejects a %s package whose raster dimensions are not exactly 256x256',
    async (format) => {
      const api = await startApi(
        createPackage({
          format,
          tiles: [{ z: 1, x: 0, tmsRow: 1, data: tileBytes(format, 0x20, 255, 256) }],
        }),
        true,
      );
      try {
        expect(await (await fetch(`${api.base}/api/basemap`)).json()).toEqual({
          state: 'invalid',
        });
      } finally {
        await api.close();
      }
    },
  );

  it('fails closed on truncated or oversized raster dimension headers', async () => {
    const jpegBomb = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0xff, 0xd9]);
    const webpBomb = tileBytes('webp');
    webpBomb.writeUInt32LE(0xffffffff, 4);
    const cases = [
      { format: 'jpg' as const, data: jpegBomb },
      { format: 'webp' as const, data: webpBomb },
      { format: 'png' as const, data: tileBytes('png', 0x00, 0xffffffff, 256) },
    ];
    for (const item of cases) {
      const api = await startApi(
        createPackage({
          format: item.format,
          tiles: [{ z: 1, x: 0, tmsRow: 1, data: item.data }],
        }),
        true,
      );
      try {
        expect(await (await fetch(`${api.base}/api/basemap`)).json()).toEqual({
          state: 'invalid',
        });
      } finally {
        await api.close();
      }
    }
  });

  it('rejects invalid coordinates with coordinate-free errors', async () => {
    const api = await startApi(createPackage(), true);
    try {
      for (const route of ['/23/0/0', '/1/2/0', '/1/0/2']) {
        const response = await fetch(`${api.base}/api/basemap/tiles${route}`);
        const text = await response.text();
        expect(response.status).toBe(400);
        expect(JSON.parse(text)).toEqual({ error: 'invalid_tile' });
        expect(text).not.toContain(route);
      }
    } finally {
      await api.close();
    }
  });

  it('rejects tile zooms outside the declared package range', async () => {
    const api = await startApi(createPackage(), true);
    try {
      for (const route of ['/0/0/0', '/2/0/0']) {
        const response = await fetch(`${api.base}/api/basemap/tiles${route}`);
        const text = await response.text();
        expect(response.status).toBe(400);
        expect(JSON.parse(text)).toEqual({ error: 'invalid_tile' });
        expect(text).not.toContain(route);
      }
    } finally {
      await api.close();
    }
  });

  it('treats blank optional bounds as absent', async () => {
    const api = await startApi(createPackage({ metadata: { bounds: '  ' } }), true);
    try {
      expect(await (await fetch(`${api.base}/api/basemap`)).json()).toEqual({
        state: 'ready',
        format: 'raster-mbtiles',
        name: 'Synthetic offline basemap',
        attribution: 'Invented Cartographers',
        minZoom: 1,
        maxZoom: 1,
      });
    } finally {
      await api.close();
    }
  });

  it('caps oversized tile reads and rejects a mismatched tile signature', async () => {
    const validTiles = Array.from({ length: 8 }, (_, x) => ({
      z: 4,
      x,
      tmsRow: 15,
      data: tileBytes('png', x),
    }));
    const oversizedPath = createPackage({
      tiles: [
        ...validTiles,
        {
          z: 4,
          x: 8,
          tmsRow: 15,
          data: Buffer.concat([tileBytes('png'), Buffer.alloc(2 * 1024 * 1024)]),
        },
      ],
      metadata: { minzoom: '4', maxzoom: '4' },
    });
    const oversizedApi = await startApi(oversizedPath, true);
    try {
      const response = await fetch(`${oversizedApi.base}/api/basemap/tiles/4/8/0`);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'tile_too_large' });
    } finally {
      await oversizedApi.close();
    }

    const corruptPath = createPackage({
      tiles: [...validTiles, { z: 4, x: 8, tmsRow: 15, data: tileBytes('jpg', 0x44) }],
      metadata: { minzoom: '4', maxzoom: '4' },
    });
    const corruptApi = await startApi(corruptPath, true);
    try {
      const response = await fetch(`${corruptApi.base}/api/basemap/tiles/4/8/0`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_tile' });
    } finally {
      await corruptApi.close();
    }
  });

  it('serves repeated requests from the bounded in-memory LRU', async () => {
    const original = tileBytes('png', 0x11);
    const replacement = tileBytes('png', 0x77);
    const path = createPackage({ tiles: [{ z: 1, x: 0, tmsRow: 1, data: original }] });
    const api = await startApi(path, true);
    try {
      const first = Buffer.from(
        await (await fetch(`${api.base}/api/basemap/tiles/1/0/0`)).arrayBuffer(),
      );
      expect(first).toEqual(original);

      const writer = new DatabaseConstructor(path);
      writer
        .prepare(
          'UPDATE tiles SET tile_data = ? WHERE zoom_level = 1 AND tile_column = 0 AND tile_row = 1',
        )
        .run(replacement);
      writer.close();

      const second = Buffer.from(
        await (await fetch(`${api.base}/api/basemap/tiles/1/0/0`)).arrayBuffer(),
      );
      expect(second).toEqual(original);
    } finally {
      await api.close();
    }
  });
});

function createPackage(options: PackageOptions = {}, explicitPath?: string): string {
  const path = explicitPath ?? nextPath();
  const format = options.format ?? 'png';
  const tiles = options.tiles ?? [{ z: 1, x: 0, tmsRow: 1, data: tileBytes(format, 0x24) }];
  const metadata = {
    name: 'Synthetic offline basemap',
    attribution: 'Invented Cartographers',
    format,
    scheme: 'tms',
    minzoom: '1',
    maxzoom: '1',
    ...options.metadata,
  };

  const database = new DatabaseConstructor(path);
  database.exec(`
    CREATE TABLE metadata (name TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE tiles (
      zoom_level INTEGER NOT NULL,
      tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL,
      tile_data BLOB NOT NULL
    );
    CREATE UNIQUE INDEX tile_index
      ON tiles (zoom_level, tile_column, tile_row);
  `);
  const insertMetadata = database.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  const insertTile = database.prepare(
    'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
  );
  database.transaction(() => {
    for (const [name, value] of Object.entries(metadata)) insertMetadata.run(name, value);
    for (const tile of tiles) insertTile.run(tile.z, tile.x, tile.tmsRow, tile.data);
  })();
  database.close();
  return path;
}

function nextPath(): string {
  sequence += 1;
  return join(workDir, `synthetic-basemap-${sequence}.mbtiles`);
}

function tileBytes(format: 'png' | 'jpg' | 'webp', marker = 0, width = 256, height = 256): Buffer {
  if (format === 'png') {
    if (width === 256 && height === 256) return validPng(marker);
    const bytes = Buffer.alloc(33, marker);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    bytes[24] = 8;
    bytes[25] = 2;
    return bytes;
  }
  if (format === 'jpg') {
    const bytes = Buffer.alloc(23, marker);
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
    bytes.writeUInt16BE(height, 7);
    bytes.writeUInt16BE(width, 9);
    bytes[11] = 3;
    bytes.set([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 12);
    bytes.set([0xff, 0xd9], 21);
    return bytes;
  }
  const bytes = Buffer.alloc(26, marker);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8L', 12, 'ascii');
  bytes.writeUInt32LE(5, 16);
  bytes[20] = 0x2f;
  const packed = ((width - 1) | ((height - 1) << 14)) >>> 0;
  bytes.writeUInt32LE(packed, 21);
  return bytes;
}

function validPng(marker: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0);
  header.writeUInt32BE(256, 4);
  header.set([8, 2, 0, 0, 0], 8);

  const rows = Buffer.alloc(256 * (1 + 256 * 3));
  for (let y = 0; y < 256; y += 1) {
    const rowStart = y * (1 + 256 * 3);
    rows[rowStart] = 0;
    for (let x = 0; x < 256; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      rows[pixel] = marker;
      rows[pixel + 1] = (marker + x) & 0xff;
      rows[pixel + 2] = (marker + y) & 0xff;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.byteLength);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function startApi(
  basemapPath: string,
  basemapPathRequired: boolean,
): Promise<{ base: string; close: () => Promise<void> }> {
  const database: Database = openDatabase(':memory:');
  const server: Server = createApiServer({ db: database, basemapPath, basemapPathRequired });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
