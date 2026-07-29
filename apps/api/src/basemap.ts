import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { guardAgainstCheckout } from '@velograph/db';
import DatabaseConstructor, { type Database } from 'better-sqlite3';

const MAX_ZOOM = 22;
const MAX_METADATA_ROWS = 256;
const MAX_METADATA_NAME_BYTES = 128;
const MAX_METADATA_VALUE_BYTES = 4 * 1024;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const EXPECTED_TILE_SIZE = 256;
const DEFAULT_CACHE_ENTRIES = 128;
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

type Bounds = readonly [west: number, south: number, east: number, north: number];

export type BasemapManifest =
  | { state: 'not_configured' }
  | { state: 'invalid' }
  | {
      state: 'ready';
      format: 'raster-mbtiles';
      name: string;
      attribution: string;
      minZoom: number;
      maxZoom: number;
      bounds?: Bounds;
    };

export type BasemapTile =
  | { state: 'ok'; data: Buffer; contentType: string }
  | {
      state: 'unavailable' | 'not_found' | 'too_large' | 'invalid';
    };

export interface BasemapOptions {
  path?: string;
  /**
   * Whether `path` came from an explicit VELO_BASEMAP_PATH override. A
   * missing conventional file is "not_configured"; a missing explicit
   * override is invalid configuration.
   */
  required?: boolean;
  cacheEntries?: number;
  cacheBytes?: number;
}

interface CachedTile {
  data: Buffer;
  contentType: string;
}

class TileCache {
  readonly #entries = new Map<string, CachedTile>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxEntries: number, maxBytes: number) {
    this.#maxEntries = Math.max(0, Math.floor(maxEntries));
    this.#maxBytes = Math.max(0, Math.floor(maxBytes));
  }

  get(key: string): CachedTile | undefined {
    const value = this.#entries.get(key);
    if (!value) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: CachedTile): void {
    if (
      this.#maxEntries === 0 ||
      value.data.byteLength > this.#maxBytes ||
      value.data.byteLength > MAX_TILE_BYTES
    ) {
      return;
    }
    const existing = this.#entries.get(key);
    if (existing) {
      this.#bytes -= existing.data.byteLength;
      this.#entries.delete(key);
    }
    this.#entries.set(key, value);
    this.#bytes += value.data.byteLength;
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      if (oldest) this.#bytes -= oldest.data.byteLength;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}

interface ReadyState {
  database: Database;
  manifest: Extract<BasemapManifest, { state: 'ready' }>;
  format: RasterFormat;
  readTile: (z: number, x: number, tmsRow: number) => BoundedTileRead;
}

type RasterFormat = 'png' | 'jpeg' | 'webp';
type BoundedTileRead =
  { state: 'ok'; data: Buffer } | { state: 'not_found' | 'too_large' | 'invalid' };

/**
 * A read-only, local MBTiles reader. Construction deliberately collapses all
 * filesystem and SQLite failures into a path-free public state.
 */
export class BasemapService {
  #manifest: BasemapManifest;
  #ready: ReadyState | undefined;
  readonly #cache: TileCache;

  private constructor(
    manifest: BasemapManifest,
    ready: ReadyState | undefined,
    options: BasemapOptions,
  ) {
    this.#manifest = manifest;
    this.#ready = ready;
    this.#cache = new TileCache(
      options.cacheEntries ?? DEFAULT_CACHE_ENTRIES,
      options.cacheBytes ?? DEFAULT_CACHE_BYTES,
    );
  }

  static open(options: BasemapOptions = {}): BasemapService {
    if (!options.path) {
      return new BasemapService({ state: 'not_configured' }, undefined, options);
    }

    const required = options.required ?? false;
    if (!isAbsolute(options.path)) {
      return new BasemapService({ state: 'invalid' }, undefined, options);
    }
    if (!existsSync(options.path)) {
      return new BasemapService(
        required ? { state: 'invalid' } : { state: 'not_configured' },
        undefined,
        options,
      );
    }

    let database: Database | undefined;
    try {
      const inputPath = resolve(options.path);
      const inputStat = lstatSync(inputPath);
      if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.nlink !== 1) {
        throw new Error('invalid_basemap');
      }

      const canonicalPath = realpathSync(inputPath);
      // Reject both a direct symlink and any symlinked ancestor. This keeps the
      // configured path identical to the file whose safety was validated.
      if (canonicalPath !== inputPath) throw new Error('invalid_basemap');
      if (guardAgainstCheckout(canonicalPath) !== canonicalPath) throw new Error('invalid_basemap');

      database = new DatabaseConstructor(canonicalPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 1_000,
      });
      database.pragma('trusted_schema = OFF');
      database.pragma('query_only = ON');

      // Re-stat after SQLite opens the file. A replacement between the first
      // lstat and open must not turn the validated pathname into a different
      // inode. Multiple hard links are rejected because another pathname
      // could live inside a checkout while realpath remains unchanged.
      const openedPathStat = statSync(canonicalPath);
      if (
        !openedPathStat.isFile() ||
        openedPathStat.nlink !== 1 ||
        openedPathStat.dev !== inputStat.dev ||
        openedPathStat.ino !== inputStat.ino
      ) {
        throw new Error('invalid_basemap');
      }

      const validated = validateDatabase(database);
      const ready: ReadyState = {
        database,
        manifest: validated.manifest,
        format: validated.format,
        readTile: createTileReader(database),
      };
      return new BasemapService(ready.manifest, ready, options);
    } catch {
      try {
        database?.close();
      } catch {
        // The public state remains path-free even if cleanup also fails.
      }
      return new BasemapService({ state: 'invalid' }, undefined, options);
    }
  }

  getManifest(): BasemapManifest {
    return this.#manifest;
  }

  getTile(z: number, x: number, y: number): BasemapTile {
    const ready = this.#ready;
    if (!ready) return { state: 'unavailable' };
    if (!validCoordinates(z, x, y)) return { state: 'invalid' };
    if (z < ready.manifest.minZoom || z > ready.manifest.maxZoom) {
      return { state: 'invalid' };
    }

    const key = `${z}/${x}/${y}`;
    const cached = this.#cache.get(key);
    if (cached) return { state: 'ok', data: cached.data, contentType: cached.contentType };

    const tmsRow = 2 ** z - 1 - y;
    try {
      const bounded = ready.readTile(z, x, tmsRow);
      if (bounded.state !== 'ok') return bounded;
      const data = bounded.data;
      if (!validRasterDimensions(data, ready.format)) return { state: 'invalid' };

      const value = { data, contentType: contentTypeFor(ready.format) };
      this.#cache.set(key, value);
      return { state: 'ok', ...value };
    } catch {
      return { state: 'invalid' };
    }
  }

  close(): void {
    this.#cache.clear();
    const ready = this.#ready;
    this.#ready = undefined;
    if (!ready) return;
    try {
      ready.database.close();
    } catch {
      // Server shutdown must not be masked by a read-only basemap cleanup.
    }
  }
}

function validateDatabase(database: Database): {
  manifest: Extract<BasemapManifest, { state: 'ready' }>;
  format: RasterFormat;
} {
  const validate = database.transaction(() => validateDatabaseSnapshot(database));
  return validate.deferred();
}

function validateDatabaseSnapshot(database: Database): {
  manifest: Extract<BasemapManifest, { state: 'ready' }>;
  format: RasterFormat;
} {
  const objectType = database.prepare(
    'SELECT type, rootpage, sql FROM sqlite_schema WHERE name = ? COLLATE BINARY LIMIT 1',
  );
  const metadataObject = objectType.get('metadata') as SchemaObject | undefined;
  const tilesObject = objectType.get('tiles') as SchemaObject | undefined;
  if (!isOrdinaryStoredTable(metadataObject) || !isOrdinaryStoredTable(tilesObject)) {
    throw new Error('invalid_basemap');
  }

  requireStandardColumns(database, 'metadata', ['name', 'value']);
  requireStandardColumns(database, 'tiles', ['zoom_level', 'tile_column', 'tile_row', 'tile_data']);
  requireTileLookupIndex(database);

  const metadataDescriptors = database
    .prepare(
      `SELECT
         rowid AS row_id,
         typeof(name) AS name_type,
         CASE WHEN typeof(name) = 'text' THEN octet_length(name) END AS name_bytes,
         typeof(value) AS value_type,
         CASE WHEN typeof(value) = 'text' THEN octet_length(value) END AS value_bytes
       FROM metadata
       ORDER BY rowid
       LIMIT ?`,
    )
    .all(MAX_METADATA_ROWS + 1) as {
    row_id: unknown;
    name_type: unknown;
    name_bytes: unknown;
    value_type: unknown;
    value_bytes: unknown;
  }[];
  if (metadataDescriptors.length > MAX_METADATA_ROWS) throw new Error('invalid_basemap');

  const boundedMetadata = metadataDescriptors.map((row) => {
    if (row.name_type !== 'text' || row.value_type !== 'text') {
      throw new Error('invalid_basemap');
    }
    return {
      rowId: safeInteger(row.row_id),
      nameBytes: boundedLength(row.name_bytes, MAX_METADATA_NAME_BYTES),
      valueBytes: boundedLength(row.value_bytes, MAX_METADATA_VALUE_BYTES),
    };
  });

  const metadataByRowId = database.prepare<[number], { name: unknown; value: unknown }>(
    `SELECT name, value
     FROM metadata
     WHERE rowid = ? AND typeof(name) = 'text' AND typeof(value) = 'text'
     LIMIT 1`,
  );
  const metadata = new Map<string, string>();
  for (const descriptor of boundedMetadata) {
    // The transaction snapshot pins this exact rowid between size proof and
    // materialization, so neither duplicates nor concurrent writes can swap it.
    const row = metadataByRowId.get(descriptor.rowId);
    if (!row || typeof row.name !== 'string' || typeof row.value !== 'string') {
      throw new Error('invalid_basemap');
    }
    if (
      Buffer.byteLength(row.name, 'utf8') !== descriptor.nameBytes ||
      Buffer.byteLength(row.value, 'utf8') !== descriptor.valueBytes
    ) {
      throw new Error('invalid_basemap');
    }
    const name = row.name;
    const value = row.value;
    const key = name.trim().toLowerCase();
    if (key === '' || metadata.has(key)) throw new Error('invalid_basemap');
    metadata.set(key, value);
  }

  const format = parseFormat(metadata.get('format'));
  const scheme = metadata.get('scheme')?.trim().toLowerCase();
  // The MBTiles specification uses TMS tile rows by default. An explicit
  // non-TMS declaration is incompatible with the fixed XYZ-to-TMS transform.
  if (scheme !== undefined && scheme !== 'tms') throw new Error('invalid_basemap');

  const declaredMinZoom = parseZoom(metadata.get('minzoom'));
  const declaredMaxZoom = parseZoom(metadata.get('maxzoom'));
  if (declaredMinZoom === undefined || declaredMaxZoom === undefined) {
    throw new Error('invalid_basemap');
  }
  const minZoom = declaredMinZoom;
  const maxZoom = declaredMaxZoom;
  if (minZoom > maxZoom) throw new Error('invalid_basemap');

  const tileSizeValues = [metadata.get('tile_size'), metadata.get('tilesize')].filter(
    (value): value is string => value !== undefined,
  );
  if (
    tileSizeValues.some((value) => value.trim() !== '256') ||
    new Set(tileSizeValues.map((value) => value.trim())).size > 1
  ) {
    throw new Error('invalid_basemap');
  }

  // Startup validation remains bounded even for a country-scale package.
  // Phase one reads only rowids, scalar coordinates, types, and cheap BLOB
  // lengths. Full tile values are fetched by exact rowid only after all eight
  // sample sizes have passed, in this same read transaction.
  const sampleDescriptors = database
    .prepare(
      `SELECT
         rowid AS row_id,
         typeof(zoom_level) AS zoom_type,
         CASE WHEN typeof(zoom_level) = 'integer' THEN zoom_level END AS zoom_level,
         typeof(tile_column) AS column_type,
         CASE WHEN typeof(tile_column) = 'integer' THEN tile_column END AS tile_column,
         typeof(tile_row) AS row_type,
         CASE WHEN typeof(tile_row) = 'integer' THEN tile_row END AS tile_row,
         typeof(tile_data) AS tile_type,
         CASE WHEN typeof(tile_data) = 'blob' THEN length(tile_data) END AS byte_length
       FROM tiles
       ORDER BY rowid
       LIMIT 8`,
    )
    .all() as {
    row_id: unknown;
    zoom_type: unknown;
    zoom_level: unknown;
    column_type: unknown;
    tile_column: unknown;
    row_type: unknown;
    tile_row: unknown;
    tile_type: unknown;
    byte_length: unknown;
  }[];
  if (sampleDescriptors.length === 0) throw new Error('invalid_basemap');
  const boundedSamples = sampleDescriptors.map((tile) => {
    if (
      tile.zoom_type !== 'integer' ||
      tile.column_type !== 'integer' ||
      tile.row_type !== 'integer' ||
      tile.tile_type !== 'blob'
    ) {
      throw new Error('invalid_basemap');
    }
    const zoom = safeInteger(tile.zoom_level);
    const column = safeInteger(tile.tile_column);
    const row = safeInteger(tile.tile_row);
    if (!validTmsCoordinates(zoom, column, row) || zoom < minZoom || zoom > maxZoom) {
      throw new Error('invalid_basemap');
    }
    return {
      rowId: safeInteger(tile.row_id),
      zoom,
      column,
      row,
      byteLength: boundedLength(tile.byte_length, MAX_TILE_BYTES),
    };
  });

  const tileByRowId = database.prepare<[number, number, number, number], { tile_data: unknown }>(
    `SELECT tile_data
     FROM tiles
     WHERE rowid = ?
       AND zoom_level = ?
       AND tile_column = ?
       AND tile_row = ?
       AND typeof(tile_data) = 'blob'
     LIMIT 1`,
  );
  for (const sample of boundedSamples) {
    const row = tileByRowId.get(sample.rowId, sample.zoom, sample.column, sample.row);
    if (
      !row ||
      !Buffer.isBuffer(row.tile_data) ||
      row.tile_data.byteLength !== sample.byteLength ||
      !validRasterDimensions(row.tile_data, format)
    ) {
      throw new Error('invalid_basemap');
    }
  }

  const name = toPlainText(metadata.get('name') ?? '', 160);
  if (name === '') throw new Error('invalid_basemap');
  const attribution = toPlainText(metadata.get('attribution') ?? '', 1_000);
  const bounds = parseBounds(metadata.get('bounds'));
  const manifest: Extract<BasemapManifest, { state: 'ready' }> = {
    state: 'ready',
    format: 'raster-mbtiles',
    name,
    attribution,
    minZoom,
    maxZoom,
    ...(bounds ? { bounds } : {}),
  };
  return { manifest, format };
}

function requireStandardColumns(
  database: Database,
  table: 'metadata' | 'tiles',
  required: readonly string[],
): void {
  const rows = database.prepare('SELECT name, hidden FROM pragma_table_xinfo(?)').all(table) as {
    name: unknown;
    hidden: unknown;
  }[];
  const reservedRowIds = new Set(['rowid', '_rowid_', 'oid']);
  if (
    rows.some(
      (row) => typeof row.name !== 'string' || reservedRowIds.has(row.name.trim().toLowerCase()),
    )
  ) {
    throw new Error('invalid_basemap');
  }
  for (const column of required) {
    const match = rows.find((row) => row.name === column);
    // pragma_table_xinfo uses hidden=2/3 for generated columns. Required
    // MBTiles values must be ordinary stored columns before they are queried.
    if (!match || match.hidden !== 0) throw new Error('invalid_basemap');
  }

  // Standard MBTiles tables have rowids. This also fails closed on WITHOUT
  // ROWID tables before any value-bearing query is prepared.
  const rowIdProbe =
    table === 'metadata'
      ? database.prepare('SELECT rowid FROM metadata LIMIT 0')
      : database.prepare('SELECT rowid FROM tiles LIMIT 0');
  rowIdProbe.all();
}

interface SchemaObject {
  type: unknown;
  rootpage: unknown;
  sql: unknown;
}

function isOrdinaryStoredTable(value: SchemaObject | undefined): boolean {
  return (
    value?.type === 'table' &&
    typeof value.rootpage === 'number' &&
    Number.isSafeInteger(value.rootpage) &&
    value.rootpage > 0 &&
    typeof value.sql === 'string' &&
    /^\s*CREATE\s+TABLE\b/i.test(value.sql)
  );
}

function requireTileLookupIndex(database: Database): void {
  const index = database
    .prepare(
      `SELECT 1 AS present
       FROM pragma_index_list('tiles') AS indexes
       WHERE indexes."unique" = 1
         AND indexes.partial = 0
         AND (
           SELECT COUNT(*)
           FROM pragma_index_info(indexes.name)
         ) = 3
         AND (
           SELECT COUNT(*)
           FROM pragma_index_info(indexes.name)
           WHERE name IN ('zoom_level', 'tile_column', 'tile_row')
         ) = 3
       LIMIT 1`,
    )
    .get() as { present: number } | undefined;
  if (index?.present !== 1) throw new Error('invalid_basemap');
}

function safeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('invalid_basemap');
  return number;
}

function boundedLength(value: unknown, max: number): number {
  const length = safeInteger(value);
  if (length < 0 || length > max) throw new Error('invalid_basemap');
  return length;
}

function createTileReader(database: Database): ReadyState['readTile'] {
  const descriptorQuery = database.prepare<
    [number, number, number],
    { row_id: unknown; tile_type: unknown; byte_length: unknown }
  >(
    `SELECT
       rowid AS row_id,
       typeof(tile_data) AS tile_type,
       CASE WHEN typeof(tile_data) = 'blob' THEN length(tile_data) END AS byte_length
     FROM tiles
     WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?
     ORDER BY rowid
     LIMIT 2`,
  );
  const dataByRowId = database.prepare<[number, number, number, number], { tile_data: unknown }>(
    `SELECT tile_data
     FROM tiles
     WHERE rowid = ?
       AND zoom_level = ?
       AND tile_column = ?
       AND tile_row = ?
       AND typeof(tile_data) = 'blob'
     LIMIT 1`,
  );

  const read = database.transaction((z: number, x: number, tmsRow: number): BoundedTileRead => {
    const descriptors = descriptorQuery.all(z, x, tmsRow);
    if (descriptors.length === 0) return { state: 'not_found' };
    if (descriptors.length !== 1) return { state: 'invalid' };
    const descriptor = descriptors[0]!;
    if (descriptor.tile_type !== 'blob') return { state: 'invalid' };
    const byteLength = safeInteger(descriptor.byte_length);
    if (byteLength < 0) return { state: 'invalid' };
    if (byteLength > MAX_TILE_BYTES) return { state: 'too_large' };
    const rowId = safeInteger(descriptor.row_id);

    // Only this proven-small, exact rowid is materialized, still inside the
    // same read snapshot as the type and BLOB-length check.
    const row = dataByRowId.get(rowId, z, x, tmsRow);
    if (!row || !Buffer.isBuffer(row.tile_data) || row.tile_data.byteLength !== byteLength) {
      return { state: 'invalid' };
    }
    return { state: 'ok', data: row.tile_data };
  });
  return (z, x, tmsRow) => read.deferred(z, x, tmsRow);
}

function parseFormat(value: string | undefined): RasterFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'png') return 'png';
  if (normalized === 'jpg' || normalized === 'jpeg') return 'jpeg';
  if (normalized === 'webp') return 'webp';
  throw new Error('invalid_basemap');
}

function parseZoom(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d?)$/.test(value.trim())) throw new Error('invalid_basemap');
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_ZOOM) {
    throw new Error('invalid_basemap');
  }
  return parsed;
}

function parseBounds(value: string | undefined): Bounds | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const rawParts = value.split(',');
  if (rawParts.some((part) => part.trim() === '')) throw new Error('invalid_basemap');
  const parts = rawParts.map((part) => Number(part.trim()));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(part)) ||
    parts[0]! < -180 ||
    parts[0]! > 180 ||
    parts[2]! < -180 ||
    parts[2]! > 180 ||
    parts[1]! < -85.051129 ||
    parts[1]! > 85.051129 ||
    parts[3]! < -85.051129 ||
    parts[3]! > 85.051129 ||
    parts[0]! >= parts[2]! ||
    parts[1]! >= parts[3]!
  ) {
    throw new Error('invalid_basemap');
  }
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

function toPlainText(value: string, maxLength: number): string {
  const withoutTags = value.replace(/<[^>]*>/g, ' ');
  const decoded = withoutTags.replace(
    /&(amp|lt|gt|quot|apos|#39);/gi,
    (entity, name: string) =>
      ({
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        '#39': "'",
      })[name.toLowerCase()] ?? entity,
  );
  return decoded
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function validCoordinates(z: number, x: number, y: number): boolean {
  if (
    !Number.isSafeInteger(z) ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    z < 0 ||
    z > MAX_ZOOM ||
    x < 0 ||
    y < 0
  ) {
    return false;
  }
  const width = 2 ** z;
  return x < width && y < width;
}

function validTmsCoordinates(z: number, x: number, row: number): boolean {
  return validCoordinates(z, x, row);
}

function validRasterDimensions(data: Buffer, format: RasterFormat): boolean {
  const dimensions =
    format === 'png'
      ? pngDimensions(data)
      : format === 'jpeg'
        ? jpegDimensions(data)
        : webpDimensions(data);
  return dimensions?.width === EXPECTED_TILE_SIZE && dimensions.height === EXPECTED_TILE_SIZE;
}

function pngDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (
    data.byteLength < 33 ||
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47 ||
    data[4] !== 0x0d ||
    data[5] !== 0x0a ||
    data[6] !== 0x1a ||
    data[7] !== 0x0a ||
    data.readUInt32BE(8) !== 13 ||
    data.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return undefined;
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (
    data.byteLength < 4 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.byteLength - 2] !== 0xff ||
    data[data.byteLength - 1] !== 0xd9
  ) {
    return undefined;
  }

  let offset = 2;
  while (offset < data.byteLength - 2) {
    if (data[offset] !== 0xff) return undefined;
    while (offset < data.byteLength && data[offset] === 0xff) offset += 1;
    if (offset >= data.byteLength) return undefined;
    const marker = data[offset]!;
    offset += 1;

    if (marker === 0xd9) break;
    if (marker === 0x00) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > data.byteLength) return undefined;

    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.byteLength) return undefined;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 8) return undefined;
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    // A dimensions marker must precede scan-compressed bytes.
    if (marker === 0xda) return undefined;
    offset += segmentLength;
  }
  return undefined;
}

function webpDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (
    data.byteLength < 20 ||
    data.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    data.subarray(8, 12).toString('ascii') !== 'WEBP' ||
    data.readUInt32LE(4) + 8 !== data.byteLength
  ) {
    return undefined;
  }

  let offset = 12;
  let canvas: { width: number; height: number } | undefined;
  let image: { width: number; height: number } | undefined;
  while (offset + 8 <= data.byteLength) {
    const chunkType = data.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = data.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    const paddedEnd = dataEnd + (chunkSize & 1);
    if (dataEnd > data.byteLength || paddedEnd > data.byteLength) return undefined;

    if (chunkType === 'VP8X') {
      if (chunkSize !== 10 || canvas) return undefined;
      // Animated tiles are unnecessary and create a larger decoder surface.
      if ((data[dataStart]! & 0x02) !== 0) return undefined;
      canvas = {
        width: readUInt24LE(data, dataStart + 4) + 1,
        height: readUInt24LE(data, dataStart + 7) + 1,
      };
    } else if (chunkType === 'VP8L') {
      if (chunkSize < 5 || image || data[dataStart] !== 0x2f) return undefined;
      const packed = data.readUInt32LE(dataStart + 1);
      image = {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    } else if (chunkType === 'VP8 ') {
      if (
        chunkSize < 10 ||
        image ||
        data[dataStart + 3] !== 0x9d ||
        data[dataStart + 4] !== 0x01 ||
        data[dataStart + 5] !== 0x2a
      ) {
        return undefined;
      }
      image = {
        width: data.readUInt16LE(dataStart + 6) & 0x3fff,
        height: data.readUInt16LE(dataStart + 8) & 0x3fff,
      };
    }
    offset = paddedEnd;
  }
  if (offset !== data.byteLength || !image || image.width === 0 || image.height === 0) {
    return undefined;
  }
  if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) {
    return undefined;
  }
  return image;
}

function readUInt24LE(data: Buffer, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

function contentTypeFor(format: RasterFormat): string {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg') return 'image/jpeg';
  return 'image/webp';
}
