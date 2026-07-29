import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmFolderImportPlan,
  FolderImportError,
  previewImportFolder,
  readFolderFiles,
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

describe('readFolderFiles', () => {
  it('reads bytes for every walked file, ready for runImport', () => {
    const root = tempDir();
    writeFileSync(join(root, 'Outdoor Cycling-Heart Rate-20260101_070000.csv'), 'hello');
    const { files, truncated } = readFolderFiles(root);
    expect(truncated).toBe(false);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('Outdoor Cycling-Heart Rate-20260101_070000.csv');
    expect(Buffer.from(files[0]!.data).toString('utf8')).toBe('hello');
  });
});
