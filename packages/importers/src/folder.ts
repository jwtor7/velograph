import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { guardAgainstCheckout } from '@velograph/db';
import { parseHaeFilename } from './adapters.ts';
import type { ImportFile } from './importer.ts';

/**
 * Path-based folder import (issue #51): the web client posts a folder path
 * instead of routing every file through the browser as base64. The API
 * reads the folder directly from disk — the same way the CLI already does
 * (`collectFiles` in apps/cli), except recursively and with explicit bounds.
 * A real export holds dozens of files across many rides (a single route GPX
 * alone runs a couple of megabytes), so this must not build one giant
 * in-memory upload.
 *
 * Bounds:
 *  - `maxFiles` / `maxTotalBytes` cap the walk. Hitting either stops the
 *    walk (`truncated: true`) and records the file that tipped it over in
 *    `skipped` — the point of the cap is to bound the traversal itself, so
 *    the walk does not keep enumerating everything past it.
 *  - A symlinked directory is never followed, inside the tree or not (cycle
 *    and escape risk). A symlinked file is only followed when its real
 *    target resolves inside the walked tree; otherwise it is skipped and
 *    reported.
 *  - The root — and its real path, in case the given path is itself a
 *    symlink — is checked with the same `guardAgainstCheckout` used for
 *    VELO_DATA_DIR and database backups. Never a folder inside this
 *    checkout.
 *
 * Only filenames, sizes, and classifications are ever produced here — never
 * file contents, coordinates, or source/device strings (PRD §12.2).
 */

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

const IMPORTABLE_EXTENSION = /\.(csv|gpx|zip)$/i;

export interface FolderWalkOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
}

export interface WalkedFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

export type FolderSkipReason =
  | 'symlink_directory_skipped'
  | 'symlink_outside_tree'
  | 'not_a_regular_file'
  | 'unreadable'
  | 'max_files_exceeded'
  | 'max_total_bytes_exceeded';

export interface FolderSkip {
  relativePath: string;
  reason: FolderSkipReason;
}

export interface FolderWalkResult {
  root: string;
  files: WalkedFile[];
  skipped: FolderSkip[];
  totalBytes: number;
  truncated: boolean;
}

export type FolderImportErrorCode = 'path_not_found' | 'not_a_directory' | 'inside_checkout';

export class FolderImportError extends Error {
  readonly code: FolderImportErrorCode;

  constructor(code: FolderImportErrorCode, message: string) {
    super(message);
    this.name = 'FolderImportError';
    this.code = code;
  }
}

const toPosix = (p: string): string => p.split(sep).join('/');

function checkNotInsideCheckout(dir: string): void {
  try {
    guardAgainstCheckout(dir);
  } catch (err) {
    throw new FolderImportError(
      'inside_checkout',
      err instanceof Error ? err.message : 'path resolves inside a git checkout',
    );
  }
}

/**
 * Recursively walk `rootPath`, returning importable files (.csv/.gpx/.zip)
 * bounded by `maxFiles` / `maxTotalBytes`. Never reads file contents — only
 * `readdirSync`/`lstatSync`/`realpathSync` metadata calls.
 */
export function walkImportFolder(rootPath: string, opts: FolderWalkOptions = {}): FolderWalkResult {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const root = resolve(rootPath);
  checkNotInsideCheckout(root);

  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    throw new FolderImportError('path_not_found', 'path does not exist');
  }
  if (!rootStat.isDirectory()) {
    throw new FolderImportError('not_a_directory', 'path is not a directory');
  }

  // Re-check the real path too: the given path itself could be a symlink
  // whose target resolves inside the checkout.
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new FolderImportError('path_not_found', 'path does not exist');
  }
  checkNotInsideCheckout(rootReal);

  const files: WalkedFile[] = [];
  const skipped: FolderSkip[] = [];
  let totalBytes = 0;
  let truncated = false;

  const relOf = (p: string) => toPosix(relative(root, p)) || '.';
  const withinRoot = (real: string) => real === rootReal || real.startsWith(rootReal + sep);

  function addFile(full: string, size: number): void {
    if (files.length >= maxFiles) {
      skipped.push({ relativePath: relOf(full), reason: 'max_files_exceeded' });
      truncated = true;
      return;
    }
    if (totalBytes + size > maxTotalBytes) {
      skipped.push({ relativePath: relOf(full), reason: 'max_total_bytes_exceeded' });
      truncated = true;
      return;
    }
    totalBytes += size;
    files.push({ relativePath: relOf(full), absolutePath: full, sizeBytes: size });
  }

  function walk(dir: string): void {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({ relativePath: relOf(dir), reason: 'unreadable' });
      return;
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      if (truncated) return;
      const full = join(dir, entry.name);
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        skipped.push({ relativePath: relOf(full), reason: 'unreadable' });
        continue;
      }

      if (lst.isSymbolicLink()) {
        let real: string;
        let target;
        try {
          real = realpathSync(full);
          target = statSync(full); // follows the link
        } catch {
          skipped.push({ relativePath: relOf(full), reason: 'unreadable' });
          continue;
        }
        if (!withinRoot(real)) {
          skipped.push({ relativePath: relOf(full), reason: 'symlink_outside_tree' });
          continue;
        }
        if (target.isDirectory()) {
          // Never follow a symlinked directory, even inside the tree —
          // avoids cycles and keeps the bounds above meaningful.
          skipped.push({ relativePath: relOf(full), reason: 'symlink_directory_skipped' });
          continue;
        }
        if (!target.isFile()) {
          skipped.push({ relativePath: relOf(full), reason: 'not_a_regular_file' });
          continue;
        }
        if (IMPORTABLE_EXTENSION.test(entry.name)) addFile(full, target.size);
        continue;
      }

      if (lst.isDirectory()) {
        walk(full);
        continue;
      }
      if (!lst.isFile()) {
        skipped.push({ relativePath: relOf(full), reason: 'not_a_regular_file' });
        continue;
      }
      if (IMPORTABLE_EXTENSION.test(entry.name)) addFile(full, lst.size);
    }
  }

  walk(root);
  return { root, files, skipped, totalBytes, truncated };
}

export interface FolderRideGroup {
  /** Stable grouping key: workout type + filename timestamp. */
  rideKey: string;
  workoutType: string;
  stampHint: string;
  files: {
    relativePath: string;
    name: string;
    sizeBytes: number;
    label: string;
    format: 'csv' | 'gpx';
  }[];
}

export interface FolderUngroupedItem {
  relativePath: string;
  name: string;
  sizeBytes: number;
  classification: 'zip_archive' | 'unrecognized_filename';
}

export interface FolderPreview {
  root: string;
  rides: FolderRideGroup[];
  ungrouped: FolderUngroupedItem[];
  skipped: FolderSkip[];
  totalFiles: number;
  totalBytes: number;
  truncated: boolean;
}

/**
 * Group a walked folder the way a Health Auto Export folder is actually
 * shaped: one CSV per metric per ride, named
 * `<Outdoor|Indoor> Cycling-<Metric>-<timestamp>.csv`, plus a route GPX and
 * a route CSV sharing the same trailing timestamp. Grouping by workout type
 * + timestamp makes it obvious which companion files belong to one ride
 * before anything is imported.
 */
export function previewImportFolder(rootPath: string, opts: FolderWalkOptions = {}): FolderPreview {
  const walk = walkImportFolder(rootPath, opts);
  const groups = new Map<string, FolderRideGroup>();
  const ungrouped: FolderUngroupedItem[] = [];

  for (const f of walk.files) {
    const name = f.relativePath.split('/').pop() ?? f.relativePath;
    if (/\.zip$/i.test(name)) {
      ungrouped.push({
        relativePath: f.relativePath,
        name,
        sizeBytes: f.sizeBytes,
        classification: 'zip_archive',
      });
      continue;
    }
    const info = parseHaeFilename(name);
    if (!info) {
      ungrouped.push({
        relativePath: f.relativePath,
        name,
        sizeBytes: f.sizeBytes,
        classification: 'unrecognized_filename',
      });
      continue;
    }
    const format: 'csv' | 'gpx' = name.toLowerCase().endsWith('.gpx') ? 'gpx' : 'csv';
    const stampHint = info.stampHint ?? '';
    const rideKey = `${info.workoutType}:${stampHint}`;
    let group = groups.get(rideKey);
    if (!group) {
      group = { rideKey, workoutType: info.workoutType, stampHint, files: [] };
      groups.set(rideKey, group);
    }
    group.files.push({
      relativePath: f.relativePath,
      name,
      sizeBytes: f.sizeBytes,
      label: info.label,
      format,
    });
  }

  const rides = [...groups.values()].sort((a, b) =>
    a.stampHint < b.stampHint ? -1 : a.stampHint > b.stampHint ? 1 : 0,
  );
  for (const g of rides) g.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  ungrouped.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));

  return {
    root: walk.root,
    rides,
    ungrouped,
    skipped: walk.skipped,
    totalFiles: walk.files.length,
    totalBytes: walk.totalBytes,
    truncated: walk.truncated,
  };
}

export interface FolderReadResult {
  files: ImportFile[];
  skipped: FolderSkip[];
  truncated: boolean;
  totalBytes: number;
}

/** Walk `rootPath` and read every importable file's bytes for `runImport`. */
export function readFolderFiles(rootPath: string, opts: FolderWalkOptions = {}): FolderReadResult {
  const walk = walkImportFolder(rootPath, opts);
  const files: ImportFile[] = walk.files.map((f) => ({
    name: f.relativePath.split('/').pop() ?? f.relativePath,
    data: readFileSync(f.absolutePath),
  }));
  return { files, skipped: walk.skipped, truncated: walk.truncated, totalBytes: walk.totalBytes };
}
