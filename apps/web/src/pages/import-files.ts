import {
  DEFAULT_IMPORT_UPLOAD_LIMITS,
  type ImportUploadLimits,
} from '@velograph/shared/import-limits';
import type { ImportInventoryItem, UploadFileBody } from '../api.ts';

export interface PickedImportFile {
  id: string;
  name: string;
  size: number;
  file: File;
}

export type ImportSelectionError =
  'import_file_count_exceeded' | 'import_file_too_large' | 'import_total_size_exceeded';

export function createPickedFiles(
  files: Iterable<File>,
  firstId: number,
): { files: PickedImportFile[]; nextId: number } {
  let nextId = firstId;
  const picked: PickedImportFile[] = [];
  for (const file of files) {
    if (!/\.(csv|gpx|zip)$/i.test(file.name)) continue;
    picked.push({
      id: `upload-${nextId++}`,
      name: file.name,
      size: file.size,
      file,
    });
  }
  return { files: picked, nextId };
}

export function validateImportSelection(
  files: readonly PickedImportFile[],
  limits: ImportUploadLimits = DEFAULT_IMPORT_UPLOAD_LIMITS,
): ImportSelectionError | null {
  if (files.length > limits.maxFiles) return 'import_file_count_exceeded';
  let total = 0;
  for (const file of files) {
    if (file.size > limits.maxFileBytes) return 'import_file_too_large';
    total += file.size;
    if (!Number.isSafeInteger(total) || total > limits.maxTotalDecodedBytes) {
      return 'import_total_size_exceeded';
    }
  }
  return null;
}

export interface EncodePickedFilesOptions {
  encode?: (file: File, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

export async function encodePickedFilesSequentially(
  files: readonly PickedImportFile[],
  options: EncodePickedFilesOptions = {},
): Promise<UploadFileBody[]> {
  const encode = options.encode ?? encodeFileBase64;
  const encoded: UploadFileBody[] = [];
  for (const picked of files) {
    throwIfAborted(options.signal);
    const dataBase64 = await encode(picked.file, options.signal);
    throwIfAborted(options.signal);
    encoded.push({
      id: picked.id,
      name: picked.name,
      dataBase64,
    });
  }
  return encoded;
}

export function inventoryMatchesSelection(
  files: readonly PickedImportFile[],
  inventory: readonly ImportInventoryItem[],
): boolean {
  return (
    files.length === inventory.length &&
    files.every((file, index) => {
      const item = inventory[index];
      return item?.id === file.id && item.name === file.name && item.sizeBytes === file.size;
    })
  );
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function abortError(): DOMException {
  return new DOMException('Import operation cancelled', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function encodeFileBase64(file: File, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const finish = (value?: string, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve(value ?? '');
    };
    const onAbort = () => {
      if (reader.readyState === FileReader.LOADING) reader.abort();
      finish(undefined, abortError());
    };
    if (signal?.aborted) {
      finish(undefined, abortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== 'string') {
        finish(undefined, new Error('file_read_failed'));
        return;
      }
      finish(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => finish(undefined, new Error('file_read_failed'));
    reader.onabort = () => finish(undefined, abortError());
    reader.readAsDataURL(file);
  });
}
