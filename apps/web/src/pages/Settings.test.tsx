// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, api, type Settings } from '../api.ts';
import { SettingsPage } from './Settings.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings save feedback', () => {
  it('announces both successful and failed saves through the live status region', async () => {
    const settings: Settings = {
      timeZone: 'America/Toronto',
      displayUnits: 'metric',
      hrZoneBounds: null,
      movingSpeedThresholdMs: 1,
      minCoverageForEfficiency: 0.7,
      elevationHysteresisM: 1,
    };
    vi.spyOn(api, 'settings').mockResolvedValue({ settings });
    const saveSettings = vi
      .spyOn(api, 'saveSettings')
      .mockResolvedValueOnce({ settings })
      .mockRejectedValueOnce(new Error('synthetic failure'));
    vi.spyOn(api, 'backup').mockResolvedValue({
      ok: true,
      totalPages: 1,
      manifest: {
        formatVersion: 1,
        appVersion: '0.1.0',
        schemaVersion: '0004_backup_manifest.sql',
        includedCategories: {
          analytics: true,
          credentials: false,
          normalizedData: true,
          notesAndTags: false,
          rawSourceFiles: false,
          settings: true,
          sourceMetadata: true,
        },
      },
    });

    render(<SettingsPage />);

    await screen.findByRole('textbox', { name: 'IANA timezone' });
    const saveButton = screen.getByRole('button', { name: 'Save settings' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Display units' }), {
      target: { value: 'imperial' },
    });
    fireEvent.click(saveButton);
    const saved = await screen.findByText('Saved');
    expect(saved.getAttribute('role')).toBe('status');
    expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({ displayUnits: 'imperial' });

    fireEvent.click(saveButton);
    const failed = await screen.findByText(
      'Settings were not saved. Check the timezone and zone boundaries.',
    );
    expect(failed.getAttribute('role')).toBe('status');
    expect(screen.queryByText('Saved')).toBeNull();

    const backupPath = screen.getByRole('textbox', { name: 'Back up to path' });
    expect(screen.getByRole('textbox', { name: 'Restore from path' })).toBeTruthy();
    fireEvent.change(backupPath, { target: { value: '/tmp/synthetic-velograph-backup.sqlite3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    const backupStatus = await screen.findByText(
      'Backup written · format 1 · 0004_backup_manifest.sql',
    );
    expect(backupStatus.getAttribute('role')).toBe('status');
  });

  it.each([
    ['partial', 'Z3/Z4', '', 'Enter all five boundaries'],
    ['duplicate', 'Z3/Z4', '110', 'increase strictly'],
    ['out of order', 'Z3/Z4', '100', 'increase strictly'],
    ['out of range', 'Z1/Z2', '39', 'whole number from 40 to 230'],
  ])(
    'keeps configured zones unchanged when a %s draft is invalid',
    async (_caseName, label, value, expectedError) => {
      const settings: Settings = {
        timeZone: 'America/Toronto',
        displayUnits: 'metric',
        hrZoneBounds: [90, 110, 130, 150, 170],
        movingSpeedThresholdMs: 1,
        minCoverageForEfficiency: 0.7,
        elevationHysteresisM: 1,
      };
      vi.spyOn(api, 'settings').mockResolvedValue({ settings });
      const saveSettings = vi.spyOn(api, 'saveSettings');

      render(<SettingsPage />);

      const input = await screen.findByRole('spinbutton', { name: label });
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

      expect(saveSettings).not.toHaveBeenCalled();
      expect(screen.getByText(new RegExp(expectedError, 'i'))).toBeTruthy();
      expect(screen.queryByText('Saved')).toBeNull();
    },
  );

  it('submits null only when all five configured zone fields are explicitly blanked', async () => {
    const configured: Settings = {
      timeZone: 'America/Toronto',
      displayUnits: 'metric',
      hrZoneBounds: [90, 110, 130, 150, 170],
      movingSpeedThresholdMs: 1,
      minCoverageForEfficiency: 0.7,
      elevationHysteresisM: 1,
    };
    const disabled: Settings = { ...configured, hrZoneBounds: null };
    vi.spyOn(api, 'settings').mockResolvedValue({ settings: configured });
    const saveSettings = vi.spyOn(api, 'saveSettings').mockResolvedValue({ settings: disabled });

    render(<SettingsPage />);

    await screen.findByRole('spinbutton', { name: 'Z1/Z2' });
    for (const input of screen.getAllByRole('spinbutton')) {
      fireEvent.change(input, { target: { value: '' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        hrZoneBounds: null,
        timeZone: 'America/Toronto',
        displayUnits: 'metric',
      }),
    );
    expect(await screen.findByText('Saved')).toBeTruthy();
  });
});

describe('Settings delete-all confirmation', () => {
  it('requires the dialog, keeps focus safe, and refreshes reset settings after deletion', async () => {
    const configured: Settings = {
      timeZone: 'Pacific/Honolulu',
      displayUnits: 'metric',
      hrZoneBounds: [90, 110, 130, 150, 170],
      movingSpeedThresholdMs: 2,
      minCoverageForEfficiency: 0.8,
      elevationHysteresisM: 2,
    };
    const defaults: Settings = {
      timeZone: 'Etc/UTC',
      displayUnits: 'metric',
      hrZoneBounds: null,
      movingSpeedThresholdMs: 1,
      minCoverageForEfficiency: 0.7,
      elevationHysteresisM: 1,
    };
    vi.spyOn(api, 'settings')
      .mockResolvedValueOnce({ settings: configured })
      .mockResolvedValueOnce({ settings: defaults });
    const deleteAll = vi.spyOn(api, 'deleteAllData').mockResolvedValue({ deleted: true });

    render(<SettingsPage />);

    const trigger = await screen.findByRole('button', { name: 'Delete all local data' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('alertdialog', { name: 'Delete all local data?' });
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteAll).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));

    await waitFor(() => expect(deleteAll).toHaveBeenCalledTimes(1));
    const status = await screen.findByText(
      'All local database data was deleted. Existing backup files were not changed.',
    );
    expect(status.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alertdialog', { name: 'Delete all local data?' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByRole('textbox', { name: 'IANA timezone' })).toHaveProperty(
      'value',
      'Etc/UTC',
    );
    expect(
      screen.getAllByRole('spinbutton').every((input) => (input as HTMLInputElement).value === ''),
    ).toBe(true);
  });

  it('reports an unconfirmed outcome for a transport failure without claiming rollback', async () => {
    const settings: Settings = {
      timeZone: 'Etc/UTC',
      displayUnits: 'metric',
      hrZoneBounds: null,
      movingSpeedThresholdMs: 1,
      minCoverageForEfficiency: 0.7,
      elevationHysteresisM: 1,
    };
    vi.spyOn(api, 'settings').mockResolvedValue({ settings });
    vi.spyOn(api, 'deleteAllData').mockRejectedValue(new Error('synthetic private failure'));

    render(<SettingsPage />);

    const trigger = await screen.findByRole('button', { name: 'Delete all local data' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));

    const failure = await screen.findByText(
      'Delete-all outcome could not be confirmed. Reload before making further changes.',
    );
    expect(failure.getAttribute('role')).toBe('status');
    expect(failure.textContent).not.toContain('synthetic private failure');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('reports the server-confirmed transactional rollback without exposing diagnostics', async () => {
    const settings: Settings = {
      timeZone: 'Etc/UTC',
      displayUnits: 'metric',
      hrZoneBounds: null,
      movingSpeedThresholdMs: 1,
      minCoverageForEfficiency: 0.7,
      elevationHysteresisM: 1,
    };
    vi.spyOn(api, 'settings').mockResolvedValue({ settings });
    vi.spyOn(api, 'deleteAllData').mockRejectedValue(new ApiError(500, 'delete_all_failed'));

    render(<SettingsPage />);

    const trigger = await screen.findByRole('button', { name: 'Delete all local data' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));

    const failure = await screen.findByText(
      'Delete-all failed. The transaction was rolled back and the database was left unchanged.',
    );
    expect(failure.getAttribute('role')).toBe('status');
  });
});
