import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { guardAgainstCheckout } from '@velograph/db';
import { parseHaeFilename } from './adapters.ts';
import type { ImportFile, ImportFileGroupLoader } from './importer.ts';

/**
 * Path-based folder import (issue #51).
 *
 * Import is deliberately split in two phases:
 *  1. build a bounded metadata-only plan;
 *  2. revalidate that plan and read one bounded association group at a time.
 *
 * This keeps large exports off the JSON/base64 path without retaining an
 * entire folder's bytes. The plan captures canonical root/file identities;
 * every descriptor is checked again before and after its exact-size read so
 * a symlink or filesystem swap between traversal and confirmation fails
 * closed instead of reading a different path.
 */

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // metadata traversal cap: 2 GiB
export const DEFAULT_MAX_GROUP_BYTES = 64 * 1024 * 1024; // resident source bytes per ride group

const IMPORTABLE_EXTENSION = /\.(csv|gpx|zip)$/i;

export interface FolderWalkOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxGroupBytes?: number;
}

interface EntryIdentity {
  device: number;
  inode: number;
  sizeBytes: number;
  modifiedMs: number;
  changedMs: number;
}

export interface WalkedFile extends EntryIdentity {
  relativePath: string;
  absolutePath: string;
  canonicalPath: string;
  symbolicLink: boolean;
}

export type FolderSkipReason =
  | 'symlink_directory_skipped'
  | 'symlink_outside_tree'
  | 'not_a_regular_file'
  | 'unreadable'
  | 'max_files_exceeded'
  | 'max_total_bytes_exceeded'
  | 'max_group_bytes_exceeded';

export interface FolderSkip {
  relativePath: string;
  reason: FolderSkipReason;
}

export interface FolderWalkResult {
  root: string;
  canonicalRoot: string;
  rootDevice: number;
  rootInode: number;
  files: WalkedFile[];
  skipped: FolderSkip[];
  totalBytes: number;
  truncated: boolean;
}

export type FolderImportErrorCode =
  | 'path_not_found'
  | 'not_a_directory'
  | 'inside_checkout'
  | 'path_changed'
  | 'file_changed'
  | 'file_unreadable';

export class FolderImportError extends Error {
  readonly code: FolderImportErrorCode;

  constructor(code: FolderImportErrorCode, message: string) {
    super(message);
    this.name = 'FolderImportError';
    this.code = code;
  }
}

const toPosix = (path: string): string => path.split(sep).join('/');

function identityOf(stats: Stats): EntryIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    sizeBytes: stats.size,
    modifiedMs: stats.mtimeMs,
    changedMs: stats.ctimeMs,
  };
}

function sameIdentity(
  expected: EntryIdentity,
  actual: EntryIdentity,
  includeContentMetadata = true,
): boolean {
  return (
    expected.device === actual.device &&
    expected.inode === actual.inode &&
    (!includeContentMetadata ||
      (expected.sizeBytes === actual.sizeBytes &&
        expected.modifiedMs === actual.modifiedMs &&
        expected.changedMs === actual.changedMs))
  );
}

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

function insideCanonicalRoot(canonicalRoot: string, candidate: string): boolean {
  return candidate === canonicalRoot || candidate.startsWith(canonicalRoot + sep);
}

/**
 * Recursively walk `rootPath`, returning importable file metadata bounded by
 * file count and aggregate size. No source contents are read.
 */
export function walkImportFolder(rootPath: string, opts: FolderWalkOptions = {}): FolderWalkResult {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const root = resolve(rootPath);
  checkNotInsideCheckout(root);

  let rootStats: Stats;
  try {
    rootStats = statSync(root);
  } catch {
    throw new FolderImportError('path_not_found', 'path does not exist');
  }
  if (!rootStats.isDirectory()) {
    throw new FolderImportError('not_a_directory', 'path is not a directory');
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    throw new FolderImportError('path_not_found', 'path does not exist');
  }
  checkNotInsideCheckout(canonicalRoot);

  const rootIdentity = identityOf(rootStats);
  const files: WalkedFile[] = [];
  const skipped: FolderSkip[] = [];
  let totalBytes = 0;
  let truncated = false;

  const relativeToRoot = (path: string) => toPosix(relative(root, path)) || '.';

  function addFile(fullPath: string, symbolicLink: boolean): void {
    let canonicalPath: string;
    let targetStats: Stats;
    try {
      canonicalPath = realpathSync(fullPath);
      targetStats = statSync(fullPath);
    } catch {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'unreadable' });
      return;
    }
    if (!insideCanonicalRoot(canonicalRoot, canonicalPath)) {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'symlink_outside_tree' });
      return;
    }
    if (!targetStats.isFile()) {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'not_a_regular_file' });
      return;
    }
    if (files.length >= maxFiles) {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'max_files_exceeded' });
      truncated = true;
      return;
    }
    if (totalBytes + targetStats.size > maxTotalBytes) {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'max_total_bytes_exceeded' });
      truncated = true;
      return;
    }
    totalBytes += targetStats.size;
    files.push({
      relativePath: relativeToRoot(fullPath),
      absolutePath: fullPath,
      canonicalPath,
      symbolicLink,
      ...identityOf(targetStats),
    });
  }

  function walk(dir: string): void {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({ relativePath: relativeToRoot(dir), reason: 'unreadable' });
      return;
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      if (truncated) return;
      const fullPath = join(dir, entry.name);
      let entryStats: Stats;
      try {
        entryStats = lstatSync(fullPath);
      } catch {
        skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'unreadable' });
        continue;
      }

      if (entryStats.isSymbolicLink()) {
        let targetStats: Stats;
        try {
          targetStats = statSync(fullPath);
        } catch {
          skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'unreadable' });
          continue;
        }
        if (targetStats.isDirectory()) {
          skipped.push({
            relativePath: relativeToRoot(fullPath),
            reason: 'symlink_directory_skipped',
          });
          continue;
        }
        if (!IMPORTABLE_EXTENSION.test(entry.name)) continue;
        addFile(fullPath, true);
        continue;
      }

      if (entryStats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entryStats.isFile()) {
        skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'not_a_regular_file' });
        continue;
      }
      if (IMPORTABLE_EXTENSION.test(entry.name)) addFile(fullPath, false);
    }
  }

  walk(root);
  return {
    root,
    canonicalRoot,
    rootDevice: rootIdentity.device,
    rootInode: rootIdentity.inode,
    files,
    skipped,
    totalBytes,
    truncated,
  };
}

export interface PlannedFolderGroup {
  groupKey: string;
  kind: 'ride' | 'zip_archive' | 'unrecognized_filename';
  workoutType?: string;
  stampHint?: string;
  files: WalkedFile[];
  totalBytes: number;
}

export interface FolderImportPlan {
  root: string;
  canonicalRoot: string;
  rootDevice: number;
  rootInode: number;
  groups: PlannedFolderGroup[];
  skipped: FolderSkip[];
  totalFiles: number;
  totalBytes: number;
  truncated: boolean;
}

function fileName(file: WalkedFile): string {
  return file.relativePath.split('/').pop() ?? file.relativePath;
}

function groupFor(file: WalkedFile): Omit<PlannedFolderGroup, 'files' | 'totalBytes'> {
  const name = fileName(file);
  if (/\.zip$/i.test(name)) {
    return {
      groupKey: `zip:${file.relativePath}`,
      kind: 'zip_archive',
    };
  }
  const info = parseHaeFilename(name);
  if (!info) {
    return {
      groupKey: `unrecognized:${file.relativePath}`,
      kind: 'unrecognized_filename',
    };
  }
  const stampHint = info.stampHint ?? '';
  return {
    groupKey: `ride:${info.workoutType}:${stampHint}`,
    kind: 'ride',
    workoutType: info.workoutType,
    stampHint,
  };
}

function compareGroups(a: PlannedFolderGroup, b: PlannedFolderGroup): number {
  const rank = (group: PlannedFolderGroup) =>
    group.kind === 'ride' ? 0 : group.kind === 'zip_archive' ? 1 : 2;
  const rankDifference = rank(a) - rank(b);
  if (rankDifference !== 0) return rankDifference;
  if (a.kind === 'ride' && b.kind === 'ride') {
    const stampDifference = (a.stampHint ?? '').localeCompare(b.stampHint ?? '');
    if (stampDifference !== 0) return stampDifference;
    const typeDifference = (a.workoutType ?? '').localeCompare(b.workoutType ?? '');
    if (typeDifference !== 0) return typeDifference;
  }
  return a.groupKey.localeCompare(b.groupKey);
}

/**
 * Build the metadata-only plan shared by preview and confirmation. Groups
 * over the resident-byte cap are excluded in full so a partial ride is
 * never imported merely to satisfy the memory bound.
 */
export function planFolderImport(rootPath: string, opts: FolderWalkOptions = {}): FolderImportPlan {
  const walk = walkImportFolder(rootPath, opts);
  const maxGroupBytes = opts.maxGroupBytes ?? DEFAULT_MAX_GROUP_BYTES;
  const byKey = new Map<string, PlannedFolderGroup>();

  for (const file of walk.files) {
    const identity = groupFor(file);
    const group = byKey.get(identity.groupKey) ?? {
      ...identity,
      files: [],
      totalBytes: 0,
    };
    group.files.push(file);
    group.totalBytes += file.sizeBytes;
    byKey.set(group.groupKey, group);
  }

  const skipped = [...walk.skipped];
  const groups: PlannedFolderGroup[] = [];
  let truncated = walk.truncated;
  for (const group of byKey.values()) {
    group.files.sort((a, b) => {
      const nameDifference = fileName(a).localeCompare(fileName(b));
      return nameDifference || a.relativePath.localeCompare(b.relativePath);
    });
    if (group.totalBytes > maxGroupBytes) {
      truncated = true;
      for (const file of group.files) {
        skipped.push({
          relativePath: file.relativePath,
          reason: 'max_group_bytes_exceeded',
        });
      }
      continue;
    }
    groups.push(group);
  }
  groups.sort(compareGroups);

  return {
    root: walk.root,
    canonicalRoot: walk.canonicalRoot,
    rootDevice: walk.rootDevice,
    rootInode: walk.rootInode,
    groups,
    skipped,
    totalFiles: groups.reduce((sum, group) => sum + group.files.length, 0),
    totalBytes: groups.reduce((sum, group) => sum + group.totalBytes, 0),
    truncated,
  };
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
 * Render the metadata plan as the existing value-free preview contract.
 * Canonical paths and filesystem identities never enter the API response.
 */
export function previewImportFolder(rootPath: string, opts: FolderWalkOptions = {}): FolderPreview {
  const plan = planFolderImport(rootPath, opts);
  const rides: FolderRideGroup[] = [];
  const ungrouped: FolderUngroupedItem[] = [];

  for (const group of plan.groups) {
    if (group.kind === 'ride') {
      rides.push({
        rideKey: `${group.workoutType ?? ''}:${group.stampHint ?? ''}`,
        workoutType: group.workoutType ?? '',
        stampHint: group.stampHint ?? '',
        files: group.files.map((file) => {
          const name = fileName(file);
          const info = parseHaeFilename(name)!;
          return {
            relativePath: file.relativePath,
            name,
            sizeBytes: file.sizeBytes,
            label: info.label,
            format: name.toLowerCase().endsWith('.gpx') ? 'gpx' : 'csv',
          };
        }),
      });
      continue;
    }
    for (const file of group.files) {
      ungrouped.push({
        relativePath: file.relativePath,
        name: fileName(file),
        sizeBytes: file.sizeBytes,
        classification: group.kind,
      });
    }
  }

  return {
    root: plan.root,
    rides,
    ungrouped,
    skipped: plan.skipped,
    totalFiles: plan.totalFiles,
    totalBytes: plan.totalBytes,
    truncated: plan.truncated,
  };
}

function revalidateRoot(plan: FolderImportPlan): void {
  try {
    const canonicalRoot = realpathSync(plan.root);
    const stats = statSync(plan.root);
    if (
      canonicalRoot !== plan.canonicalRoot ||
      !stats.isDirectory() ||
      stats.dev !== plan.rootDevice ||
      stats.ino !== plan.rootInode
    ) {
      throw new FolderImportError('path_changed', 'folder changed after traversal');
    }
    checkNotInsideCheckout(canonicalRoot);
  } catch (err) {
    if (err instanceof FolderImportError) throw err;
    throw new FolderImportError('path_changed', 'folder changed after traversal');
  }
}

function readExact(fd: number, sizeBytes: number): Buffer {
  const data = Buffer.allocUnsafe(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const count = readSync(fd, data, offset, sizeBytes - offset, offset);
    if (count === 0) {
      throw new FolderImportError('file_changed', 'file changed during import');
    }
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  if (readSync(fd, extra, 0, 1, sizeBytes) !== 0) {
    throw new FolderImportError('file_changed', 'file changed during import');
  }
  return data;
}

function readPlannedFile(plan: FolderImportPlan, file: WalkedFile): ImportFile {
  revalidateRoot(plan);
  let fd: number | undefined;
  try {
    const linkStats = lstatSync(file.absolutePath);
    if (
      (file.symbolicLink && !linkStats.isSymbolicLink()) ||
      (!file.symbolicLink && !linkStats.isFile())
    ) {
      throw new FolderImportError('file_changed', 'file changed after traversal');
    }

    const canonicalPath = realpathSync(file.absolutePath);
    if (
      canonicalPath !== file.canonicalPath ||
      !insideCanonicalRoot(plan.canonicalRoot, canonicalPath)
    ) {
      throw new FolderImportError('file_changed', 'file changed after traversal');
    }

    fd = openSync(file.absolutePath, 'r');
    const before = fstatSync(fd);
    const beforeIdentity = identityOf(before);
    if (!before.isFile() || !sameIdentity(file, beforeIdentity)) {
      throw new FolderImportError('file_changed', 'file changed after traversal');
    }

    const data = readExact(fd, file.sizeBytes);
    const after = fstatSync(fd);
    if (!after.isFile() || !sameIdentity(beforeIdentity, identityOf(after))) {
      throw new FolderImportError('file_changed', 'file changed during import');
    }
    revalidateRoot(plan);
    return { name: fileName(file), data };
  } catch (err) {
    if (err instanceof FolderImportError) throw err;
    throw new FolderImportError('file_unreadable', 'file could not be read safely');
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Descriptor cleanup failure does not expose a path or alter the
        // already-failed/complete import decision.
      }
    }
  }
}

/**
 * Lazily expose one loader per association group. Iterating the plan never
 * reads contents; invoking a loader allocates only that loader's bounded
 * group, and `runImportGroups` releases it before invoking the next loader.
 */
export function* readFolderFileGroups(plan: FolderImportPlan): Generator<ImportFileGroupLoader> {
  for (const group of plan.groups) {
    yield () => {
      revalidateRoot(plan);
      const files: ImportFile[] = [];
      for (const file of group.files) {
        files.push(readPlannedFile(plan, file));
      }
      return files;
    };
  }
}
