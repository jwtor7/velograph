import type { Database } from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
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
 * never change; the stored name is the identity.
 */
export function applyMigrations(db: Database, dir: string): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const files = listMigrationFiles(dir);
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const runOne = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        Date.now(),
      );
    });
    runOne();
    ran.push(file);
  }
  return ran;
}
