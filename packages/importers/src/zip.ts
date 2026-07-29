import { inflateRawSync } from 'node:zlib';

export const ZIP_PARSER_VERSION = 'zip-v2';

/**
 * Guarded ZIP extraction (PRD §12.3). Entries are extracted to memory only —
 * never to disk — so symlink escapes cannot occur. Security is enforced in
 * two bounded phases:
 *  1. parse the central directory and matching local headers without
 *     inflating, validating names/counts/declared sizes;
 *  2. inflate each validated compressed range with Node's `maxOutputLength`
 *     configured before decoding, so actual output cannot be materialized
 *     beyond the remaining per-entry or aggregate limit.
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

export interface ZipDecodedBudget {
  remainingBytes: number;
}

export function createZipDecodedBudget(maxBytes: number): ZipDecodedBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ZipError('zip_limits_exceeded', 'decoded-byte budget is invalid');
  }
  return { remainingBytes: maxBytes };
}

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

export interface ZipEntry {
  /** Base filename (directories are flattened; HAE exports are flat). */
  name: string;
  data: Uint8Array;
}

interface PreparedZipEntry {
  name: string;
  outputName?: string;
  localOffset: number;
  dataOffset: number;
  compression: number;
  crc: number;
  compressedBytes: number;
  declaredBytes: number;
  inflate: boolean;
}

interface ZipExtractionHooks {
  onEntryStart?: (name: string) => void;
  onChunk?: (name: string, bytes: number) => void;
}

function isDecodedBudget(
  value: ZipDecodedBudget | ZipExtractionHooks | undefined,
): value is ZipDecodedBudget {
  return value !== undefined && 'remainingBytes' in value;
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
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    !Number.isSafeInteger(limits.maxEntryBytes) ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxEntries < 0 ||
    limits.maxEntryBytes < 0 ||
    limits.maxTotalBytes < 0
  ) {
    throw new ZipError('zip_limits_exceeded', 'zip limits are invalid');
  }
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
      dataOffset: localHeaderEnd,
      compression,
      crc,
      compressedBytes,
      declaredBytes,
      inflate,
    });
    cursor = next;
  }

  if (cursor !== eocd) throw new ZipError('io_error', 'zip central directory is invalid');
  return entries.sort((a, b) => a.localOffset - b.localOffset);
}

export function extractZip(
  zipData: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  control?: ZipDecodedBudget | ZipExtractionHooks,
  additionalHooks?: ZipExtractionHooks,
): ZipEntry[] {
  const prepared = prepareZip(zipData, limits);
  const budget = isDecodedBudget(control) ? control : undefined;
  const hooks: ZipExtractionHooks | undefined = budget
    ? additionalHooks
    : (control as ZipExtractionHooks | undefined);
  const declaredTotal = prepared.reduce(
    (total, entry) => total + (entry.inflate ? entry.declaredBytes : 0),
    0,
  );
  if (
    budget &&
    (!Number.isSafeInteger(budget.remainingBytes) ||
      budget.remainingBytes < 0 ||
      declaredTotal > budget.remainingBytes)
  ) {
    throw new ZipError('zip_limits_exceeded', 'decompressed size exceeds shared limit');
  }
  // Reserve before inflation so multiple archives cannot each consume the
  // full batch allowance, even when an archive later fails integrity checks.
  if (budget) budget.remainingBytes -= declaredTotal;
  const entries: ZipEntry[] = [];
  let actualTotal = 0;

  for (const expected of prepared) {
    if (!expected.inflate) continue;

    const remainingTotal = limits.maxTotalBytes - actualTotal;
    const remainingOutput = Math.min(limits.maxEntryBytes, remainingTotal);
    if (remainingOutput <= 0) {
      throw new ZipError('zip_limits_exceeded', 'decompressed size exceeds limit');
    }

    hooks?.onEntryStart?.(expected.name);
    const compressed = zipData.subarray(
      expected.dataOffset,
      expected.dataOffset + expected.compressedBytes,
    );
    let data: Uint8Array;

    if (expected.compression === 0) {
      if (compressed.length > remainingOutput) {
        throw new ZipError('zip_limits_exceeded', 'decompressed size exceeds limit');
      }
      data = compressed.slice();
    } else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: remainingOutput });
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          err.code === 'ERR_BUFFER_TOO_LARGE'
        ) {
          throw new ZipError('zip_limits_exceeded', 'decompressed size exceeds limit');
        }
        throw new ZipError('io_error', 'zip could not be read');
      }
    }

    if (data.length !== expected.declaredBytes || crc32(data) !== expected.crc) {
      throw new ZipError('zip_entry_rejected', 'entry output does not match its declared size');
    }
    actualTotal += data.length;
    hooks?.onChunk?.(expected.name, data.length);
    entries.push({ name: expected.outputName!, data });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
