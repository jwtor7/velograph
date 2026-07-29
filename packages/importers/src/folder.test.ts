import { describe, expect, it, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmFolderImportPlan,
  FolderImportError,
  planFolderImport,
  previewImportFolder,
  readFolderFileGroups,
  walkImportFolder,
} from './folder.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'velograph-folder-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('walkImportFolder — checkout guard', () => {
  it('rejects a path resolving inside a git checkout, reusing guardAgainstCheckout', () => {
    const root = tempDir();
    // A directory containing a `.git` marker looks like a checkout to
    // guardAgainstCheckout, the exact function VELO_DATA_DIR and backups use.
    mkdirSync(join(root, '.git'));
    expect(() => walkImportFolder(root)).toThrow(FolderImportError);
    try {
      walkImportFolder(root);
    } catch (err) {
      expect(err).toBeInstanceOf(FolderImportError);
      expect((err as FolderImportError).code).toBe('inside_checkout');
    }
  });

  it('rejects a subfolder nested inside a checkout', () => {
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'exports', 'ride-folder');
    mkdirSync(nested, { recursive: true });
    expect(() => walkImportFolder(nested)).toThrow(FolderImportError);
  });

  it('rejects a nonexistent path', () => {
    const root = tempDir();
    expect(() => walkImportFolder(join(root, 'does-not-exist'))).toThrow(FolderImportError);
  });

  it('rejects a path that is a file, not a directory', () => {
    const root = tempDir();
    const file = join(root, 'not-a-dir.csv');
    writeFileSync(file, 'a,b\n1,2\n');
    try {
      walkImportFolder(file);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FolderImportError);
      expect((err as FolderImportError).code).toBe('not_a_directory');
    }
  });
});

describe('walkImportFolder — nested subfolders', () => {
  it('recurses into subfolders and finds files at every depth', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');
    const sub = join(root, '2026-01-02-ride');
    mkdirSync(sub);
    writeFileSync(join(sub, 'Outdoor Cycling-Cycling Cadence-20260102_070000.csv'), 'x');
    const subsub = join(sub, 'route');
    mkdirSync(subsub);
    writeFileSync(join(subsub, 'Outdoor Cycling-Route-20260102_070000.gpx'), 'x');

    const result = walkImportFolder(root);
    expect(result.files.map((f) => f.relativePath).sort()).toEqual(
      [
        'Outdoor Cycling-Heart Rate-20260101_070000.csv',
        '2026-01-02-ride/Outdoor Cycling-Cycling Cadence-20260102_070000.csv',
        '2026-01-02-ride/route/Outdoor Cycling-Route-20260102_070000.gpx',
      ].sort(),
    );
  });

  it('fails closed when a nested directory is swapped before it is opened', () => {
    const outside = tempDir();
    const outsideName = 'synthetic-outside-only-name.txt';
    writeFileSync(join(outside, outsideName), 'invented note');

    const root = tempDir();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'synthetic-inside.txt'), 'invented note');
    const symlinkProbe = join(root, 'synthetic-symlink-probe');
    try {
      symlinkSync(outside, symlinkProbe, 'dir');
      unlinkSync(symlinkProbe);
    } catch {
      return; // symlinks unsupported in this environment
    }

    let hookCalls = 0;
    try {
      walkImportFolder(
        root,
        {},
        {
          beforeDirectoryOpen: (relativePath) => {
            if (relativePath !== 'nested') return;
            hookCalls++;
            rmSync(nested, { recursive: true });
            symlinkSync(outside, nested, 'dir');
          },
        },
      );
      expect.unreachable('directory replacement should fail the traversal');
    } catch (err) {
      expect(err).toBeInstanceOf(FolderImportError);
      expect((err as FolderImportError).code).toBe('path_changed');
      expect((err as FolderImportError).message).toBe('folder changed during traversal');
      expect((err as FolderImportError).message).not.toContain(outsideName);
      expect((err as FolderImportError).message).not.toContain(outside);
    }
    expect(hookCalls).toBe(1);
  });
});

describe('walkImportFolder — caps', () => {
  it('caps total file count and reports the file that tipped it over', () => {
    const root = tempDir();
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `Outdoor Cycling-Heart Rate-2026010${i}_070000.csv`), 'x');
    }
    const result = walkImportFolder(root, { maxFiles: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.skipped.some((s) => s.reason === 'max_files_exceeded')).toBe(true);
  });

  it('caps total bytes and reports the file that tipped it over', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'a'.repeat(100));
    writeFileSync(
      join(root, 'Outdoor Cycling-Cycling Cadence-20260101_070000.csv'),
      'b'.repeat(100),
    );
    const result = walkImportFolder(root, { maxTotalBytes: 150 });
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.skipped.some((s) => s.reason === 'max_total_bytes_exceeded')).toBe(true);
    expect(result.totalBytes).toBeLessThanOrEqual(150);
  });

  it('does not truncate when files fit comfortably under the caps', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');
    const result = walkImportFolder(root, { maxFiles: 100, maxTotalBytes: 1_000_000 });
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);
  });

  it('counts unsupported entries toward the traversal-entry bound', () => {
    const root = tempDir();
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `unsupported-${i}.txt`), 'x');
    const result = walkImportFolder(root, { maxVisitedEntries: 2 });
    expect(result.truncated).toBe(true);
    expect(result.visitedEntries).toBe(2);
    expect(result.skipped.some((item) => item.reason === 'max_entries_exceeded')).toBe(true);
  });

  it('bounds visited directories and recursion depth explicitly', () => {
    const root = tempDir();
    const first = join(root, 'first');
    const second = join(first, 'second');
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');

    const directoryBound = walkImportFolder(root, { maxDirectories: 1 });
    expect(directoryBound.truncated).toBe(true);
    expect(directoryBound.visitedDirectories).toBe(1);
    expect(directoryBound.skipped.some((item) => item.reason === 'max_directories_exceeded')).toBe(
      true,
    );

    const depthBound = walkImportFolder(root, { maxDepth: 1 });
    expect(depthBound.truncated).toBe(true);
    expect(depthBound.skipped.some((item) => item.reason === 'max_depth_exceeded')).toBe(true);
  });
});

describe('walkImportFolder — symlinks', () => {
  it('does not follow a symlinked directory, even inside the tree', () => {
    const root = tempDir();
    const real = join(root, 'real-sub');
    mkdirSync(real);
    writeFileSync(join(real, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');
    try {
      symlinkSync(real, join(root, 'linked-sub'), 'dir');
    } catch {
      return; // symlinks unsupported in this environment (e.g. some CI sandboxes)
    }
    const result = walkImportFolder(root);
    // The real subfolder is walked normally; the symlinked alias is skipped.
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.relativePath).toBe(
      'real-sub/Outdoor Cycling-Heart Rate-20260101_070000.csv',
    );
    expect(result.skipped.some((s) => s.reason === 'symlink_directory_skipped')).toBe(true);
  });

  it('skips a symlinked file pointing outside the walked tree', () => {
    const outside = tempDir();
    const outsideFile = join(outside, 'Outdoor Cycling-Heart Rate-20260101_070000.csv');
    writeFileSync(outsideFile, 'x');

    const root = tempDir();
    try {
      symlinkSync(outsideFile, join(root, 'Outdoor Cycling-Cycling Cadence-20260101_070000.csv'));
    } catch {
      return;
    }
    const result = walkImportFolder(root);
    expect(result.files).toHaveLength(0);
    expect(result.skipped.some((s) => s.reason === 'symlink_outside_tree')).toBe(true);
  });

  it('follows a symlinked file that stays inside the walked tree', () => {
    const root = tempDir();
    const real = join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv');
    writeFileSync(real, 'x');
    try {
      symlinkSync(real, join(root, 'Outdoor Cycling-Heart Rate-alias-20260101_070000.csv'));
    } catch {
      return;
    }
    const result = walkImportFolder(root);
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    expect(result.skipped.some((s) => s.reason === 'symlink_outside_tree')).toBe(false);
  });

  it('reports an unsupported symlink alias whose regular target stays inside the tree', () => {
    const root = tempDir();
    const real = join(root, 'synthetic-notes.txt');
    const alias = join(root, 'synthetic-notes-alias.txt');
    writeFileSync(real, 'invented note');
    try {
      symlinkSync(real, alias);
    } catch {
      return;
    }

    const result = walkImportFolder(root);
    expect(result.skipped).toContainEqual({
      relativePath: 'synthetic-notes-alias.txt',
      reason: 'unsupported_file_type',
    });
  });

  it('reports containment before extension for an unsupported symlink outside the tree', () => {
    const outside = tempDir();
    const outsideFile = join(outside, 'synthetic-notes.txt');
    writeFileSync(outsideFile, 'invented note');

    const root = tempDir();
    try {
      symlinkSync(outsideFile, join(root, 'synthetic-notes-alias.txt'));
    } catch {
      return;
    }

    const result = walkImportFolder(root);
    expect(result.skipped).toContainEqual({
      relativePath: 'synthetic-notes-alias.txt',
      reason: 'symlink_outside_tree',
    });
  });
});

describe('previewImportFolder — grouping', () => {
  it('groups companion metric files and the route by workout type + timestamp', () => {
    const root = tempDir();
    const stamp = '20260503_163721';
    for (const label of ['Heart Rate', 'Cycling Cadence', 'Cycling Distance', 'Active Energy']) {
      writeFileSync(join(root, `Outdoor Cycling-${label}-${stamp}.csv`), 'x');
    }
    writeFileSync(join(root, `Outdoor Cycling-Route-${stamp}.csv`), 'x');
    writeFileSync(join(root, `Outdoor Cycling-Route-${stamp}.gpx`), 'x');
    // A second, unrelated ride.
    const stamp2 = '20260504_070000';
    writeFileSync(join(root, `Indoor Cycling-Heart Rate-${stamp2}.csv`), 'x');
    // An unrecognized file and a zip archive.
    writeFileSync(join(root, 'notes.txt'), 'x'); // wrong extension: silently not walked
    writeFileSync(join(root, 'random-export.csv'), 'x'); // csv, but not HAE-shaped
    writeFileSync(join(root, 'bundle.zip'), 'x');

    const preview = previewImportFolder(root);
    expect(preview.rides).toHaveLength(2);
    const ride1 = preview.rides.find((r) => r.stampHint === stamp)!;
    expect(ride1.workoutType).toBe('outdoor_cycling');
    expect(ride1.files).toHaveLength(6);
    const ride2 = preview.rides.find((r) => r.stampHint === stamp2)!;
    expect(ride2.workoutType).toBe('indoor_cycling');
    expect(ride2.files).toHaveLength(1);

    expect(preview.ungrouped.map((u) => u.name).sort()).toEqual([
      'bundle.zip',
      'random-export.csv',
    ]);
    expect(preview.ungrouped.find((u) => u.name === 'bundle.zip')!.classification).toBe(
      'zip_archive',
    );
    expect(preview.ungrouped.find((u) => u.name === 'random-export.csv')!.classification).toBe(
      'unrecognized_filename',
    );

    // No file contents, coordinates, or source strings anywhere in the preview.
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toMatch(/-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/);
    expect(serialized).not.toMatch(/Apple\s+Watch/);
  });

  it('reflects skipped/truncated state from the underlying walk', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');
    writeFileSync(join(root, 'Outdoor Cycling-Cycling Cadence-20260101_070000.csv'), 'x');
    const preview = previewImportFolder(root, { maxFiles: 1 });
    expect(preview.truncated).toBe(true);
    expect(preview.skipped.length).toBeGreaterThan(0);
  });

  it('reports every unsupported regular file instead of silently omitting it', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');
    writeFileSync(join(root, 'metadata.json'), '{}');
    writeFileSync(join(root, 'notes.txt'), 'synthetic note');

    const preview = previewImportFolder(root);
    expect(preview.totalFiles).toBe(1);
    expect(preview.skipped).toEqual([
      { relativePath: 'metadata.json', reason: 'unsupported_file_type' },
      { relativePath: 'notes.txt', reason: 'unsupported_file_type' },
    ]);
    expect(() =>
      confirmFolderImportPlan(planFolderImport(root), preview.confirmationToken),
    ).not.toThrow();
  });

  it('returns an opaque digest and refuses confirmation of a truncated manifest', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');
    writeFileSync(join(root, 'Outdoor Cycling-Cycling Cadence-20260101_070000.csv'), 'x');
    const opts = { maxFiles: 1 };
    const preview = previewImportFolder(root, opts);
    const plan = planFolderImport(root, opts);
    expect(preview.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(() => confirmFolderImportPlan(plan, preview.confirmationToken)).toThrowError(
      expect.objectContaining({ code: 'folder_limits_exceeded' }),
    );
  });

  it('binds confirmation to accepted and unsupported traversal entries', () => {
    const root = tempDir();
    const path = join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv');
    writeFileSync(path, 'original');
    const preview = previewImportFolder(root);
    expect(() =>
      confirmFolderImportPlan(planFolderImport(root), preview.confirmationToken),
    ).not.toThrow();

    writeFileSync(join(root, 'unsupported-after-preview.txt'), 'x');
    expect(() =>
      confirmFolderImportPlan(planFolderImport(root), preview.confirmationToken),
    ).toThrowError(expect.objectContaining({ code: 'path_changed' }));
  });
});

describe('planFolderImport — bounded deterministic groups', () => {
  it('orders association groups and their files deterministically', () => {
    const root = tempDir();
    for (const name of [
      'Outdoor Cycling-Heart Rate-20260102_070000.csv',
      'Outdoor Cycling-Cycling Cadence-20260101_070000.csv',
      'Outdoor Cycling-Heart Rate-20260101_070000.csv',
      'Indoor Cycling-Heart Rate-20260103_070000.csv',
      'bundle.zip',
      'unknown.csv',
    ]) {
      writeFileSync(join(root, name), name);
    }

    const plan = planFolderImport(root);
    expect(plan.groups.map((group) => group.groupKey)).toEqual([
      'ride:outdoor_cycling:20260101_070000',
      'ride:outdoor_cycling:20260102_070000',
      'ride:indoor_cycling:20260103_070000',
      'zip:bundle.zip',
      'unrecognized:unknown.csv',
    ]);
    expect(plan.groups[0]!.files.map((file) => file.relativePath)).toEqual([
      'Outdoor Cycling-Cycling Cadence-20260101_070000.csv',
      'Outdoor Cycling-Heart Rate-20260101_070000.csv',
    ]);
  });

  it('excludes an over-limit association group in full instead of importing a partial ride', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'a'.repeat(8));
    writeFileSync(join(root, 'Outdoor Cycling-Cycling Cadence-20260101_070000.csv'), 'b'.repeat(8));
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260102_070000.csv'), 'c'.repeat(4));

    const plan = planFolderImport(root, { maxGroupBytes: 12 });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.groupKey).toBe('ride:outdoor_cycling:20260102_070000');
    expect(plan.totalFiles).toBe(1);
    expect(plan.totalBytes).toBe(4);
    expect(plan.truncated).toBe(true);
    expect(plan.skipped.filter((item) => item.reason === 'max_group_bytes_exceeded')).toHaveLength(
      2,
    );
  });
});

describe('readFolderFileGroups — lazy bounded reads and TOCTOU checks', () => {
  it('reads only the requested group and preserves planned order', () => {
    const root = tempDir();
    const first = 'Outdoor Cycling-Heart Rate-20260101_070000.csv';
    const second = 'Outdoor Cycling-Heart Rate-20260102_070000.csv';
    writeFileSync(join(root, first), 'first-group');
    writeFileSync(join(root, second), 'second-group');

    const plan = planFolderImport(root);
    const groups = readFolderFileGroups(plan);
    const iterator = groups[Symbol.iterator]();
    const firstRead = iterator.next();
    expect(firstRead.done).toBe(false);
    if (firstRead.done) throw new Error('expected first group');
    const firstFiles = firstRead.value();
    expect(firstFiles.map((file) => file.name)).toEqual([first]);
    expect(Buffer.from(firstFiles[0]!.data).toString()).toBe('first-group');

    // Even requesting the second loader does not read it. Changing the file
    // is detected only when that bounded group's loader is invoked.
    const secondRead = iterator.next();
    if (secondRead.done) throw new Error('expected second group');
    const original = join(root, second);
    renameSync(original, join(root, 'replaced-second.csv'));
    writeFileSync(original, 'second-group'); // same size, different inode
    expect(() => secondRead.value()).toThrowError(
      expect.objectContaining({ code: 'file_changed' }),
    );
  });

  it('rejects a same-size file replacement after metadata traversal', () => {
    const root = tempDir();
    const name = 'Outdoor Cycling-Heart Rate-20260101_070000.csv';
    const path = join(root, name);
    writeFileSync(path, 'original');
    const plan = planFolderImport(root);
    renameSync(path, join(root, 'old.csv'));
    writeFileSync(path, 'replaced');

    expect(() => [...readFolderFileGroups(plan)].flatMap((load) => load())).toThrowError(
      expect.objectContaining({ code: 'file_changed' }),
    );
  });

  it('rejects a root symlink retargeted after metadata traversal', () => {
    const firstRoot = tempDir();
    const secondRoot = tempDir();
    const linkParent = tempDir();
    const rootLink = join(linkParent, 'selected-export');
    const name = 'Outdoor Cycling-Heart Rate-20260101_070000.csv';
    writeFileSync(join(firstRoot, name), 'first');
    writeFileSync(join(secondRoot, name), 'other');
    try {
      symlinkSync(firstRoot, rootLink, 'dir');
    } catch {
      return;
    }
    const plan = planFolderImport(rootLink);
    unlinkSync(rootLink);
    symlinkSync(secondRoot, rootLink, 'dir');

    expect(() => [...readFolderFileGroups(plan)].flatMap((load) => load())).toThrowError(
      expect.objectContaining({ code: 'path_changed' }),
    );
  });

  it('classifies a planned file deleted after confirmation as file_changed', () => {
    const root = tempDir();
    const name = 'Outdoor Cycling-Heart Rate-20260101_070000.csv';
    const path = join(root, name);
    writeFileSync(path, 'synthetic');

    const preview = previewImportFolder(root);
    const plan = planFolderImport(root);
    confirmFolderImportPlan(plan, preview.confirmationToken);
    const load = [...readFolderFileGroups(plan)][0]!;
    unlinkSync(path);

    expect(() => load()).toThrowError(expect.objectContaining({ code: 'file_changed' }));
  });

  it('classifies a planned path component replaced by a file as file_changed', () => {
    const root = tempDir();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'synthetic');

    const preview = previewImportFolder(root);
    const plan = planFolderImport(root);
    confirmFolderImportPlan(plan, preview.confirmationToken);
    const load = [...readFolderFileGroups(plan)][0]!;
    rmSync(nested, { recursive: true });
    writeFileSync(nested, 'synthetic replacement');

    expect(() => load()).toThrowError(expect.objectContaining({ code: 'file_changed' }));
  });

  it('never returns canonical paths or identity metadata in the public preview', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'x');
    const preview = previewImportFolder(root);
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('canonicalRoot');
    expect(serialized).not.toContain('canonicalPath');
    expect(serialized).not.toContain('rootDevice');
    expect(serialized).not.toContain('inode');
  });
});
