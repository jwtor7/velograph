// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api, type RideAnalytics, type WorkoutDetail, type WorkoutSummary } from '../api.ts';
import { buildLineSpec, fmtDate } from '../chartspec/spec.ts';
import * as rideExport from '../ride-export.ts';
import { MemoryRouter, Route, Routes } from '../router.tsx';
import { RideDetail } from './RideDetail.tsx';

vi.mock('../components/interactive-route-map.tsx', () => ({
  InteractiveRouteMap: ({
    segments,
    cursorT,
    displayUnits,
  }: {
    segments: WorkoutDetail['route'];
    cursorT: number | null;
    displayUnits: 'metric' | 'imperial';
  }) => (
    <svg
      role="img"
      aria-label="interactive offline route map"
      data-route={JSON.stringify(
        segments.map((segment) =>
          segment.points.map((point) => [point.t, point.lat, point.lon, point.ele]),
        ),
      )}
      data-cursor={cursorT ?? ''}
      data-units={displayUnits}
    />
  ),
}));

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
    const timeZone = 'Pacific/Honolulu';
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
        timeZone,
        displayUnits: 'metric',
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
      name: `Ride · ${fmtDate(initialStart, timeZone)}`,
    });
    await screen.findByText(
      new RegExp(`Compared with ${escapeRegex(fmtDate(initialPrevious.startUtc, timeZone))}`),
    );
    expect(screen.getByText(/source data quality ok · formula analytics-v2/)).toBeTruthy();
    const comparisonSelect = screen.getByRole('combobox', { name: 'Compare ride with' });
    fireEvent.change(comparisonSelect, { target: { value: 'recent_median' } });
    expect(
      screen.getByText(
        /Recent window of 1 prior rides · median coverage distance 1\/1, speed 1\/1, HR 1\/1/,
      ),
    ).toBeTruthy();
    fireEvent.change(comparisonSelect, { target: { value: 'previous' } });

    const download = vi.spyOn(rideExport, 'downloadRideExport').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Export ride' }));
    const exportDialog = screen.getByRole('alertdialog', { name: 'Export this ride?' });
    expect(exportDialog).toBeTruthy();
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Redact route start and finish',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole('spinbutton', {
          name: 'Route redaction radius in metres',
        }) as HTMLInputElement
      ).value,
    ).toBe('500');
    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }));
    expect(download).toHaveBeenCalledWith(initialDetail, {
      redactRouteEndpoints: true,
      routeRedactionRadiusM: 500,
    });
    expect(screen.queryByRole('alertdialog', { name: 'Export this ride?' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete ride' }));
    const deleteDialog = screen.getByRole('alertdialog', { name: 'Delete this ride?' });
    expect(deleteDialog.textContent).toContain(fmtDate(initialStart, timeZone));
    expect(deleteDialog.textContent).not.toContain(fmtDate(initialStart, 'UTC'));
    fireEvent.keyDown(deleteDialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog', { name: 'Delete this ride?' })).toBeNull();

    const initialChart = screen.getByRole('slider', { name: 'Heart Rate time cursor' });
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
    const initialRoute = screen.getByRole('img', { name: 'interactive offline route map' });
    const initialRouteSignature = initialRoute.getAttribute('data-route');
    expect(initialRouteSignature).toBeTruthy();
    expect(initialRoute.getAttribute('data-cursor')).not.toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Repair ride' }));

    await screen.findByText('Repaired: canonical ride details and analytics were reloaded.');
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: `Ride · ${fmtDate(repairedStart, timeZone)}`,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', {
        level: 1,
        name: `Ride · ${fmtDate(initialStart, timeZone)}`,
      }),
    ).toBeNull();
    expect(
      screen.getByText(
        new RegExp(`Compared with ${escapeRegex(fmtDate(repairedPrevious.startUtc, timeZone))}`),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Distance', { selector: '.kpi-label span' }).closest('.kpi')?.textContent,
    ).toContain('12.0km');

    const repairedChart = screen.getByRole('slider', { name: 'Heart Rate time cursor' });
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

    const repairedRoute = screen.getByRole('img', { name: 'interactive offline route map' });
    expect(repairedRoute.getAttribute('data-route')).not.toBe(initialRouteSignature);
    expect(repairedRoute.getAttribute('data-cursor')).toBe('');
  });

  it('renders canonical distance splits entirely in the selected imperial units', async () => {
    const start = Date.UTC(2036, 8, 10, 12);
    const end = start + 30 * 60_000;
    const imperialDetail = detail(12, start, end, 10_000, 0);
    imperialDetail.analytics!.splits = [
      {
        index: 1,
        kind: 'km',
        startOffsetS: 0,
        durationS: 200,
        distanceM: 1_000,
        avgSpeedMs: 5,
        avgHr: 123,
      },
    ];
    vi.spyOn(api, 'workout').mockResolvedValue(imperialDetail);
    vi.spyOn(api, 'workouts').mockResolvedValue({
      workouts: [summary(12, start, end, 10_000)],
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
      <MemoryRouter initialEntries={['/rides/12']}>
        <Routes>
          <Route path="/rides/:id" element={<RideDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    const heading = await screen.findByRole('heading', { name: 'Distance splits' });
    const card = heading.closest('.card');
    expect(card?.textContent).toContain('0.6 mi');
    expect(card?.textContent).toContain('11.2 mph');
    expect(card?.textContent).not.toContain('Splits (1 km)');
    expect(
      screen.getByRole('img', { name: 'interactive offline route map' }).getAttribute('data-units'),
    ).toBe('imperial');
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
