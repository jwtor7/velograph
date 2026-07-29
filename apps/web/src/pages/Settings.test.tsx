// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type Settings } from '../api.ts';
import { SettingsPage } from './Settings.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings save feedback', () => {
  it('announces both successful and failed saves through the live status region', async () => {
    const settings: Settings = {
      timeZone: 'America/Toronto',
      hrZoneBounds: null,
      movingSpeedThresholdMs: 1,
      minCoverageForEfficiency: 0.7,
      elevationHysteresisM: 1,
    };
    vi.spyOn(api, 'settings').mockResolvedValue({ settings });
    vi.spyOn(api, 'saveSettings')
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

    fireEvent.click(saveButton);
    const saved = await screen.findByText('Saved');
    expect(saved.getAttribute('role')).toBe('status');

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
      }),
    );
    expect(await screen.findByText('Saved')).toBeTruthy();
  });
});
