import { describe, expect, it, vi } from 'vitest';
import type { FolderPreviewBody } from '../api.ts';
import { requestCurrentFolderPreview } from './import-preview.ts';

function syntheticPreview(): FolderPreviewBody {
  return {
    rides: [],
    ungrouped: [],
    skipped: [],
    visitedEntries: 0,
    visitedDirectories: 1,
    totalFiles: 0,
    totalBytes: 0,
    truncated: false,
    confirmationToken: 'a'.repeat(64),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('requestCurrentFolderPreview', () => {
  it('ignores an earlier path response after the editable path changes', async () => {
    let currentPath = '/invented/export-a';
    const pendingResponse = deferred<{ preview: FolderPreviewBody }>();
    const request = vi.fn(() => pendingResponse.promise);
    const pending = requestCurrentFolderPreview(currentPath, () => currentPath, request);

    currentPath = '/invented/export-b';
    pendingResponse.resolve({ preview: syntheticPreview() });

    await expect(pending).resolves.toEqual({ status: 'stale' });
    expect(request).toHaveBeenCalledWith('/invented/export-a');
  });

  it('ignores an earlier path failure after the editable path changes', async () => {
    let currentPath = '/invented/export-a';
    const pendingResponse = deferred<{ preview: FolderPreviewBody }>();
    const pending = requestCurrentFolderPreview(
      currentPath,
      () => currentPath,
      () => pendingResponse.promise,
    );

    currentPath = '/invented/export-b';
    pendingResponse.reject(new Error('synthetic request failure'));

    await expect(pending).resolves.toEqual({ status: 'stale' });
  });

  it('returns a response while its requested path is still current', async () => {
    const currentPath = '/invented/export-a';
    const preview = syntheticPreview();

    await expect(
      requestCurrentFolderPreview(
        currentPath,
        () => currentPath,
        async () => ({ preview }),
      ),
    ).resolves.toEqual({ status: 'current', preview });
  });
});
