import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { APP_VERSION, sha256Hex, stableStringify } from '@velograph/shared';
import { readAppliedMigrations } from './migrate.ts';

export const BACKUP_FORMAT_VERSION = 1;

export const BACKUP_INCLUDED_CATEGORIES = {
  analytics: true,
  credentials: false,
  normalizedData: true,
  notesAndTags: true,
  rawSourceFiles: false,
  settings: true,
  sourceMetadata: true,
} as const;

export interface BackupManifest {
  formatVersion: number;
  appVersion: string;
  schemaVersion: string;
  createdAt: number;
  includedCategories: typeof BACKUP_INCLUDED_CATEGORIES;
  checksums: {
    algorithm: 'sha256';
    tables: Record<string, string>;
  };
}

export interface BackupIntegrityReport {
  backupFormatVersion: number | null;
  backupAppVersion: string | null;
  schemaVersion: string;
  manifestVerified: boolean;
  checksumsVerified: boolean;
  databaseIntegrity: 'ok';
  foreignKeys: 'ok';
  legacyBackup: boolean;
  migrationsApplied: string[];
}

export type BackupManifestErrorCode =
  'invalid_backup_manifest' | 'invalid_backup_checksum' | 'incompatible_backup_format';

export class BackupManifestError extends Error {
  readonly code: BackupManifestErrorCode;

  constructor(code: BackupManifestErrorCode) {
    super(code);
    this.name = 'BackupManifestError';
    this.code = code;
  }
}

interface TableInfo {
  name: string;
  pk: number;
}

interface ManifestRow {
  id: unknown;
  formatVersion: unknown;
  appVersion: unknown;
  schemaVersion: unknown;
  createdAt: unknown;
  includedCategoriesJson: unknown;
  checksumsJson: unknown;
  manifestChecksum: unknown;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

function updateValue(hash: ReturnType<typeof createHash>, value: unknown): void {
  if (value === null) {
    hash.update('null');
    return;
  }
  if (typeof value === 'string') {
    hash.update('string');
    updateLengthPrefixed(hash, Buffer.from(value, 'utf8'));
    return;
  }
  if (typeof value === 'number') {
    hash.update('number');
    hash.update(Object.is(value, -0) ? '-0' : String(value));
    return;
  }
  if (typeof value === 'bigint') {
    hash.update('bigint');
    hash.update(value.toString());
    return;
  }
  if (value instanceof Uint8Array) {
    hash.update('bytes');
    updateLengthPrefixed(hash, value);
    return;
  }
  throw new BackupManifestError('invalid_backup_manifest');
}

function tableChecksum(db: Database, table: string): string {
  const quotedTable = quoteIdentifier(table);
  const columns = db.prepare(`PRAGMA table_info(${quotedTable})`).all() as TableInfo[];
  if (columns.length === 0) throw new BackupManifestError('invalid_backup_manifest');
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => quoteIdentifier(column.name));
  const orderBy = primaryKey.length > 0 ? primaryKey.join(', ') : 'rowid';
  const selected = columns.map((column) => quoteIdentifier(column.name)).join(', ');
  const statement = db
    .prepare(`SELECT ${selected} FROM ${quotedTable} ORDER BY ${orderBy}`)
    .raw()
    .safeIntegers();
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, Buffer.from(table, 'utf8'));
  updateLengthPrefixed(
    hash,
    Buffer.from(stableStringify(columns.map(({ name, pk }) => ({ name, pk }))), 'utf8'),
  );
  for (const row of statement.iterate() as Iterable<unknown[]>) {
    hash.update('row');
    for (const value of row) updateValue(hash, value);
  }
  return hash.digest('hex');
}

function dataTables(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
           AND substr(name, 1, 7) <> 'sqlite_'
           AND name <> 'backup_manifests'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

export function calculateTableChecksums(db: Database): Record<string, string> {
  return Object.fromEntries(dataTables(db).map((table) => [table, tableChecksum(db, table)]));
}

export function writeBackupManifest(db: Database, createdAt = Date.now()): BackupManifest {
  const migrations = readAppliedMigrations(db);
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    schemaVersion: migrations.at(-1)?.name ?? 'uninitialized',
    createdAt,
    includedCategories: BACKUP_INCLUDED_CATEGORIES,
    checksums: {
      algorithm: 'sha256',
      tables: calculateTableChecksums(db),
    },
  };
  db.transaction(() => {
    db.prepare('DELETE FROM backup_manifests').run();
    db.prepare(
      `INSERT INTO backup_manifests (
        id,
        format_version,
        app_version,
        schema_version,
        created_at,
        included_categories_json,
        checksums_json,
        manifest_checksum
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      manifest.formatVersion,
      manifest.appVersion,
      manifest.schemaVersion,
      manifest.createdAt,
      stableStringify(manifest.includedCategories),
      stableStringify(manifest.checksums),
      sha256Hex(stableStringify(manifest)),
    );
  })();
  return manifest;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new BackupManifestError('invalid_backup_manifest');
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BackupManifestError('invalid_backup_manifest');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BackupManifestError) throw error;
    throw new BackupManifestError('invalid_backup_manifest');
  }
}

function readManifest(db: Database): BackupManifest | null {
  const table = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'backup_manifests'")
    .get();
  if (!table) return null;
  const rows = db
    .prepare(
      `SELECT
        id,
        format_version AS formatVersion,
        app_version AS appVersion,
        schema_version AS schemaVersion,
        created_at AS createdAt,
        included_categories_json AS includedCategoriesJson,
        checksums_json AS checksumsJson,
        manifest_checksum AS manifestChecksum
       FROM backup_manifests`,
    )
    .all() as ManifestRow[];
  if (rows.length !== 1) throw new BackupManifestError('invalid_backup_manifest');
  const row = rows[0]!;
  if (
    row.id !== 1 ||
    typeof row.formatVersion !== 'number' ||
    !Number.isSafeInteger(row.formatVersion) ||
    typeof row.appVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(row.appVersion) ||
    typeof row.schemaVersion !== 'string' ||
    !/^\d{4}_.+\.sql$/.test(row.schemaVersion) ||
    typeof row.createdAt !== 'number' ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0 ||
    typeof row.manifestChecksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.manifestChecksum)
  ) {
    throw new BackupManifestError('invalid_backup_manifest');
  }
  if (row.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupManifestError('incompatible_backup_format');
  }

  const included = parseObject(row.includedCategoriesJson);
  if (stableStringify(included) !== stableStringify(BACKUP_INCLUDED_CATEGORIES)) {
    throw new BackupManifestError('invalid_backup_manifest');
  }
  const checksumContainer = parseObject(row.checksumsJson);
  const tables = checksumContainer.tables;
  if (
    checksumContainer.algorithm !== 'sha256' ||
    !tables ||
    typeof tables !== 'object' ||
    Array.isArray(tables) ||
    Object.values(tables as Record<string, unknown>).some(
      (checksum) => typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum),
    )
  ) {
    throw new BackupManifestError('invalid_backup_manifest');
  }

  const manifest: BackupManifest = {
    formatVersion: row.formatVersion,
    appVersion: row.appVersion,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    includedCategories: BACKUP_INCLUDED_CATEGORIES,
    checksums: {
      algorithm: 'sha256',
      tables: tables as Record<string, string>,
    },
  };
  if (sha256Hex(stableStringify(manifest)) !== row.manifestChecksum) {
    throw new BackupManifestError('invalid_backup_checksum');
  }
  return manifest;
}

export function verifyBackupManifest(db: Database): {
  manifest: BackupManifest | null;
  legacyBackup: boolean;
} {
  const manifest = readManifest(db);
  if (!manifest) return { manifest: null, legacyBackup: true };
  const migrations = readAppliedMigrations(db);
  if (manifest.schemaVersion !== (migrations.at(-1)?.name ?? 'uninitialized')) {
    throw new BackupManifestError('invalid_backup_manifest');
  }
  const actual = calculateTableChecksums(db);
  if (stableStringify(actual) !== stableStringify(manifest.checksums.tables)) {
    throw new BackupManifestError('invalid_backup_checksum');
  }
  return { manifest, legacyBackup: false };
}
