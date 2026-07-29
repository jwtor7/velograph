import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';

/**
 * Guarded ZIP extraction (PRD §12.3). Entries are extracted to memory only —
 * never to disk — so symlink escapes cannot occur. Security is enforced in
 * two bounded phases:
 *  1. parse the central directory and matching local headers without
 *     inflating, validating names/counts/declared sizes;
 *  2. stream compressed input through fflate and stop as soon as actual
 *     per-entry or aggregate output exceeds a limit.
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
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_535 + 22;
const INPUT_CHUNK_BYTES = 64 * 1024;

export interface ZipEntry {
  /** Base filename (directories are flattened; HAE exports are flat). */
  name: string;
  data: Uint8Array;
}

interface PreparedZipEntry {
  name: string;
  outputName?: string;
  localOffset: number;
  compression: number;
  compressedBytes: number;
  declaredBytes: number;
  inflate: boolean;
}

interface ZipExtractionHooks {
  onEntryStart?: (name: string) => void;
  onChunk?: (name: string, bytes: number) => void;
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function uint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function uint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ZipError('zip_entry_rejected', 'entry name is not valid UTF-8');
  }
}

function findEndOfCentralDirectory(data: Uint8Array, view: DataView): number {
  const start = Math.max(0, data.length - MAX_EOCD_SEARCH);
  for (let offset = data.length - 22; offset >= start; offset--) {
    if (uint32(view, offset) !== EOCD_SIGNATURE) continue;
    const commentBytes = uint16(view, offset + 20);
    if (offset + 22 + commentBytes === data.length) return offset;
  }
  throw new ZipError('io_error', 'zip could not be read');
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

function skippedBeforeInflation(name: string): boolean {
  if (name.endsWith('/')) return true;
  const parts = name.split('/').filter(Boolean);
  return parts.some((part) => part === '__MACOSX' || part.startsWith('.'));
}

function prepareZip(zipData: Uint8Array, limits: ZipLimits): PreparedZipEntry[] {
  if (zipData.length < 22) throw new ZipError('io_error', 'zip could not be read');
  const view = viewOf(zipData);
  const eocd = findEndOfCentralDirectory(zipData, view);
  const disk = uint16(view, eocd + 4);
  const centralDisk = uint16(view, eocd + 6);
  const entriesOnDisk = uint16(view, eocd + 8);
  const entryCount = uint16(view, eocd + 10);
  const centralBytes = uint32(view, eocd + 12);
  const centralOffset = uint32(view, eocd + 16);

  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new ZipError('zip_entry_rejected', 'multi-disk and ZIP64 archives are not supported');
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError('zip_limits_exceeded', 'too many entries');
  }
  if (
    centralOffset > eocd ||
    centralBytes > eocd - centralOffset ||
    centralOffset + centralBytes !== eocd
  ) {
    throw new ZipError('io_error', 'zip central directory is invalid');
  }

  const entries: PreparedZipEntry[] = [];
  const names = new Set<string>();
  const outputNames = new Set<string>();
  let declaredTotal = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || uint32(view, cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('io_error', 'zip central directory is invalid');
    }

    const flags = uint16(view, cursor + 8);
    const compression = uint16(view, cursor + 10);
    const crc = uint32(view, cursor + 16);
    const compressedBytes = uint32(view, cursor + 20);
    const declaredBytes = uint32(view, cursor + 24);
    const nameBytes = uint16(view, cursor + 28);
    const extraBytes = uint16(view, cursor + 30);
    const commentBytes = uint16(view, cursor + 32);
    const startDisk = uint16(view, cursor + 34);
    const localOffset = uint32(view, cursor + 42);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (next > eocd) throw new ZipError('io_error', 'zip central directory is invalid');
    if (startDisk !== 0 || localOffset === 0xffffffff) {
      throw new ZipError('zip_entry_rejected', 'multi-disk and ZIP64 archives are not supported');
    }
    if ((flags & 0x0001) !== 0) {
      throw new ZipError('zip_entry_rejected', 'encrypted entries are not supported');
    }
    if (compression !== 0 && compression !== 8) {
      throw new ZipError('zip_entry_rejected', 'entry compression is not supported');
    }

    const centralNameBytes = zipData.subarray(cursor + 46, cursor + 46 + nameBytes);
    const name = decodeName(centralNameBytes);
    validateEntryName(name);
    if (names.has(name)) {
      throw new ZipError('zip_entry_rejected', 'duplicate entry names are not supported');
    }
    names.add(name);

    if (localOffset + 30 > centralOffset || uint32(view, localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError('zip_entry_rejected', 'entry header does not match its manifest');
    }
    const localFlags = uint16(view, localOffset + 6);
    const localCompression = uint16(view, localOffset + 8);
    const localCrc = uint32(view, localOffset + 14);
    const localCompressedBytes = uint32(view, localOffset + 18);
    const localDeclaredBytes = uint32(view, localOffset + 22);
    const localNameBytes = uint16(view, localOffset + 26);
    const localExtraBytes = uint16(view, localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameBytes + localExtraBytes;
    if (localHeaderEnd > centralOffset) {
      throw new ZipError('zip_entry_rejected', 'entry header does not match its manifest');
    }
    const localName = zipData.subarray(localOffset + 30, localOffset + 30 + localNameBytes);
    const usesDescriptor = (flags & 0x0008) !== 0;
    const localSizesMatch = usesDescriptor
      ? (localCrc === 0 || localCrc === crc) &&
        (localCompressedBytes === 0 || localCompressedBytes === compressedBytes) &&
        (localDeclaredBytes === 0 || localDeclaredBytes === declaredBytes)
      : localCrc === crc &&
        localCompressedBytes === compressedBytes &&
        localDeclaredBytes === declaredBytes;
    if (
      localFlags !== flags ||
      localCompression !== compression ||
      !bytesEqual(localName, centralNameBytes) ||
      !localSizesMatch ||
      compressedBytes > centralOffset - localHeaderEnd
    ) {
      throw new ZipError('zip_entry_rejected', 'entry header does not match its manifest');
    }

    const inflate = !skippedBeforeInflation(name);
    let outputName: string | undefined;
    if (inflate) {
      if (NESTED_ARCHIVE.test(name)) {
        throw new ZipError('zip_entry_rejected', 'nested archives are not supported');
      }
      if (declaredBytes > limits.maxEntryBytes) {
        throw new ZipError('zip_limits_exceeded', 'entry exceeds size limit');
      }
      declaredTotal += declaredBytes;
      if (declaredTotal > limits.maxTotalBytes) {
        throw new ZipError('zip_limits_exceeded', 'decompressed size exceeds limit');
      }
      outputName = name.split('/').filter(Boolean).pop();
      if (!outputName || outputNames.has(outputName)) {
        throw new ZipError(
          'zip_entry_rejected',
          'duplicate flattened entry names are not supported',
        );
      }
      outputNames.add(outputName);
    }

    entries.push({
      name,
      ...(outputName ? { outputName } : {}),
      localOffset,
      compression,
      compressedBytes,
      declaredBytes,
      inflate,
    });
    cursor = next;
  }

  if (cursor !== eocd) throw new ZipError('io_error', 'zip central directory is invalid');
  return entries.sort((a, b) => a.localOffset - b.localOffset);
}

function joinChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function terminate(files: Set<UnzipFile>): void {
  for (const file of files) {
    try {
      file.terminate();
    } catch {
      // Extraction is already failing closed.
    }
  }
}

export function extractZip(
  zipData: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  hooks?: ZipExtractionHooks,
): ZipEntry[] {
  const prepared = prepareZip(zipData, limits);
  const entries: ZipEntry[] = [];
  const active = new Set<UnzipFile>();
  let nextEntry = 0;
  let actualTotal = 0;
  let failure: ZipError | undefined;

  const fail = (error: ZipError, file?: UnzipFile): never => {
    failure = error;
    if (file) {
      try {
        file.terminate();
      } catch {
        // Throwing the stable error below is the fail-closed boundary.
      }
    }
    throw error;
  };

  const unzip = new Unzip((file) => {
    const expected =
      prepared[nextEntry++] ??
      fail(new ZipError('zip_entry_rejected', 'streamed entry does not match its manifest'), file);
    if (
      file.name !== expected.name ||
      file.compression !== expected.compression ||
      (file.size !== undefined && file.size !== expected.compressedBytes) ||
      (file.originalSize !== undefined && file.originalSize !== expected.declaredBytes)
    ) {
      fail(new ZipError('zip_entry_rejected', 'streamed entry does not match its manifest'), file);
    }
    if (!expected.inflate) return;

    const chunks: Uint8Array[] = [];
    let actualBytes = 0;
    active.add(file);
    hooks?.onEntryStart?.(expected.name);
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) fail(new ZipError('io_error', 'zip could not be read'), file);

      const nextActual = actualBytes + chunk.length;
      const nextTotal = actualTotal + chunk.length;
      hooks?.onChunk?.(expected.name, chunk.length);
      if (nextActual > limits.maxEntryBytes || nextTotal > limits.maxTotalBytes) {
        fail(new ZipError('zip_limits_exceeded', 'decompressed size exceeds limit'), file);
      }
      actualBytes = nextActual;
      actualTotal = nextTotal;
      if (chunk.length > 0) chunks.push(chunk.slice());

      if (final) {
        active.delete(file);
        if (actualBytes !== expected.declaredBytes) {
          fail(
            new ZipError('zip_entry_rejected', 'entry output does not match its declared size'),
            file,
          );
        }
        entries.push({
          name: expected.outputName!,
          data: joinChunks(chunks, actualBytes),
        });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    for (let offset = 0; offset < zipData.length; offset += INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + INPUT_CHUNK_BYTES, zipData.length);
      unzip.push(zipData.subarray(offset, end), end === zipData.length);
      if (failure) throw failure;
    }
    if (
      nextEntry !== prepared.length ||
      entries.length !== prepared.filter((e) => e.inflate).length
    ) {
      throw new ZipError('zip_entry_rejected', 'streamed archive does not match its manifest');
    }
  } catch (err) {
    terminate(active);
    if (err instanceof ZipError) throw err;
    throw new ZipError('io_error', 'zip could not be read');
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
