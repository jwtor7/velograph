import { existsSync, writeFileSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { backupDatabase } from './backup.ts';
import { openDatabase } from './database.ts';

function writeState(db: Database, value: string): void {
  db.prepare(
    `INSERT INTO user_settings (key, value_json) VALUES ('backup-lock-state', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
  ).run(JSON.stringify(value));
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });
  }
  throw new Error('barrier_timeout');
}

async function run(): Promise<void> {
  const [mode, dbPath, backupPath, readyPath, releasePath, startedPath, contentionPath] =
    process.argv.slice(2);
  if (
    (mode !== 'hold-and-fail' && mode !== 'succeed') ||
    !dbPath ||
    !backupPath ||
    !readyPath ||
    !releasePath ||
    !startedPath ||
    (mode === 'succeed' && !contentionPath)
  ) {
    throw new Error('invalid_test_arguments');
  }

  const db = openDatabase(dbPath);
  try {
    writeState(db, mode === 'hold-and-fail' ? 'first-attempt' : 'second-success');
    if (mode === 'hold-and-fail') {
      try {
        await backupDatabase(db, backupPath, {
          afterInstall: async () => {
            writeFileSync(readyPath, 'ready');
            await waitForFile(releasePath);
            throw new Error('expected_first_failure');
          },
        });
        throw new Error('expected_backup_to_fail');
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'expected_first_failure') {
          throw error;
        }
      }
      return;
    }

    writeFileSync(readyPath, 'attempting');
    await backupDatabase(db, backupPath, {
      onLockContention: () => {
        writeFileSync(contentionPath!, 'contended');
      },
      stageBackup: (source, destination) => {
        writeFileSync(startedPath, 'started');
        return source.backup(destination);
      },
    });
  } finally {
    db.close();
  }
}

void run().catch(() => {
  process.exitCode = 1;
});
