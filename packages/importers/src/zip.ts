import { unzipSync } from 'fflate';

/**
 * Guarded ZIP extraction (PRD §12.3). Entries are extracted to memory only —
 * never to disk — so symlink escapes cannot occur. Guards:
 *  - entry-name validation: no absolute paths, no `..` traversal, no
 *    backslash tricks, no NUL bytes
 *  - no nested archives
 *  - entry-count, per-entry, and total decompressed-size caps
 *    (decompression-bomb protection enforced during inflation via a filter
 *     on declared size plus a hard check on actual output)
 */
export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

export type ZipErrorCode = 'zip_entry_rejected' | 'zip_limits_exceeded' | 'io_error';

export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const NESTED_ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;

export interface ZipEntry {
  /** Base filename (directories are flattened; HAE exports are flat). */
  name: string;
  data: Uint8Array;
}

export function extractZip(
  zipData: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ZipEntry[] {
  let decoded: Record<string, Uint8Array>;
  let entrySeen = 0;
  try {
    decoded = unzipSync(zipData, {
      filter: (file) => {
        entrySeen++;
        if (entrySeen > limits.maxEntries) {
          throw new ZipError('zip_limits_exceeded', 'too many entries');
        }
        validateEntryName(file.name);
        if (file.name.endsWith('/')) return false; // directory marker
        if (NESTED_ARCHIVE.test(file.name)) {
          throw new ZipError('zip_entry_rejected', 'nested archives are not supported');
        }
        if (file.originalSize > limits.maxEntryBytes) {
          throw new ZipError('zip_limits_exceeded', 'entry exceeds size limit');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError('io_error', 'zip could not be read');
  }

  const entries: ZipEntry[] = [];
  let total = 0;
  for (const [name, data] of Object.entries(decoded)) {
    total += data.length;
    if (data.length > limits.maxEntryBytes || total > limits.maxTotalBytes) {
      throw new ZipError('zip_limits_exceeded', 'decompressed size exceeds limit');
    }
    if (name.split('/').includes('__MACOSX')) continue; // macOS resource-fork noise
    const base = name.split('/').filter(Boolean).pop();
    if (!base || base.startsWith('.')) continue; // hidden/system entries (e.g. __MACOSX dotfiles)
    entries.push({ name: base, data });
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function validateEntryName(name: string): void {
  if (name.includes('\0') || name.includes('\\')) {
    throw new ZipError('zip_entry_rejected', 'entry name contains forbidden characters');
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError('zip_entry_rejected', 'absolute entry paths are not allowed');
  }
  if (name.split('/').includes('..')) {
    throw new ZipError('zip_entry_rejected', 'path traversal entry rejected');
  }
}
