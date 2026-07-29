import { describe, expect, it } from 'vitest';
import type { ImportUploadLimits } from '@velograph/shared/import-limits';
import {
  createPickedFiles,
  encodePickedFilesSequentially,
  inventoryMatchesSelection,
  validateImportSelection,
  type PickedImportFile,
} from './import-files.ts';

function fakeFile(name: string, size: number): File {
  return { name, size } as File;
}

const tinyLimits: ImportUploadLimits = {
  maxFiles: 2,
  maxFileBytes: 5,
  maxTotalDecodedBytes: 8,
  maxBodyBytes: 64,
  maxNameLength: 255,
  maxIdLength: 64,
};

describe('browser import selection', () => {
  it('preserves distinct same-name and same-size files with unique identities', () => {
    const first = fakeFile('Outdoor Cycling-Route-20330101_070000.gpx', 4);
    const second = fakeFile('Outdoor Cycling-Route-20330101_070000.gpx', 4);
    const created = createPickedFiles([first, second], 7);

    expect(created.files).toHaveLength(2);
    expect(created.files.map((file) => file.id)).toEqual(['upload-7', 'upload-8']);
    expect(created.files[0]!.file).toBe(first);
    expect(created.files[1]!.file).toBe(second);
  });

  it('enforces count, per-file, and aggregate limits before encoding', () => {
    const picked = (sizes: number[]): PickedImportFile[] =>
      sizes.map((size, index) => ({
        id: `upload-${index}`,
        name: `synthetic-${index}.csv`,
        size,
        file: fakeFile(`synthetic-${index}.csv`, size),
      }));

    expect(validateImportSelection(picked([1, 1, 1]), tinyLimits)).toBe(
      'import_file_count_exceeded',
    );
    expect(validateImportSelection(picked([6]), tinyLimits)).toBe('import_file_too_large');
    expect(validateImportSelection(picked([5, 4]), tinyLimits)).toBe('import_total_size_exceeded');
    expect(validateImportSelection(picked([4, 4]), tinyLimits)).toBeNull();
  });

  it('encodes one file at a time in stable selection order', async () => {
    const selected = createPickedFiles(
      [fakeFile('synthetic-a.csv', 1), fakeFile('synthetic-b.csv', 1)],
      1,
    ).files;
    let active = 0;
    let maxActive = 0;

    const encoded = await encodePickedFilesSequentially(selected, {
      encode: async (file) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return `encoded-${file.name}`;
      },
    });

    expect(maxActive).toBe(1);
    expect(encoded.map((file) => file.id)).toEqual(['upload-1', 'upload-2']);
    expect(encoded.map((file) => file.dataBase64)).toEqual([
      'encoded-synthetic-a.csv',
      'encoded-synthetic-b.csv',
    ]);
  });

  it('rejects before encoding when cancellation was already requested', async () => {
    const selected = createPickedFiles([fakeFile('synthetic.csv', 1)], 1).files;
    const controller = new AbortController();
    controller.abort();
    let called = false;

    await expect(
      encodePickedFilesSequentially(selected, {
        signal: controller.signal,
        encode: async () => {
          called = true;
          return 'unused';
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(called).toBe(false);
  });

  it('stops before the next file when cancellation arrives during encoding', async () => {
    const selected = createPickedFiles(
      [fakeFile('synthetic-a.csv', 1), fakeFile('synthetic-b.csv', 1)],
      1,
    ).files;
    const controller = new AbortController();
    const called: string[] = [];

    await expect(
      encodePickedFilesSequentially(selected, {
        signal: controller.signal,
        encode: async (file) => {
          called.push(file.name);
          controller.abort();
          return `encoded-${file.name}`;
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(called).toEqual(['synthetic-a.csv']);
  });

  it('binds a review to the exact ordered selection', () => {
    const selected = createPickedFiles([fakeFile('synthetic.csv', 4)], 1).files;
    const inventory = [
      {
        id: 'upload-1',
        name: 'synthetic.csv',
        sizeBytes: 4,
        classification: 'unsupported' as const,
        detectedType: null,
        outcomes: [
          {
            classification: 'unsupported' as const,
            code: 'unsupported_file_type',
            detectedType: null,
            count: 1,
          },
        ],
      },
    ];
    expect(inventoryMatchesSelection(selected, inventory)).toBe(true);
    expect(inventoryMatchesSelection(selected, [{ ...inventory[0]!, sizeBytes: 5 }])).toBe(false);
    expect(inventoryMatchesSelection(selected, [{ ...inventory[0]!, id: 'upload-2' }])).toBe(false);
  });
});
