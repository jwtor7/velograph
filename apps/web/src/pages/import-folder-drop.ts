export interface DroppedFolderFile {
  file: File;
  /** Path relative to the dropped directory root, built from entry names. */
  relativePath: string;
}

type FileWithRuntimePath = File & { path?: unknown };

function normalizeRelativePath(path: string): string | null {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    return null;
  }
  return normalized;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path) || /^\/\/[^/]+\/[^/]+/.test(path);
}

/**
 * Progressive desktop-runtime enhancement for folder drops.
 *
 * Standard browsers do not expose an absolute `File.path`. When a trusted
 * local runtime does, accept it only if every file has an absolute path whose
 * exact suffix is the independently built relative entry path, and every file
 * resolves to the same root. `FileSystemEntry.fullPath` is deliberately not
 * accepted: browsers define it as a virtual path, not an OS path.
 */
export function resolveDroppedFolderPath(files: readonly DroppedFolderFile[]): string | null {
  if (files.length === 0) return null;

  let resolvedRoot: string | null = null;
  let windowsStyle = false;
  for (const dropped of files) {
    const runtimePath = (dropped.file as FileWithRuntimePath).path;
    const relativePath = normalizeRelativePath(dropped.relativePath);
    if (typeof runtimePath !== 'string' || runtimePath.trim() !== runtimePath || !relativePath) {
      return null;
    }

    windowsStyle ||= runtimePath.includes('\\') && !runtimePath.includes('/');
    const normalizedRuntimePath = runtimePath.replaceAll('\\', '/');
    if (!isAbsolutePath(normalizedRuntimePath)) return null;

    const suffix = `/${relativePath}`;
    if (!normalizedRuntimePath.endsWith(suffix)) return null;
    const root = normalizedRuntimePath.slice(0, -suffix.length);
    if (!isAbsolutePath(root) || root.endsWith('/')) return null;
    if (resolvedRoot !== null && resolvedRoot !== root) return null;
    resolvedRoot = root;
  }

  if (resolvedRoot === null) return null;
  return windowsStyle ? resolvedRoot.replaceAll('/', '\\') : resolvedRoot;
}
