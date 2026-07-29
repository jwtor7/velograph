import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const INVALID_DATA_PATH = 'invalid_data_path';
const DATA_PATH_INSIDE_CHECKOUT = 'data_path_inside_checkout';

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function validateMissingComponent(component: string): void {
  if (component === '' || component === '.' || component === '..' || component.includes('\0')) {
    throw new Error(INVALID_DATA_PATH);
  }
}

/**
 * Resolve symlinks in the nearest existing ancestor, then append each
 * validated component that does not exist yet. This makes containment checks
 * meaningful even when a user supplies an outside-looking symlink alias or a
 * destination whose final directories still need to be created.
 */
export function canonicalizeDataPath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];

  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (missing.length > 0 && !stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error(INVALID_DATA_PATH);
      }

      let canonicalAncestor: string;
      try {
        canonicalAncestor = realpathSync(cursor);
      } catch {
        throw new Error(INVALID_DATA_PATH);
      }

      return missing.reduce(
        (candidate, component) => join(candidate, component),
        canonicalAncestor,
      );
    } catch (error) {
      if (!isMissingPathError(error)) {
        if (error instanceof Error && error.message === INVALID_DATA_PATH) throw error;
        throw new Error(INVALID_DATA_PATH);
      }

      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(INVALID_DATA_PATH);
      const component = basename(cursor);
      validateMissingComponent(component);
      missing.unshift(component);
      cursor = parent;
    }
  }
}

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
  const canonicalDir = guardAgainstCheckout(dir);
  try {
    mkdirSync(canonicalDir, { recursive: true });
  } catch {
    throw new Error(INVALID_DATA_PATH);
  }

  // Re-resolve after creation so a symlink introduced between validation and
  // mkdir cannot turn an outside-looking path into a checkout destination.
  return guardAgainstCheckout(canonicalDir);
}

/**
 * Refuse a path inside a git checkout — the repo is public. Returns the
 * canonical candidate so callers write to the exact path that was checked.
 * Error text is deliberately path-free because local paths can contain PII.
 */
export function guardAgainstCheckout(path: string): string {
  const canonicalPath = canonicalizeDataPath(path);
  let cursor = canonicalPath;
  while (true) {
    if (existsSync(join(cursor, '.git'))) {
      throw new Error(DATA_PATH_INSIDE_CHECKOUT);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return canonicalPath;
}

export function databasePath(dataDir: string): string {
  return join(dataDir, 'velograph.sqlite3');
}
