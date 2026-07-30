// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api, type WorkoutSummary } from '../api.ts';
import { fmtDate } from '../chartspec/spec.ts';
import { MemoryRouter } from '../router.tsx';
import { Library } from './Library.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Library timezone labels', () => {
  it('uses the configured timezone consistently in visible and destructive-action copy', async () => {
    const timeZone = 'Pacific/Honolulu';
    const startUtc = Date.UTC(2033, 0, 2, 2, 30);
    const workout: WorkoutSummary = {
      id: 7,
      type: 'outdoor_cycling',
      startUtc,
      endUtc: startUtc + 3_600_000,
      durationS: 3_600,
      qualityState: 'ok',
      distanceM: 15_000,
      avgSpeedMs: 5,
      avgHr: 130,
      elevationGainM: 80,
      hasRoute: true,
    };
    const configuredDate = fmtDate(startUtc, timeZone);
    const utcDate = fmtDate(startUtc, 'UTC');
    expect(configuredDate).not.toBe(utcDate);

    vi.spyOn(api, 'workouts').mockResolvedValue({ workouts: [workout] });
    vi.spyOn(api, 'settings').mockResolvedValue({
      settings: {
        timeZone,
        displayUnits: 'metric',
        hrZoneBounds: null,
        movingSpeedThresholdMs: 1,
        minCoverageForEfficiency: 0.7,
        elevationHysteresisM: 1,
      },
    });

    render(
      <MemoryRouter>
        <Library />
      </MemoryRouter>,
    );

    const deleteButton = await screen.findByRole('button', {
      name: `Delete ride from ${configuredDate}`,
    });
    expect(screen.getByRole('region', { name: 'Ride library table' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Delete ride from ${utcDate}` })).toBeNull();

    fireEvent.click(deleteButton);

    const dialog = screen.getByRole('alertdialog', { name: 'Delete this ride?' });
    expect(dialog.textContent).toContain(configuredDate);
    expect(dialog.textContent).not.toContain(utcDate);
  });

  it('renders library measurements and filter labels in configured imperial units', async () => {
    const startUtc = Date.UTC(2033, 0, 2, 2, 30);
    vi.spyOn(api, 'workouts').mockResolvedValue({
      workouts: [
        {
          id: 8,
          type: 'outdoor_cycling',
          startUtc,
          endUtc: startUtc + 3_600_000,
          durationS: 3_600,
          qualityState: 'ok',
          distanceM: 15_000,
          avgSpeedMs: 5,
          avgHr: 130,
          elevationGainM: 80,
          hasRoute: true,
        },
      ],
    });
    vi.spyOn(api, 'settings').mockResolvedValue({
      settings: {
        timeZone: 'Etc/UTC',
        displayUnits: 'imperial',
        hrZoneBounds: null,
        movingSpeedThresholdMs: 1,
        minCoverageForEfficiency: 0.7,
        elevationHysteresisM: 1,
      },
    });

    render(
      <MemoryRouter>
        <Library />
      </MemoryRouter>,
    );

    const table = await screen.findByRole('region', { name: 'Ride library table' });
    expect(table.textContent).toContain('9.3 mi');
    expect(table.textContent).toContain('11.2 mph');
    expect(table.textContent).toContain('262 ft');
    expect(screen.getByText('Min distance (mi)')).toBeTruthy();
  });
});
