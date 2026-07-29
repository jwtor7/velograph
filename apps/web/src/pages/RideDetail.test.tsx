// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, type RideAnalytics, type WorkoutDetail, type WorkoutSummary } from '../api.ts';
import { buildLineSpec, fmtDate } from '../chartspec/spec.ts';
import { RideDetail } from './RideDetail.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function analytics(workoutId: number, durationS: number, distanceM: number): RideAnalytics {
  return {
    formulaVersion: 'analytics-v2',
    workoutId,
    durationS,
    movingTimeS: durationS,
    distanceM,
    avgSpeedMs: distanceM / durationS,
    maxSpeedMs: 8,
    heartRate: { avg: 125, min: 110, max: 140, coverage: 1 },
    cadence: { avg: 80, min: 70, max: 90, coverage: 1 },
    energyKj: 500,
    elevation: { gainM: 50, lossM: 45, minM: 20, maxM: 70 },
    zones: null,
    efficiency: 0.16,
    decouplingPct: 2,
    pacingVariability: 0.1,
    splits: [],
    unavailable: {},
  };
}

function detail(
  workoutId: number,
  startUtc: number,
  endUtc: number,
  distanceM: number,
  coordinateOffset: number,
): WorkoutDetail {
  const durationS = (endUtc - startUtc) / 1000;
  return {
    workout: { id: workoutId, type: 'outdoor_cycling', startUtc, endUtc },
    metrics: {
      heart_rate: [
        { t: startUtc + 60_000, value: 110 + coordinateOffset },
        { t: endUtc - 60_000, value: 140 + coordinateOffset },
      ],
      cadence: [
        { t: startUtc + 60_000, value: 72 },
        { t: endUtc - 60_000, value: 88 },
      ],
      distance: [
        { t: startUtc + 60_000, value: distanceM / 2 },
        { t: endUtc - 60_000, value: distanceM / 2 },
      ],
    },
    route: [
      {
        points: [
          {
            t: startUtc + 60_000,
            lat: -48.5 + coordinateOffset * 0.01,
            lon: -123.5,
            ele: 20,
          },
          {
            t: endUtc - 60_000,
            lat: -48.49 + coordinateOffset * 0.01,
            lon: -123.48,
            ele: 70,
          },
        ],
      },
    ],
    analytics: analytics(workoutId, durationS, distanceM),
  };
}

function summary(id: number, startUtc: number, endUtc: number, distanceM = 8_000): WorkoutSummary {
  return {
    id,
    type: 'outdoor_cycling',
    startUtc,
    endUtc,
    durationS: (endUtc - startUtc) / 1000,
    qualityState: 'ok',
    distanceM,
    avgSpeedMs: 5,
    avgHr: 120,
    elevationGainM: 40,
    hasRoute: true,
  };
}

describe('RideDetail repair state', () => {
  it('installs canonical bounds, comparison, charts, and route while clearing the cursor', async () => {
    const initialStart = Date.UTC(2033, 4, 1, 10);
    const initialEnd = initialStart + 20 * 60_000;
    const repairedStart = Date.UTC(2033, 4, 3, 14);
    const repairedEnd = repairedStart + 30 * 60_000;
    const initialDetail = detail(8, initialStart, initialEnd, 6_000, 0);
    const repairedDetail = detail(8, repairedStart, repairedEnd, 12_000, 1);
    const initialPrevious = summary(7, Date.UTC(2033, 3, 29, 9), Date.UTC(2033, 3, 29, 9, 30));
    const repairedPrevious = summary(6, Date.UTC(2033, 4, 2, 12), Date.UTC(2033, 4, 2, 12, 30));

    vi.spyOn(api, 'workout')
      .mockResolvedValueOnce(initialDetail)
      .mockResolvedValueOnce(repairedDetail);
    vi.spyOn(api, 'workouts')
      .mockResolvedValueOnce({
        workouts: [initialPrevious, summary(8, initialStart, initialEnd)],
      })
      .mockResolvedValueOnce({
        workouts: [
          repairedPrevious,
          summary(8, repairedStart, repairedEnd, 12_000),
          summary(9, repairedEnd + 60_000, repairedEnd + 31 * 60_000),
        ],
      });
    vi.spyOn(api, 'settings').mockResolvedValue({
      settings: {
        timeZone: 'Etc/UTC',
        hrZoneBounds: null,
        movingSpeedThresholdMs: 1,
        minCoverageForEfficiency: 0.7,
        elevationHysteresisM: 1,
      },
    });
    vi.spyOn(api, 'repairWorkout').mockResolvedValue({
      repaired: true,
      analytics: repairedDetail.analytics!,
    });

    render(
      <MemoryRouter initialEntries={['/rides/8']}>
        <Routes>
          <Route path="/rides/:id" element={<RideDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', {
      level: 1,
      name: `Ride · ${fmtDate(initialStart, 'Etc/UTC')}`,
    });
    await screen.findByText(`Compared with ${fmtDate(initialPrevious.startUtc, 'Etc/UTC')}`);

    const initialChart = screen.getByRole('img', { name: 'Heart Rate chart' });
    Object.defineProperty(initialChart, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: 0,
          top: 0,
          right: 560,
          bottom: 90,
          width: 560,
          height: 90,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) satisfies DOMRect,
    });
    fireEvent.mouseMove(initialChart, { clientX: 280 });

    expect(initialChart.querySelector('line[stroke-dasharray="3 3"]')).not.toBeNull();
    const initialRoute = screen.getByRole('img', {
      name: 'offline route map with direction, distance, and scale markers',
    });
    expect(initialRoute.querySelector('circle[fill="none"]')).not.toBeNull();
    const initialRoutePath = initialRoute.querySelector('path[stroke^="url"]')?.getAttribute('d');
    expect(initialRoutePath).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Repair ride' }));

    await screen.findByText('Repaired: canonical ride details and analytics were reloaded.');
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: `Ride · ${fmtDate(repairedStart, 'Etc/UTC')}`,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', {
        level: 1,
        name: `Ride · ${fmtDate(initialStart, 'Etc/UTC')}`,
      }),
    ).toBeNull();
    expect(
      screen.getByText(`Compared with ${fmtDate(repairedPrevious.startUtc, 'Etc/UTC')}`),
    ).toBeTruthy();
    expect(
      screen.getByText('Distance', { selector: '.kpi-label span' }).closest('.kpi')?.textContent,
    ).toContain('12.0km');

    const repairedChart = screen.getByRole('img', { name: 'Heart Rate chart' });
    const expectedChart = buildLineSpec(
      repairedDetail.metrics.heart_rate!.map((sample) => ({
        t: sample.t,
        v: sample.value,
      })),
      560,
      90,
      { tMin: repairedStart, tMax: repairedEnd },
    );
    expect(repairedChart.querySelectorAll('path')[1]?.getAttribute('d')).toBe(expectedChart!.path);
    expect(repairedChart.querySelector('line[stroke-dasharray="3 3"]')).toBeNull();

    const repairedRoute = screen.getByRole('img', {
      name: 'offline route map with direction, distance, and scale markers',
    });
    expect(repairedRoute.querySelector('path[stroke^="url"]')?.getAttribute('d')).not.toBe(
      initialRoutePath,
    );
    expect(repairedRoute.querySelector('circle[fill="none"]')).toBeNull();
  });
});
