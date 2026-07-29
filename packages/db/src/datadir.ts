import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Resolve VELO_DATA_DIR (PRD §11.3): env override, else an OS-appropriate
 * application-data directory. All persistent state lives here — never inside
 * the source checkout.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['VELO_DATA_DIR'];
  let dir: string;
  if (fromEnv && fromEnv.trim() !== '') {
    dir = isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
  } else if (process.platform === 'darwin') {
    dir = join(homedir(), 'Library', 'Application Support', 'velograph');
  } else if (process.platform === 'win32') {
    dir = join(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'velograph');
  } else {
    dir = join(env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'velograph');
  }
  guardAgainstCheckout(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Refuse a data directory inside a git checkout — the repo is public. */
export function guardAgainstCheckout(dir: string): void {
  let cursor = resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(cursor, '.git'))) {
      throw new Error(
        `VELO_DATA_DIR (${dir}) is inside a git checkout; choose a location outside any repository`,
      );
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
}

export function databasePath(dataDir: string): string {
  return join(dataDir, 'velograph.sqlite3');
}
