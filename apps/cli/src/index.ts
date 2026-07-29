#!/usr/bin/env node
/**
 * Velograph CLI (IMP-002; issue #38 delete/backup/restore/repair parity):
 *   node apps/cli/src/index.ts import <path...> [--data-dir <dir>]
 *   node apps/cli/src/index.ts delete <workoutId> [--data-dir <dir>]
 *   node apps/cli/src/index.ts backup <destPath> [--data-dir <dir>]
 *   node apps/cli/src/index.ts restore <backupPath> [--data-dir <dir>]
 *   node apps/cli/src/index.ts repair <workoutId> [--data-dir <dir>]
 *
 * Accepts CSV/GPX files, directories (scanned one level, non-recursive), and
 * ZIP archives. Prints counts and error codes only — never sample values or
 * filesystem paths beyond what the user themselves passed on the command line.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BackupValidationError,
  backupDatabase,
  databasePath,
  openDatabase,
  Repository,
  resolveDataDir,
  RestoreDatabaseError,
  RestoreValidationError,
  restoreDatabase,
  type Database,
} from '@velograph/db';
import { repairWorkout } from '@velograph/api';
import { runImport, type ImportFile } from '@velograph/importers';
import { systemTimeZone } from '@velograph/shared';

const USAGE = [
  'Usage:',
  '  velograph-import import <file|dir|zip>... [--data-dir <dir>]',
  '  velograph-import delete <workoutId> [--data-dir <dir>]',
  '  velograph-import backup <destPath> [--data-dir <dir>]',
  '  velograph-import restore <backupPath> [--data-dir <dir>]',
  '  velograph-import repair <workoutId> [--data-dir <dir>]',
].join('\n');

function collectFiles(paths: string[]): ImportFile[] {
  const files: ImportFile[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p).sort()) {
        const full = join(p, entry);
        if (!statSync(full).isFile()) continue;
        if (/\.(csv|gpx|zip)$/i.test(entry)) {
          files.push({ name: entry, data: readFileSync(full) });
        }
      }
    } else {
      files.push({ name: p.split('/').pop() ?? p, data: readFileSync(p) });
    }
  }
  return files;
}

/** Pull `--data-dir <dir>` out of args, if present, returning the rest. */
function extractDataDirOverride(args: string[]): { rest: string[]; dataDir: string | undefined } {
  const rest = [...args];
  const idx = rest.indexOf('--data-dir');
  if (idx === -1) return { rest, dataDir: undefined };
  const dataDir = rest[idx + 1];
  rest.splice(idx, 2);
  return { rest, dataDir };
}

function runImportCmd(args: string[]): number {
  if (args.length === 0) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const db = openDatabase(databasePath(dataDir));
  try {
    const files = collectFiles(args);
    if (files.length === 0) {
      console.error('No importable files found (.csv, .gpx, .zip)');
      return 2;
    }
    const result = runImport(db, files, { timeZone: systemTimeZone() });
    console.log(
      [
        `Batch ${result.batchId} committed`,
        `  imported files:     ${result.imported}`,
        `  duplicates skipped: ${result.skippedDuplicates}`,
        `  quarantined:        ${result.quarantined}`,
        `  workouts created:   ${result.workoutsCreated}`,
      ].join('\n'),
    );
    for (const q of result.quarantinedFiles) {
      console.log(`  quarantined: ${q.name} [${q.code}]`);
    }
    return 0;
  } finally {
    db.close();
  }
}

function runDeleteCmd(args: string[]): number {
  const id = Number(args[0]);
  if (!args[0] || !Number.isInteger(id)) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const db = openDatabase(databasePath(dataDir));
  try {
    const result = new Repository(db).deleteWorkout(id);
    if (!result) {
      console.error(`Workout ${id} not found`);
      return 1;
    }
    console.log(
      `Deleted workout ${id} (removed ${result.removedSourceFileIds.length} exclusive source file record(s))`,
    );
    return 0;
  } finally {
    db.close();
  }
}

function runRepairCmd(args: string[]): number {
  const id = Number(args[0]);
  if (!args[0] || !Number.isInteger(id)) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const db = openDatabase(databasePath(dataDir));
  try {
    const analytics = repairWorkout(db, id, Date.now());
    if (!analytics) {
      console.error(`Workout ${id} not found`);
      return 1;
    }
    console.log(`Repaired workout ${id} (formula ${analytics.formulaVersion})`);
    return 0;
  } finally {
    db.close();
  }
}

function closeDatabaseWithoutThrow(db: Database | undefined): boolean {
  if (!db?.open) return true;
  try {
    db.close();
    return true;
  } catch {
    return false;
  }
}

async function runBackupCmd(args: string[]): Promise<number> {
  const dest = args[0];
  if (!dest) {
    console.log(USAGE);
    return 2;
  }
  let db: Database | undefined;
  try {
    const dataDir = resolveDataDir();
    db = openDatabase(databasePath(dataDir));
    const result = await backupDatabase(db, dest);
    if (!closeDatabaseWithoutThrow(db)) {
      console.error('Backup failed: backup_failed');
      return 1;
    }
    console.log(`Backup written (${result.totalPages} page(s))`);
    return 0;
  } catch (err) {
    closeDatabaseWithoutThrow(db);
    const code = err instanceof BackupValidationError ? err.code : 'backup_failed';
    console.error(`Backup failed: ${code}`);
    return 1;
  }
}

async function runRestoreCmd(args: string[]): Promise<number> {
  const source = args[0];
  if (!source) {
    console.log(USAGE);
    return 2;
  }
  let db: Database | undefined;
  try {
    const dataDir = resolveDataDir();
    const dbPath = databasePath(dataDir);
    db = openDatabase(dbPath);
    const restored = await restoreDatabase(db, dbPath, source);
    if (!closeDatabaseWithoutThrow(restored)) {
      console.error('Restore failed: restore_failed');
      return 1;
    }
    console.log('Database restored from backup');
    return 0;
  } catch (err) {
    if (err instanceof RestoreDatabaseError && err.recoveredDatabase?.open) {
      closeDatabaseWithoutThrow(err.recoveredDatabase);
    } else {
      closeDatabaseWithoutThrow(db);
    }
    const code =
      err instanceof RestoreDatabaseError
        ? err.code
        : err instanceof RestoreValidationError
          ? err.code
          : 'restore_failed';
    console.error(`Restore failed: ${code}`);
    return 1;
  }
}

function commandFailureMessage(command: string | undefined): string {
  switch (command) {
    case 'import':
      return 'Import failed: import_failed';
    case 'delete':
      return 'Delete failed: delete_failed';
    case 'repair':
      return 'Repair failed: repair_failed';
    case 'backup':
      return 'Backup failed: backup_failed';
    case 'restore':
      return 'Restore failed: restore_failed';
    default:
      return 'Command failed: command_failed';
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
  try {
    const { rest, dataDir } = extractDataDirOverride(args);
    if (dataDir) process.env['VELO_DATA_DIR'] = dataDir;

    switch (cmd) {
      case 'import':
        return runImportCmd(rest);
      case 'delete':
        return runDeleteCmd(rest);
      case 'repair':
        return runRepairCmd(rest);
      case 'backup':
        return runBackupCmd(rest);
      case 'restore':
        return runRestoreCmd(rest);
      default:
        console.log(USAGE);
        return 2;
    }
  } catch {
    console.error(commandFailureMessage(cmd));
    return 1;
  }
}

// Only run as a side effect when invoked directly (`node index.ts ...`), not
// when imported — e.g. by tests exercising `main()` in-process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('Command failed: command_failed');
      process.exitCode = 1;
    },
  );
}
