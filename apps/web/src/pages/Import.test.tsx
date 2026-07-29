// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type ImportInventoryItem } from '../api.ts';
import { MemoryRouter } from '../router.tsx';
import { ImportPage } from './Import.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Import file chooser accessibility', () => {
  it('keeps the drop surface non-interactive and uses a native Space/Enter button', () => {
    const view = render(
      <MemoryRouter>
        <ImportPage />
      </MemoryRouter>,
    );

    const dropSurface = screen.getByRole('group', { name: 'File import drop area' });
    expect(dropSurface.tagName).toBe('DIV');
    expect(dropSurface.tabIndex).toBe(-1);
    expect(dropSurface.matches('button, [role="button"]')).toBe(false);

    const chooser = screen.getByRole('button', { name: 'Choose files' });
    expect(chooser.tagName).toBe('BUTTON');
    expect(chooser.closest('[role="button"]')).toBeNull();

    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    chooser.focus();
    // Native <button> semantics provide keyboard Enter/Space activation; the
    // click verifies the explicit control owns the chooser action.
    fireEvent.click(chooser);
    expect(document.activeElement).toBe(chooser);
    expect(click).toHaveBeenCalledOnce();
  });

  it('shows unsupported files explicitly and aggregates normal skips without warning badges', async () => {
    const files = [
      new File(['invented supported'], 'Outdoor Cycling-Heart Rate-20330405_070000.csv'),
      new File(['invented unsupported'], 'invented-notes.txt'),
      new File(['invented unmodelled'], 'Outdoor Cycling-Respiratory Rate-20330405_070000.csv'),
      new File(['invented non-cycling'], 'Running-Route-20330405_070000.gpx'),
    ];
    const classifications = [
      'recognized',
      'unsupported',
      'unmodelled_metric',
      'non_cycling_workout',
    ] as const;
    const review = vi.spyOn(api, 'importInventory').mockImplementation(async (uploads) => ({
      inventory: uploads.map((upload, index): ImportInventoryItem => ({
        id: upload.id,
        name: upload.name,
        sizeBytes: files[index]!.size,
        classification: classifications[index]!,
        detectedType: null,
        outcomes: [
          {
            classification: classifications[index]!,
            code:
              classifications[index] === 'recognized'
                ? null
                : classifications[index] === 'unsupported'
                  ? 'unsupported_file_type'
                  : classifications[index]!,
            detectedType: null,
            count: 1,
          },
        ],
      })),
    }));

    render(
      <MemoryRouter>
        <ImportPage />
      </MemoryRouter>,
    );
    fireEvent.drop(screen.getByRole('group', { name: 'File import drop area' }), {
      dataTransfer: { files, items: [] },
    });

    expect(screen.getByText('invented-notes.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review files' }));

    await waitFor(() => expect(review).toHaveBeenCalledOnce());
    expect(review.mock.calls[0]![0].map((file) => file.name)).toEqual(
      files.map((file) => file.name),
    );
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
    expect(screen.queryByText(files[2]!.name)).toBeNull();
    expect(screen.queryByText(files[3]!.name)).toBeNull();
    expect(screen.getByText('invented-notes.txt')).toBeTruthy();
    expect(screen.getByText('unsupported').className).toContain('warn');
  });
});
