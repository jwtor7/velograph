import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { guardAgainstCheckout } from '@velograph/db';
import { sha256Hex, stableStringify } from '@velograph/shared';
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
export const DEFAULT_MAX_VISITED_ENTRIES = 20_000;
export const DEFAULT_MAX_DIRECTORIES = 2_000;
export const DEFAULT_MAX_DEPTH = 32;

const IMPORTABLE_EXTENSION = /\.(csv|gpx|zip)$/i;
const PLANNED_ENTRY_CHANGE_CODES = new Set(['EISDIR', 'ELOOP', 'ENOENT', 'ENOTDIR', 'ESTALE']);

export interface FolderWalkOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxGroupBytes?: number;
  maxVisitedEntries?: number;
  maxDirectories?: number;
  maxDepth?: number;
}

interface EntryIdentity {
  device: number;
  inode: number;
  sizeBytes: number;
  modifiedMs: number;
  changedMs: number;
}

interface TraversalManifestEntry extends EntryIdentity {
  relativePath: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  canonicalTarget?: string;
  targetIdentity?: EntryIdentity;
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
  | 'unsupported_file_type'
  | 'not_a_regular_file'
  | 'unreadable'
  | 'max_files_exceeded'
  | 'max_total_bytes_exceeded'
  | 'max_group_bytes_exceeded'
  | 'max_entries_exceeded'
  | 'max_directories_exceeded'
  | 'max_depth_exceeded';

export interface FolderSkip {
  relativePath: string;
  reason: FolderSkipReason;
}

export interface FolderWalkResult {
  root: string;
  canonicalRoot: string;
  rootDevice: number;
  rootInode: number;
  manifestEntries: TraversalManifestEntry[];
  files: WalkedFile[];
  skipped: FolderSkip[];
  visitedEntries: number;
  visitedDirectories: number;
  totalBytes: number;
  truncated: boolean;
}

export type FolderImportErrorCode =
  | 'path_not_found'
  | 'not_a_directory'
  | 'inside_checkout'
  | 'path_changed'
  | 'file_changed'
  | 'file_unreadable'
  | 'folder_limits_exceeded';

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

function isPlannedEntryChange(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    PLANNED_ENTRY_CHANGE_CODES.has(error.code)
  );
}

/**
 * Recursively walk `rootPath`, returning importable file metadata. Directory
 * handles are consumed incrementally: no directory's entries are materialized
 * in memory. Every entry encountered, including unsupported entries, counts
 * toward explicit traversal bounds and contributes metadata to the private
 * confirmation manifest. No source contents are read.
 */
export function walkImportFolder(rootPath: string, opts: FolderWalkOptions = {}): FolderWalkResult {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxVisitedEntries = opts.maxVisitedEntries ?? DEFAULT_MAX_VISITED_ENTRIES;
  const maxDirectories = opts.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
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
  const manifestEntries: TraversalManifestEntry[] = [];
  const files: WalkedFile[] = [];
  const skipped: FolderSkip[] = [];
  let visitedEntries = 0;
  let visitedDirectories = 0;
  let totalBytes = 0;
  let truncated = false;
  let traversalStopped = false;

  const relativeToRoot = (path: string) => toPosix(relative(root, path)) || '.';

  function addManifestEntry(
    fullPath: string,
    kind: TraversalManifestEntry['kind'],
    stats: Stats,
    target?: { canonicalPath: string; stats: Stats },
  ): void {
    manifestEntries.push({
      relativePath: relativeToRoot(fullPath),
      kind,
      ...identityOf(stats),
      ...(target
        ? {
            canonicalTarget: target.canonicalPath,
            targetIdentity: identityOf(target.stats),
          }
        : {}),
    });
  }

  function addFile(
    fullPath: string,
    symbolicLink: boolean,
    target?: { canonicalPath: string; stats: Stats },
  ): void {
    let canonicalPath: string;
    let targetStats: Stats;
    try {
      canonicalPath = target?.canonicalPath ?? realpathSync(fullPath);
      targetStats = target?.stats ?? statSync(fullPath);
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

  function stopForEntryLimit(fullPath: string): void {
    skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'max_entries_exceeded' });
    truncated = true;
    traversalStopped = true;
  }

  function walk(dirPath: string, depth: number): void {
    if (traversalStopped) return;
    if (depth > maxDepth) {
      skipped.push({ relativePath: relativeToRoot(dirPath), reason: 'max_depth_exceeded' });
      truncated = true;
      return;
    }
    if (visitedDirectories >= maxDirectories) {
      skipped.push({
        relativePath: relativeToRoot(dirPath),
        reason: 'max_directories_exceeded',
      });
      truncated = true;
      return;
    }

    let dir;
    try {
      dir = opendirSync(dirPath);
      visitedDirectories++;
    } catch {
      skipped.push({ relativePath: relativeToRoot(dirPath), reason: 'unreadable' });
      return;
    }

    try {
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        const fullPath = join(dirPath, entry.name);
        if (visitedEntries >= maxVisitedEntries) {
          stopForEntryLimit(fullPath);
          return;
        }
        visitedEntries++;

        let entryStats: Stats;
        try {
          entryStats = lstatSync(fullPath);
        } catch {
          skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'unreadable' });
          continue;
        }

        if (entryStats.isSymbolicLink()) {
          let targetStats: Stats;
          let canonicalTarget: string;
          try {
            canonicalTarget = realpathSync(fullPath);
            targetStats = statSync(fullPath);
            addManifestEntry(fullPath, 'symlink', entryStats, {
              canonicalPath: canonicalTarget,
              stats: targetStats,
            });
          } catch {
            addManifestEntry(fullPath, 'symlink', entryStats);
            skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'unreadable' });
            continue;
          }
          if (!insideCanonicalRoot(canonicalRoot, canonicalTarget)) {
            skipped.push({
              relativePath: relativeToRoot(fullPath),
              reason: 'symlink_outside_tree',
            });
            continue;
          }
          if (targetStats.isDirectory()) {
            skipped.push({
              relativePath: relativeToRoot(fullPath),
              reason: 'symlink_directory_skipped',
            });
            continue;
          }
          if (!targetStats.isFile()) {
            skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'not_a_regular_file' });
            continue;
          }
          if (!IMPORTABLE_EXTENSION.test(entry.name)) {
            skipped.push({
              relativePath: relativeToRoot(fullPath),
              reason: 'unsupported_file_type',
            });
            continue;
          }
          addFile(fullPath, true, { canonicalPath: canonicalTarget, stats: targetStats });
          continue;
        }

        if (entryStats.isDirectory()) {
          addManifestEntry(fullPath, 'directory', entryStats);
          walk(fullPath, depth + 1);
          if (traversalStopped) return;
          continue;
        }

        if (entryStats.isFile()) {
          addManifestEntry(fullPath, 'file', entryStats);
          if (IMPORTABLE_EXTENSION.test(entry.name)) {
            addFile(fullPath, false);
          } else {
            skipped.push({
              relativePath: relativeToRoot(fullPath),
              reason: 'unsupported_file_type',
            });
          }
          continue;
        }

        addManifestEntry(fullPath, 'other', entryStats);
        skipped.push({ relativePath: relativeToRoot(fullPath), reason: 'not_a_regular_file' });
      }
    } finally {
      try {
        dir.closeSync();
      } catch {
        // Closing a read-only traversal handle cannot change the manifest.
      }
    }
  }

  walk(root, 0);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  manifestEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  skipped.sort(
    (a, b) => a.relativePath.localeCompare(b.relativePath) || a.reason.localeCompare(b.reason),
  );

  return {
    root,
    canonicalRoot,
    rootDevice: rootIdentity.device,
    rootInode: rootIdentity.inode,
    manifestEntries,
    files,
    skipped,
    visitedEntries,
    visitedDirectories,
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
  manifestEntries: TraversalManifestEntry[];
  groups: PlannedFolderGroup[];
  skipped: FolderSkip[];
  visitedEntries: number;
  visitedDirectories: number;
  totalFiles: number;
  totalBytes: number;
  truncated: boolean;
  limits: Required<FolderWalkOptions>;
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
  const limits: Required<FolderWalkOptions> = {
    maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
    maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxGroupBytes,
    maxVisitedEntries: opts.maxVisitedEntries ?? DEFAULT_MAX_VISITED_ENTRIES,
    maxDirectories: opts.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
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
    manifestEntries: walk.manifestEntries,
    groups,
    skipped,
    visitedEntries: walk.visitedEntries,
    visitedDirectories: walk.visitedDirectories,
    totalFiles: groups.reduce((sum, group) => sum + group.files.length, 0),
    totalBytes: groups.reduce((sum, group) => sum + group.totalBytes, 0),
    truncated,
    limits,
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
  visitedEntries: number;
  visitedDirectories: number;
  totalFiles: number;
  totalBytes: number;
  truncated: boolean;
  confirmationToken: string;
}

function planConfirmationToken(plan: FolderImportPlan): string {
  return sha256Hex(
    stableStringify({
      version: 1,
      root: {
        requested: plan.root,
        canonical: plan.canonicalRoot,
        device: plan.rootDevice,
        inode: plan.rootInode,
      },
      manifestEntries: plan.manifestEntries,
      groups: plan.groups,
      skipped: plan.skipped,
      visitedEntries: plan.visitedEntries,
      visitedDirectories: plan.visitedDirectories,
      totalFiles: plan.totalFiles,
      totalBytes: plan.totalBytes,
      truncated: plan.truncated,
      limits: plan.limits,
    }),
  );
}

/**
 * Bind confirmation to the exact value-free preview manifest. The client
 * returns only this opaque digest; a fresh bounded traversal must reproduce
 * it before any source bytes are read or database transaction begins.
 */
export function confirmFolderImportPlan(plan: FolderImportPlan, token: string): void {
  if (!/^[a-f0-9]{64}$/.test(token) || token !== planConfirmationToken(plan)) {
    throw new FolderImportError('path_changed', 'folder changed after preview');
  }
  if (plan.truncated) {
    throw new FolderImportError(
      'folder_limits_exceeded',
      'folder preview exceeded safe traversal limits',
    );
  }
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
    visitedEntries: plan.visitedEntries,
    visitedDirectories: plan.visitedDirectories,
    totalFiles: plan.totalFiles,
    totalBytes: plan.totalBytes,
    truncated: plan.truncated,
    confirmationToken: planConfirmationToken(plan),
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
    if (isPlannedEntryChange(err)) {
      throw new FolderImportError('file_changed', 'file changed after traversal');
    }
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
