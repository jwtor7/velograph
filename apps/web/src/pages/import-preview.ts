import type { FolderPreviewBody } from '../api.ts';

export type FolderPreviewRequest = (path: string) => Promise<{ preview: FolderPreviewBody }>;

export type CurrentFolderPreview =
  { status: 'current'; preview: FolderPreviewBody } | { status: 'stale' };

/**
 * Resolve a preview only while its requested path is still the value in the
 * editable path field. Both stale successes and stale failures are ignored.
 */
export async function requestCurrentFolderPreview(
  requestedPath: string,
  getCurrentPath: () => string,
  request: FolderPreviewRequest,
): Promise<CurrentFolderPreview> {
  const normalizedRequestedPath = requestedPath.trim();
  try {
    const response = await request(normalizedRequestedPath);
    if (getCurrentPath().trim() !== normalizedRequestedPath) {
      return { status: 'stale' };
    }
    return { status: 'current', preview: response.preview };
  } catch (err) {
    if (getCurrentPath().trim() !== normalizedRequestedPath) {
      return { status: 'stale' };
    }
    throw err;
  }
}
