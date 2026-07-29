// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
