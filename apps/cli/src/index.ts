#!/usr/bin/env node
/**
 * Velograph import CLI (IMP-002):
 *   node apps/cli/src/index.ts import <path...> [--data-dir <dir>]
 *
 * Accepts CSV/GPX files, directories (scanned one level, non-recursive), and
 * ZIP archives. Prints counts and error codes only — never sample values.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { databasePath, openDatabase, resolveDataDir } from '@velograph/db';
import { runImport, type ImportFile } from '@velograph/importers';

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

export function main(argv: string[]): number {
  const args = [...argv];
  const cmd = args.shift();
  if (cmd !== 'import' || args.length === 0) {
    console.log('Usage: velograph-import import <file|dir|zip>... [--data-dir <dir>]');
    return 2;
  }
  const ddIdx = args.indexOf('--data-dir');
  let dataDirOverride: string | undefined;
  if (ddIdx !== -1) {
    dataDirOverride = args[ddIdx + 1];
    args.splice(ddIdx, 2);
  }
  const env = { ...process.env };
  if (dataDirOverride) env['VELO_DATA_DIR'] = dataDirOverride;

  const dataDir = resolveDataDir(env);
  const db = openDatabase(databasePath(dataDir));
  try {
    const files = collectFiles(args);
    if (files.length === 0) {
      console.error('No importable files found (.csv, .gpx, .zip)');
      return 2;
    }
    const result = runImport(db, files);
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

process.exit(main(process.argv.slice(2)));
