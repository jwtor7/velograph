#!/usr/bin/env node
/**
 * Velograph CLI (IMP-002; issue #38 delete/backup/restore/repair parity):
 *   node apps/cli/src/index.ts import <path...> [--data-dir <dir>]
 *   node apps/cli/src/index.ts delete <workoutId> [--data-dir <dir>]
 *   node apps/cli/src/index.ts backup <destPath> [--data-dir <dir>]
 *   node apps/cli/src/index.ts restore <backupPath> --confirm-replace [--data-dir <dir>]
 *   node apps/cli/src/index.ts repair <workoutId> [--data-dir <dir>]
 *
 * Accepts CSV/GPX files, recursively planned directories, and ZIP archives.
 * Prints counts and error codes only — never sample values or filesystem paths.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { basename } from 'node:path';
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
  restoreDatabaseWithReport,
  type Database,
} from '@velograph/db';
import { repairWorkout } from '@velograph/api';
import {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_GROUP_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  planFolderImport,
  readFolderFileGroups,
  runImportGroups,
  type ImportFileGroupLoader,
} from '@velograph/importers';
import { systemTimeZone } from '@velograph/shared';

const USAGE = [
  'Usage:',
  '  velograph-import import <file|dir|zip>... [--data-dir <dir>]',
  '  velograph-import delete <workoutId> [--data-dir <dir>]',
  '  velograph-import backup <destPath> [--data-dir <dir>]',
  '  velograph-import restore <backupPath> --confirm-replace [--data-dir <dir>]',
  '  velograph-import repair <workoutId> [--data-dir <dir>]',
].join('\n');

export function portableBasename(path: string): string {
  return basename(path.replaceAll('\\', '/'));
}

function sameFileIdentity(expected: Stats, actual: Stats): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs
  );
}

function directFileLoader(path: string, expected: Stats): ImportFileGroupLoader {
  const name = portableBasename(path);
  return () => {
    let fd: number | undefined;
    try {
      const pathStats = lstatSync(path);
      if (!pathStats.isFile() || !sameFileIdentity(expected, pathStats)) {
        throw new Error('import_file_changed');
      }
      fd = openSync(path, 'r');
      const before = fstatSync(fd);
      if (!before.isFile() || !sameFileIdentity(expected, before)) {
        throw new Error('import_file_changed');
      }
      const data = Buffer.alloc(expected.size);
      let offset = 0;
      while (offset < data.byteLength) {
        const bytesRead = readSync(fd, data, offset, data.byteLength - offset, null);
        if (bytesRead === 0) throw new Error('import_file_changed');
        offset += bytesRead;
      }
      const overflowProbe = Buffer.allocUnsafe(1);
      if (readSync(fd, overflowProbe, 0, 1, null) !== 0) {
        throw new Error('import_file_changed');
      }
      const after = fstatSync(fd);
      if (!sameFileIdentity(before, after) || data.byteLength !== expected.size) {
        throw new Error('import_file_changed');
      }
      return [{ name, data }];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
}

function collectImportGroups(paths: string[]): ImportFileGroupLoader[] {
  const groups: ImportFileGroupLoader[] = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (const path of paths) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error('import_symbolic_path');

    if (stats.isDirectory()) {
      const plan = planFolderImport(path);
      if (plan.truncated) throw new Error('import_folder_limits_exceeded');
      totalFiles += plan.totalFiles;
      totalBytes += plan.totalBytes;
      groups.push(...readFolderFileGroups(plan));
    } else if (stats.isFile() && /\.(csv|gpx|zip)$/i.test(path)) {
      if (stats.size > DEFAULT_MAX_GROUP_BYTES) throw new Error('import_file_too_large');
      totalFiles++;
      totalBytes += stats.size;
      groups.push(directFileLoader(path, stats));
    }

    if (totalFiles > DEFAULT_MAX_FILES || totalBytes > DEFAULT_MAX_TOTAL_BYTES) {
      throw new Error('import_folder_limits_exceeded');
    }
  }

  return groups;
}

type DataDirOverride =
  { valid: true; rest: string[]; dataDir: string | undefined } | { valid: false };

/**
 * Pull one optional `--data-dir <dir>` out of args. Missing, blank, flag-like,
 * or repeated values are rejected before resolveDataDir can choose a default.
 */
function extractDataDirOverride(args: string[]): DataDirOverride {
  const rest = [...args];
  const indexes = rest.flatMap((arg, index) => (arg === '--data-dir' ? [index] : []));
  if (indexes.length === 0) return { valid: true, rest, dataDir: undefined };
  if (indexes.length !== 1) return { valid: false };
  const idx = indexes[0]!;
  const dataDir = rest[idx + 1];
  if (dataDir === undefined || dataDir.trim() === '' || dataDir.startsWith('--')) {
    return { valid: false };
  }
  rest.splice(idx, 2);
  return { valid: true, rest, dataDir };
}

function runImportCmd(args: string[]): number {
  if (args.length === 0) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const db = openDatabase(databasePath(dataDir));
  try {
    const groups = collectImportGroups(args);
    if (groups.length === 0) {
      console.error('No importable files found (.csv, .gpx, .zip)');
      return 2;
    }
    const result = runImportGroups(db, groups, { timeZone: systemTimeZone() });
    console.log(
      [
        `Batch ${result.batchId} committed`,
        `  imported files:     ${result.imported}`,
        `  duplicates skipped: ${result.skippedDuplicates}`,
        `  out-of-scope skipped: ${result.skipped}`,
        `  quarantined:        ${result.quarantined}`,
        `  workouts created:   ${result.workoutsCreated}`,
      ].join('\n'),
    );
    const quarantinedByCode = new Map<string, number>();
    for (const quarantine of result.quarantinedFiles) {
      quarantinedByCode.set(quarantine.code, (quarantinedByCode.get(quarantine.code) ?? 0) + 1);
    }
    for (const [code, count] of [...quarantinedByCode].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      console.log(`  quarantined [${code}]: ${count}`);
    }
    for (const [code, count] of Object.entries(result.skippedByCode).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (count > 0) console.log(`  skipped [${code}]: ${count}`);
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
    console.log(
      `Backup written (${result.totalPages} page(s), format ${result.manifest.formatVersion}, schema ${result.manifest.schemaVersion})`,
    );
    return 0;
  } catch (err) {
    closeDatabaseWithoutThrow(db);
    const code = err instanceof BackupValidationError ? err.code : 'backup_failed';
    console.error(`Backup failed: ${code}`);
    return 1;
  }
}

async function runRestoreCmd(args: string[]): Promise<number> {
  const confirmed = args.includes('--confirm-replace');
  const positional = args.filter((arg) => arg !== '--confirm-replace');
  const source = positional[0];
  if (!source || positional.length !== 1) {
    console.log(USAGE);
    return 2;
  }
  if (!confirmed) {
    console.error('Restore requires --confirm-replace');
    return 2;
  }
  let db: Database | undefined;
  try {
    const dataDir = resolveDataDir();
    const dbPath = databasePath(dataDir);
    db = openDatabase(dbPath);
    const result = await restoreDatabaseWithReport(db, dbPath, source);
    if (!closeDatabaseWithoutThrow(result.database)) {
      console.error('Restore failed: restore_failed');
      return 1;
    }
    console.log(
      result.report.legacyBackup
        ? `Database restored from legacy backup and migrated to ${result.report.schemaVersion}`
        : `Database restored; manifest and checksums verified (${result.report.schemaVersion})`,
    );
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
    const parsed = extractDataDirOverride(args);
    if (!parsed.valid) {
      console.log(USAGE);
      return 2;
    }
    const { rest, dataDir } = parsed;
    if (dataDir !== undefined) process.env['VELO_DATA_DIR'] = dataDir;

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
