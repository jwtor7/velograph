import type { Database } from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@velograph/shared';

export interface MigrationDescriptor {
  name: string;
  checksum: string;
}

export interface AppliedMigration extends MigrationDescriptor {
  appliedAt: number;
}

export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
}

export function listMigrations(dir: string): MigrationDescriptor[] {
  return listMigrationFiles(dir).map((name) => ({
    name,
    checksum: sha256Hex(readFileSync(join(dir, name))),
  }));
}

/**
 * A backup may be from an older compatible release, but it may never claim a
 * migration unknown to this binary, skip a migration, or record known
 * migrations in another order.
 */
export function isOrderedMigrationPrefix(recorded: string[], available: string[]): boolean {
  return (
    recorded.length <= available.length &&
    recorded.every((migration, index) => migration === available[index])
  );
}

/**
 * Ordered, forward-only migrations (PRD §10). Files are named
 * NNNN_description.sql and applied in lexicographic order, each inside a
 * transaction, recorded in schema_migrations. Already-applied files must
 * never change; both their ordered name and SHA-256 content digest are part
 * of the durable identity.
 */
export function applyMigrations(db: Database, dir: string): string[] {
  const migrations = listMigrations(dir);
  const prepareHistory = db.transaction(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const columns = db.prepare('PRAGMA table_info(schema_migrations)').all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'checksum')) {
      db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
    }

    const applied = db
      .prepare(
        'SELECT name, applied_at AS appliedAt, checksum FROM schema_migrations ORDER BY rowid',
      )
      .all() as { name: string; appliedAt: number; checksum: string | null }[];
    if (
      !isOrderedMigrationPrefix(
        applied.map((row) => row.name),
        migrations.map((migration) => migration.name),
      )
    ) {
      throw new Error('migration_history_invalid');
    }

    // Verify every pinned identity before adopting any legacy row. The
    // transaction also rolls back the checksum column itself on failure.
    for (const [index, row] of applied.entries()) {
      const expected = migrations[index]!;
      if (row.checksum !== null && row.checksum !== expected.checksum) {
        throw new Error('migration_checksum_mismatch');
      }
    }
    const adopt = db.prepare('UPDATE schema_migrations SET checksum = ? WHERE name = ?');
    for (const [index, row] of applied.entries()) {
      if (row.checksum === null) {
        adopt.run(migrations[index]!.checksum, row.name);
      }
    }
    return applied.length;
  });
  const appliedCount = prepareHistory();

  const ran: string[] = [];
  for (const migration of migrations.slice(appliedCount)) {
    const sql = readFileSync(join(dir, migration.name), 'utf8');
    const runOne = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)').run(
        migration.name,
        Date.now(),
        migration.checksum,
      );
    });
    runOne();
    ran.push(migration.name);
  }
  return ran;
}

export function readAppliedMigrations(db: Database): AppliedMigration[] {
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all() as {
    name: string;
  }[];
  const hasChecksum = columns.some((column) => column.name === 'checksum');
  const rows = db
    .prepare(
      hasChecksum
        ? 'SELECT name, applied_at AS appliedAt, checksum FROM schema_migrations ORDER BY rowid'
        : 'SELECT name, applied_at AS appliedAt, NULL AS checksum FROM schema_migrations ORDER BY rowid',
    )
    .all() as { name: unknown; appliedAt: unknown; checksum: unknown }[];
  return rows.map((row) => {
    if (
      typeof row.name !== 'string' ||
      typeof row.appliedAt !== 'number' ||
      !Number.isSafeInteger(row.appliedAt) ||
      row.appliedAt < 0 ||
      typeof row.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.checksum)
    ) {
      throw new Error('migration_history_invalid');
    }
    return {
      name: row.name,
      appliedAt: row.appliedAt,
      checksum: row.checksum,
    };
  });
}
