import { describe, expect, it } from 'vitest';
import type { ImportUploadLimits } from '@velograph/shared/import-limits';
import {
  createPickedFiles,
  encodePickedFilesSequentially,
  inventoryItemNeedsAttention,
  inventoryMatchesSelection,
  isNormalImportSkipItem,
  summarizeNormalImportSkips,
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

  it('preserves unsupported selections so server inventory can report them explicitly', () => {
    const unsupported = fakeFile('invented-notes.txt', 4);
    const created = createPickedFiles([unsupported], 9);

    expect(created.files).toEqual([
      {
        id: 'upload-9',
        name: 'invented-notes.txt',
        size: 4,
        file: unsupported,
      },
    ]);
    expect(created.nextId).toBe(10);
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

  it('summarizes normal skips without treating them as warnings', () => {
    const items = [
      {
        classification: 'unmodelled_metric' as const,
        outcomes: [
          {
            classification: 'unmodelled_metric' as const,
            code: 'unmodelled_metric',
            detectedType: 'skip:unmodelled_metric',
            count: 3,
          },
        ],
      },
      {
        classification: 'mixed' as const,
        outcomes: [
          {
            classification: 'recognized' as const,
            code: null,
            detectedType: 'metric:heart_rate',
            count: 1,
          },
          {
            classification: 'non_cycling_workout' as const,
            code: 'non_cycling_workout',
            detectedType: 'skip:non_cycling_workout',
            count: 2,
          },
        ],
      },
    ];

    expect(summarizeNormalImportSkips(items)).toEqual({
      total: 5,
      unmodelledMetric: 3,
      nonCyclingWorkout: 2,
    });
    expect(isNormalImportSkipItem(items[0]!)).toBe(true);
    expect(isNormalImportSkipItem(items[1]!)).toBe(false);
    expect(inventoryItemNeedsAttention(items[0]!)).toBe(false);
    expect(inventoryItemNeedsAttention(items[1]!)).toBe(false);
    expect(
      inventoryItemNeedsAttention({
        classification: 'invalid',
        outcomes: [
          {
            classification: 'invalid',
            code: 'malformed_csv',
            detectedType: null,
            count: 1,
          },
        ],
      }),
    ).toBe(true);
  });
});
