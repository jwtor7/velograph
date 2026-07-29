// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api, type FolderPreviewBody, type ImportInventoryItem } from '../api.ts';
import { ImportPage } from './Import.tsx';

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

function fileEntry(file: File): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath: `/virtual/${file.name}`,
    file: (successCallback: FileCallback) => successCallback(file),
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(name: string, files: readonly File[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () => {
      let exhausted = false;
      return {
        readEntries: (successCallback: FileSystemEntriesCallback) => {
          const entries = exhausted ? [] : files.map(fileEntry);
          exhausted = true;
          successCallback(entries);
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

function directoryDataTransfer(entry: FileSystemDirectoryEntry): DataTransfer {
  return {
    files: [] as unknown as FileList,
    items: [
      {
        kind: 'file',
        type: '',
        getAsFile: () => null,
        getAsString: () => undefined,
        webkitGetAsEntry: () => entry,
      },
    ] as unknown as DataTransferItemList,
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
      dataTransfer: directoryDataTransfer(directoryEntry('Health Export', files)),
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
      dataTransfer: directoryDataTransfer(directoryEntry('Health Export', files)),
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
});
