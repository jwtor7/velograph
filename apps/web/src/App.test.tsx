// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { api } from './api.ts';
import { App } from './App.tsx';
import { MemoryRouter } from './router.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App navigation', () => {
  it('keeps an explicit accessible name when compact navigation hides visible labels', async () => {
    vi.spyOn(api, 'workouts').mockResolvedValue({ workouts: [] });
    vi.spyOn(api, 'settings').mockResolvedValue({
      settings: {
        timeZone: 'Etc/UTC',
        hrZoneBounds: null,
        movingSpeedThresholdMs: 1,
        minCoverageForEfficiency: 0.7,
        elevationHysteresisM: 1,
      },
    });

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Rides' });
    for (const name of ['Rides', 'Trends', 'Import', 'Settings']) {
      expect(screen.getByRole('link', { name }).getAttribute('aria-label')).toBe(name);
    }
  });
});
