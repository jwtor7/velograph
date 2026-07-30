// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_IMPORT_UPLOAD_LIMITS } from '@velograph/shared/import-limits';
import { api, type FolderPreviewBody, type ImportInventoryItem } from '../api.ts';
import { MemoryRouter } from '../router.tsx';
import { ImportPage, MAX_DROPPED_DIRECTORY_DEPTH, MAX_DROPPED_ENTRY_COUNT } from './Import.tsx';

const FALLBACK_NOTICE =
  'This browser does not expose one verified absolute folder path. Velograph added the bounded loose files it could read; paste the path below for a large export.';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function syntheticFile(name: string, runtimePath?: string): File {
  const file = new File(['invented synthetic content'], name, { type: 'text/plain' });
  if (runtimePath !== undefined) {
    Object.defineProperty(file, 'path', { value: runtimePath });
  }
  return file;
}

function fileEntry(file: File, onRead: () => void = () => undefined): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath: `/virtual/${file.name}`,
    file: (successCallback: FileCallback) => {
      onRead();
      successCallback(file);
    },
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(
  name: string,
  entries: readonly FileSystemEntry[],
  batchSize = entries.length || 1,
  onOpen: () => void = () => undefined,
): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () => {
      onOpen();
      let offset = 0;
      return {
        readEntries: (successCallback: FileSystemEntriesCallback) => {
          const batch = entries.slice(offset, offset + batchSize);
          offset += batch.length;
          successCallback([...batch]);
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

function directoryWithFiles(name: string, files: readonly File[]): FileSystemDirectoryEntry {
  return directoryEntry(
    name,
    files.map((file) => fileEntry(file)),
  );
}

function directoryDataTransfer(...entries: FileSystemEntry[]): DataTransfer {
  return {
    files: [] as unknown as FileList,
    items: entries.map((entry) => ({
      kind: 'file',
      type: '',
      getAsFile: () => null,
      getAsString: () => undefined,
      webkitGetAsEntry: () => entry,
    })) as unknown as DataTransferItemList,
  } as DataTransfer;
}

function renderImportPage() {
  return render(
    <MemoryRouter>
      <ImportPage />
    </MemoryRouter>,
  );
}

function completePreview(): FolderPreviewBody {
  return {
    rides: [
      {
        rideKey: 'invented-ride',
        workoutType: 'outdoor_cycling',
        stampHint: 'invented-date',
        files: [
          {
            relativePath: 'invented-heart-rate.csv',
            name: 'invented-heart-rate.csv',
            sizeBytes: 26,
            label: 'Heart rate',
            format: 'csv',
          },
          {
            relativePath: 'invented-route.gpx',
            name: 'invented-route.gpx',
            sizeBytes: 26,
            label: 'Route',
            format: 'gpx',
          },
        ],
      },
    ],
    ungrouped: [],
    skipped: [],
    visitedEntries: 2,
    visitedDirectories: 1,
    totalFiles: 2,
    totalBytes: 52,
    truncated: false,
    confirmationToken: 'invented-confirmation-token',
    preflightComplete: true,
    preflight: [],
  };
}

function recognizedInventory(files: readonly File[]): ImportInventoryItem[] {
  return files.map((file, index) => ({
    id: `upload-${index + 1}`,
    name: file.name,
    sizeBytes: file.size,
    classification: 'recognized',
    detectedType: 'invented_metric',
    outcomes: [
      {
        classification: 'recognized',
        code: null,
        detectedType: 'invented_metric',
        count: 1,
      },
    ],
  }));
}

describe('Import folder drop integration', () => {
  it('previews one verified runtime folder path without creating a loose-file upload', async () => {
    const files = [
      syntheticFile('invented-heart-rate.csv', '/synthetic/Health Export/invented-heart-rate.csv'),
      syntheticFile('invented-route.gpx', '/synthetic/Health Export/invented-route.gpx'),
    ];
    const pathPreview = vi
      .spyOn(api, 'importPathPreview')
      .mockResolvedValue({ preview: completePreview() });
    const looseFileReview = vi.spyOn(api, 'importInventory');
    renderImportPage();

    fireEvent.drop(screen.getByRole('group', { name: 'File import drop area' }), {
      dataTransfer: directoryDataTransfer(directoryWithFiles('Health Export', files)),
    });

    await waitFor(() => {
      expect(pathPreview).toHaveBeenCalledWith('/synthetic/Health Export', expect.any(AbortSignal));
    });
    expect(
      (screen.getByPlaceholderText('/path/to/Health Auto Export') as HTMLInputElement).value,
    ).toBe('/synthetic/Health Export');
    expect(screen.getByRole('status').textContent).toContain(
      'Folder path detected by this local desktop runtime',
    );
    const confirmImport = (await screen.findByRole('button', {
      name: 'Confirm import (2 files)',
    })) as HTMLButtonElement;
    expect(confirmImport.disabled).toBe(false);
    expect(screen.queryByRole('heading', { name: /Selected files/ })).toBeNull();
    expect(looseFileReview).not.toHaveBeenCalled();
  });

  it('summarizes normal folder-preview skips without listing their filenames as warnings', async () => {
    const unmodelledName = 'Outdoor Cycling-Respiratory Rate-20400101_070000.csv';
    const nonCyclingName = 'Running-Heart Rate-20400102_070000.csv';
    const files = [
      syntheticFile(unmodelledName, `/synthetic/Health Export/${unmodelledName}`),
      syntheticFile(nonCyclingName, `/synthetic/Health Export/${nonCyclingName}`),
    ];
    const basePreview = completePreview();
    const preview: FolderPreviewBody = {
      ...basePreview,
      rides: [
        {
          ...basePreview.rides[0]!,
          files: [
            ...basePreview.rides[0]!.files,
            {
              relativePath: unmodelledName,
              name: unmodelledName,
              sizeBytes: files[0]!.size,
              label: 'Respiratory Rate',
              format: 'csv',
            },
          ],
        },
      ],
      ungrouped: [
        {
          relativePath: nonCyclingName,
          name: nonCyclingName,
          sizeBytes: files[1]!.size,
          classification: 'unrecognized_filename',
        },
      ],
      totalFiles: 4,
      totalBytes: 52 + files[0]!.size + files[1]!.size,
      preflight: [
        {
          name: unmodelledName,
          relativePath: unmodelledName,
          sizeBytes: files[0]!.size,
          classification: 'unmodelled_metric',
          detectedType: 'skip:unmodelled_metric',
          outcomes: [
            {
              classification: 'unmodelled_metric',
              code: 'unmodelled_metric',
              detectedType: 'skip:unmodelled_metric',
              count: 1,
            },
          ],
        },
        {
          name: nonCyclingName,
          relativePath: nonCyclingName,
          sizeBytes: files[1]!.size,
          classification: 'non_cycling_workout',
          detectedType: 'skip:non_cycling_workout',
          outcomes: [
            {
              classification: 'non_cycling_workout',
              code: 'non_cycling_workout',
              detectedType: 'skip:non_cycling_workout',
              count: 1,
            },
          ],
        },
      ],
    };
    vi.spyOn(api, 'importPathPreview').mockResolvedValue({ preview });
    renderImportPage();

    fireEvent.drop(screen.getByRole('group', { name: 'File import drop area' }), {
      dataTransfer: directoryDataTransfer(directoryWithFiles('Health Export', files)),
    });

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .some((status) => status.textContent?.includes('Normal skips')),
      ).toBe(true),
    );
    const summary = screen
      .getAllByRole('status')
      .find((status) => status.textContent?.includes('Normal skips'));
    expect(summary?.textContent).toContain('1 metric not modelled');
    expect(summary?.textContent).toContain('1 non-cycling workout file');
    expect(summary?.textContent).toContain('will not be quarantined');
    expect(screen.queryByText(unmodelledName)).toBeNull();
    expect(screen.queryByText(nonCyclingName)).toBeNull();
    expect(screen.getByText('Heart rate (csv)')).toBeTruthy();
    expect(screen.getByText('Route (gpx)')).toBeTruthy();
    expect(screen.queryByText(/Not part of a recognized ride/)).toBeNull();
  });

  it.each([
    {
      caseName: 'runtime paths are missing',
      paths: [undefined, undefined],
    },
    {
      caseName: 'runtime paths resolve to inconsistent roots',
      paths: ['/synthetic/first/invented-heart-rate.csv', '/synthetic/second/invented-route.gpx'],
    },
  ])('falls back to bounded loose files with an explanation when $caseName', async ({ paths }) => {
    const files = [
      syntheticFile('invented-heart-rate.csv', paths[0]),
      syntheticFile('invented-route.gpx', paths[1]),
    ];
    const pathPreview = vi.spyOn(api, 'importPathPreview');
    const looseFileReview = vi
      .spyOn(api, 'importInventory')
      .mockResolvedValue({ inventory: recognizedInventory(files) });
    renderImportPage();

    fireEvent.drop(screen.getByRole('group', { name: 'File import drop area' }), {
      dataTransfer: directoryDataTransfer(directoryWithFiles('Health Export', files)),
    });

    expect((await screen.findByRole('status')).textContent).toContain(FALLBACK_NOTICE);
    expect(await screen.findByRole('heading', { name: 'Selected files (2)' })).toBeTruthy();
    expect(screen.getByText('invented-heart-rate.csv')).toBeTruthy();
    expect(screen.getByText('invented-route.gpx')).toBeTruthy();
    expect(
      (screen.getByPlaceholderText('/path/to/Health Auto Export') as HTMLInputElement).value,
    ).toBe('');
    expect(pathPreview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Review files' }));
    await waitFor(() => expect(looseFileReview).toHaveBeenCalledOnce());
    expect(looseFileReview.mock.calls[0]?.[0]).toEqual([
      {
        id: 'upload-1',
        name: 'invented-heart-rate.csv',
        dataBase64: expect.any(String),
      },
      {
        id: 'upload-2',
        name: 'invented-route.gpx',
        dataBase64: expect.any(String),
      },
    ]);
  });

  it('stops at the shared file-count bound across dropped directory roots', async () => {
    let readCount = 0;
    const entries = Array.from({ length: DEFAULT_IMPORT_UPLOAD_LIMITS.maxFiles + 1 }, (_, index) =>
      fileEntry(syntheticFile(`invented-${index}.csv`), () => {
        readCount += 1;
      }),
    );
    const split = Math.floor(entries.length / 2);
    renderImportPage();

    fireEvent.drop(screen.getByRole('group', { name: 'File import drop area' }), {
      dataTransfer: directoryDataTransfer(
        directoryEntry('First export', entries.slice(0, split)),
        directoryEntry('Second export', entries.slice(split)),
      ),
    });

    expect(
      await screen.findByText(
        'Too many files for browser upload. Use folder path import for a large export.',
      ),
    ).toBeTruthy();
    expect(readCount).toBe(DEFAULT_IMPORT_UPLOAD_LIMITS.maxFiles);
    expect(screen.queryByRole('heading', { name: /Selected files/ })).toBeNull();
  });

  it('stops before reading a file below the safe directory-depth bound', async () => {
    let readCount = 0;
    let nestedEntry: FileSystemEntry = fileEntry(syntheticFile('too-deep.csv'), () => {
      readCount += 1;
    });
    for (let depth = 0; depth < MAX_DROPPED_DIRECTORY_DEPTH + 2; depth += 1) {
      nestedEntry = directoryEntry(`level-${depth}`, [nestedEntry]);
    }
    renderImportPage();

    fireEvent.drop(screen.getByRole('group', { name: 'File import drop area' }), {
      dataTransfer: directoryDataTransfer(nestedEntry),
    });

    expect(
      await screen.findByText(
        'This folder exceeds the safe browser traversal limit. Use folder path import instead.',
      ),
    ).toBeTruthy();
    expect(readCount).toBe(0);
    expect(screen.queryByRole('heading', { name: /Selected files/ })).toBeNull();
  });

  it('stops before opening an empty directory beyond the shared entry budget', async () => {
    let openedDirectories = 0;
    const emptyDirectories = Array.from({ length: MAX_DROPPED_ENTRY_COUNT }, (_, index) =>
      directoryEntry(`empty-${index}`, [], 1, () => {
        openedDirectories += 1;
      }),
    );
    renderImportPage();

    fireEvent.drop(screen.getByRole('group', { name: 'File import drop area' }), {
      dataTransfer: directoryDataTransfer(directoryEntry('Health Export', emptyDirectories)),
    });

    expect(
      await screen.findByText(
        'This folder exceeds the safe browser traversal limit. Use folder path import instead.',
      ),
    ).toBeTruthy();
    expect(openedDirectories).toBe(MAX_DROPPED_ENTRY_COUNT - 1);
    expect(screen.queryByRole('heading', { name: /Selected files/ })).toBeNull();
  });

  it('reads normal nested directory batches sequentially', async () => {
    let activeReads = 0;
    let peakActiveReads = 0;
    const deferredEntry = (file: File): FileSystemFileEntry =>
      ({
        ...fileEntry(file),
        file: (successCallback: FileCallback) => {
          activeReads += 1;
          peakActiveReads = Math.max(peakActiveReads, activeReads);
          queueMicrotask(() => {
            activeReads -= 1;
            successCallback(file);
          });
        },
      }) as FileSystemFileEntry;
    const files = [syntheticFile('nested-a.csv'), syntheticFile('nested-b.gpx')];
    const nested = directoryEntry('nested', files.map(deferredEntry), 1);
    renderImportPage();

    fireEvent.drop(screen.getByRole('group', { name: 'File import drop area' }), {
      dataTransfer: directoryDataTransfer(directoryEntry('Health Export', [nested])),
    });

    expect(await screen.findByRole('heading', { name: 'Selected files (2)' })).toBeTruthy();
    expect(screen.getByText('nested-a.csv')).toBeTruthy();
    expect(screen.getByText('nested-b.gpx')).toBeTruthy();
    expect(peakActiveReads).toBe(1);
  });
});
