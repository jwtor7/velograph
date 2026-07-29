import { describe, expect, it } from 'vitest';
import type { MetricSample } from '@velograph/shared';
import { computeRideAnalytics, FORMULA_VERSION } from './engine.ts';
import { DEFAULT_ANALYTICS_SETTINGS } from './settings.ts';
import type { AnalyticsInput } from './types.ts';

const T0 = Date.UTC(2031, 3, 2, 7, 30, 0);
const min = (m: number) => T0 + m * 60_000;

function mkInput(overrides: Partial<AnalyticsInput> = {}): AnalyticsInput {
  const hr: MetricSample[] = [];
  const dist: MetricSample[] = [];
  for (let i = 0; i <= 40; i++) {
    hr.push({ t: min(i), value: 120 + (i > 20 ? 10 : 0) });
    dist.push({ t: min(i), value: i > 20 ? 100 : 300 }); // slower 2nd half, higher HR
  }
  return {
    workout: { id: 1, type: 'outdoor_cycling', startUtc: T0, endUtc: min(40) },
    metrics: { heart_rate: hr, distance: dist },
    route: [
      {
        points: Array.from({ length: 41 }, (_, i) => {
          // elevation: 10→30 (min 0–10), 30→15 (10–20), 15→40 (20–30), 40→20 (30–40)
          const ele =
            i <= 10
              ? 10 + i * 2
              : i <= 20
                ? 30 - (i - 10) * 1.5
                : i <= 30
                  ? 15 + (i - 20) * 2.5
                  : 40 - (i - 30) * 2;
          // stopped minutes 20–29; fastest stretch minutes 30–39
          const speed = i < 20 ? 5 : i < 30 ? 0.5 : i < 40 ? 7 : 4;
          return { t: min(i), lat: -48.5 - i * 0.001, lon: -123.5, ele, speed };
        }),
      },
    ],
    ...overrides,
  };
}

const settings = { ...DEFAULT_ANALYTICS_SETTINGS, hrZoneBounds: [110, 125, 140, 155, 170] };

function stopHeavyInput(): AnalyticsInput {
  const heartRate = Array.from({ length: 21 }, (_, index) => ({
    t: min(index),
    value: index < 10 ? 100 : 110,
  }));
  const distance = Array.from({ length: 20 }, (_, index) => ({
    t: min(index + 1),
    value: index < 10 ? 100 : 150,
  }));
  return {
    workout: { id: 2, type: 'outdoor_cycling', startUtc: T0, endUtc: min(20) },
    metrics: { heart_rate: heartRate, distance },
    route: [
      {
        points: Array.from({ length: 21 }, (_, index) => ({
          t: min(index),
          lat: 1,
          lon: 1,
          speed: index < 5 || index >= 10 ? 2 : 0,
        })),
      },
    ],
  };
}

function coverageBoundaryInput(coveredMsPerHalf: number): AnalyticsInput {
  const halfMs = 1_000_000;
  const workoutEnd = T0 + halfMs * 2;
  const finalSampleOffset = halfMs - (coveredMsPerHalf - 7 * 90_000);
  const heartRate = [0, halfMs].flatMap((halfStart) =>
    [0, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000, finalSampleOffset].map((offset) => ({
      t: T0 + halfStart + offset,
      value: 120,
    })),
  );
  const distance = Array.from({ length: 40 }, (_, index) => ({
    t: T0 + (index + 1) * 50_000,
    value: 100,
  }));
  const points = Array.from({ length: 41 }, (_, index) => ({
    t: T0 + index * 50_000,
    lat: -48.5,
    lon: -123.5 + index * 0.0001,
    speed: 2,
  }));
  return {
    workout: {
      id: 6,
      type: 'outdoor_cycling',
      startUtc: T0,
      endUtc: workoutEnd,
    },
    metrics: { heart_rate: heartRate, distance },
    route: [{ points }],
  };
}

describe('deterministic analytics engine', () => {
  it('computes the core summary (ANA-001)', () => {
    const a = computeRideAnalytics(mkInput(), settings);
    expect(a.formulaVersion).toBe(FORMULA_VERSION);
    expect(a.durationS).toBe(2400);
    expect(a.distanceM).toBeCloseTo(41 * 300 - 20 * 200, 3);
    expect(a.heartRate.avg).toBeGreaterThan(120);
    expect(a.heartRate.max).toBe(130);
    expect(a.maxSpeedMs).toBe(7);
    // interval 20→30 min counts as stopped (speed 0.2 < 1.0 threshold)
    expect(a.movingTimeS).toBe(1800);
  });

  it('elevation hysteresis filters noise but keeps real climbs', () => {
    const a = computeRideAnalytics(mkInput(), settings);
    // climbs: 10→30 (+20), 15→40 (+25); descents: 30→15 (−15), 40→20 (−20)
    expect(a.elevation.gainM).toBe(45);
    expect(a.elevation.lossM).toBe(35);
  });

  it('zone times are interval-weighted and never exceed the workout span (ANA-002)', () => {
    const a = computeRideAnalytics(mkInput(), settings);
    expect(a.zones).not.toBeNull();
    const total = a.zones!.reduce((s, z) => s + z.seconds, 0);
    expect(total).toBe(2400);
    // first half 120 bpm → zone 2 (110–125), second half 130 → zone 3 (125–140)
    expect(a.zones![1]!.seconds).toBeGreaterThan(1000);
    expect(a.zones![2]!.seconds).toBeGreaterThan(1000);
  });

  it('zones are unavailable when not configured — never inferred', () => {
    const a = computeRideAnalytics(mkInput(), DEFAULT_ANALYTICS_SETTINGS);
    expect(a.zones).toBeNull();
    expect(a.unavailable['zones']).toBe('zones_not_configured');
  });

  it('efficiency is coverage-gated (ANA-003)', () => {
    const sparse = mkInput({
      metrics: {
        heart_rate: [
          { t: T0, value: 120 },
          { t: min(1), value: 121 },
        ],
        distance: mkInput().metrics.distance!,
      },
    });
    const a = computeRideAnalytics(sparse, settings);
    expect(a.efficiency).toBeNull();
    expect(a.unavailable['efficiency']).toBeDefined();
    const full = computeRideAnalytics(mkInput(), settings);
    expect(full.efficiency).toBeGreaterThan(0);
  });

  it('uses exact coverage for gates while rounding only the serialized value', () => {
    const below = computeRideAnalytics(coverageBoundaryInput(699_600), settings);
    const above = computeRideAnalytics(coverageBoundaryInput(700_400), settings);

    // Both raw values display as 0.700, but only 0.7004 meets the 0.7 gate.
    expect(below.heartRate.coverage).toBe(0.7);
    expect(above.heartRate.coverage).toBe(0.7);
    expect(below.efficiency).toBeNull();
    expect(below.unavailable['efficiency']).toBe('insufficient_coverage_or_inputs');
    expect(below.decouplingPct).toBeNull();
    expect(below.unavailable['decoupling']).toBe('insufficient_half_hr_coverage');
    expect(above.efficiency).not.toBeNull();
    expect(above.decouplingPct).toBe(0);
  });

  it('uses moving time for stop-heavy half efficiency (ANA-004)', () => {
    const a = computeRideAnalytics(stopHeavyInput(), settings);
    // Elapsed-time speed would make the second half look more efficient. The
    // moving-time formula correctly reports a decline instead.
    expect(a.decouplingPct).toBeCloseTo(31.818, 3);
  });

  it('requires independent HR, distance, and route coverage in both halves', () => {
    const input = stopHeavyInput();
    const sparseHeartRate = computeRideAnalytics(
      {
        ...input,
        metrics: {
          ...input.metrics,
          heart_rate: [
            { t: T0, value: 100 },
            { t: min(20), value: 110 },
          ],
        },
      },
      settings,
    );
    expect(sparseHeartRate.decouplingPct).toBeNull();
    expect(sparseHeartRate.unavailable['decoupling']).toBe('insufficient_half_hr_coverage');

    const sparseDistance = computeRideAnalytics(
      {
        ...input,
        metrics: {
          ...input.metrics,
          distance: [
            { t: min(10), value: 1000 },
            { t: min(20), value: 1000 },
          ],
        },
      },
      settings,
    );
    expect(sparseDistance.decouplingPct).toBeNull();
    expect(sparseDistance.unavailable['decoupling']).toBe('insufficient_half_distance_coverage');

    const sparseRoute = computeRideAnalytics(
      {
        ...input,
        route: [
          {
            points: [
              { t: T0, lat: 1, lon: 1, speed: 2 },
              { t: min(20), lat: 1, lon: 1, speed: 2 },
            ],
          },
        ],
      },
      settings,
    );
    expect(sparseRoute.decouplingPct).toBeNull();
    expect(sparseRoute.unavailable['decoupling']).toBe('insufficient_half_route_coverage');
  });

  it('rejects an unstable first-half efficiency instead of returning an unbounded ratio', () => {
    const input = stopHeavyInput();
    const tinyDistance = input.metrics.distance!.map((sample) => ({
      ...sample,
      value: 0.1,
    }));
    const a = computeRideAnalytics(
      { ...input, metrics: { ...input.metrics, distance: tinyDistance } },
      settings,
    );
    expect(a.decouplingPct).toBeNull();
    expect(a.unavailable['decoupling']).toBe('unstable_first_half_efficiency');
  });

  it('produces km and time splits (ANA-005)', () => {
    const a = computeRideAnalytics(mkInput(), settings);
    const km = a.splits.filter((s) => s.kind === 'km');
    const time = a.splits.filter((s) => s.kind === 'time');
    expect(km.length).toBeGreaterThan(5);
    expect(time.length).toBe(8); // 40 min / 5 min
    expect(time[0]!.avgHr).not.toBeNull();
  });

  it('interpolates every threshold crossed by one irregular distance increment', () => {
    const input = mkInput({
      workout: { id: 3, type: 'outdoor_cycling', startUtc: T0, endUtc: min(5) },
      metrics: {
        heart_rate: [
          { t: T0, value: 120 },
          { t: min(5), value: 999 },
        ],
        distance: [
          { t: min(1), value: 2500 },
          { t: min(3), value: 1000 },
        ],
      },
      route: [],
    });
    const km = computeRideAnalytics(input, settings).splits.filter((split) => split.kind === 'km');
    expect(km.map((split) => split.index)).toEqual([1, 2, 3]);
    expect(km.map((split) => split.startOffsetS)).toEqual([0, 24, 48]);
    expect(km.map((split) => split.durationS)).toEqual([24, 24, 72]);
    expect(new Set(km.map((split) => split.startOffsetS)).size).toBe(3);
  });

  it('does not fabricate a timed kilometre split from a zero-duration increment', () => {
    const input = mkInput({
      workout: { id: 4, type: 'outdoor_cycling', startUtc: T0, endUtc: min(5) },
      metrics: {
        distance: [
          { t: T0, value: 1500 },
          { t: min(1), value: 500 },
          { t: min(2), value: 1000 },
        ],
      },
      route: [],
    });
    const analytics = computeRideAnalytics(input, settings);
    const km = analytics.splits.filter((split) => split.kind === 'km');
    expect(km.map((split) => split.index)).toEqual([3]);
    expect(km[0]!.durationS).toBe(60);
    expect(analytics.splits.find((split) => split.kind === 'time')!.distanceM).toBe(1500);
  });

  it('gives a sample at the workout end zero forward coverage', () => {
    const a = computeRideAnalytics(
      mkInput({
        workout: { id: 5, type: 'outdoor_cycling', startUtc: T0, endUtc: min(10) },
        metrics: {
          heart_rate: [
            { t: T0, value: 100 },
            { t: min(10), value: 999 },
          ],
        },
        route: [],
      }),
      settings,
    );
    expect(a.heartRate.avg).toBe(100);
    expect(a.heartRate.max).toBe(100);
    expect(a.heartRate.coverage).toBe(0.15);
    expect(a.zones!.reduce((sum, zone) => sum + zone.seconds, 0)).toBe(90);
    expect(a.zones![5]!.seconds).toBe(0);
  });

  it('uses the arithmetic median for an even number of positive sample gaps', () => {
    const a = computeRideAnalytics(
      mkInput({
        workout: {
          id: 7,
          type: 'outdoor_cycling',
          startUtc: T0,
          endUtc: T0 + 200_000,
        },
        metrics: {
          heart_rate: [
            { t: T0, value: 100 },
            { t: T0 + 10_000, value: 100 },
            { t: T0 + 100_000, value: 200 },
          ],
        },
        route: [],
      }),
      settings,
    );

    // Positive gaps are 10 s and 90 s, so the final sample receives their
    // statistical median of 50 s rather than either middle observation.
    expect(a.heartRate.avg).toBe(133.333);
    expect(a.heartRate.coverage).toBe(0.75);
    expect(a.zones!.reduce((sum, zone) => sum + zone.seconds, 0)).toBe(150);
  });

  it('is byte-deterministic across runs', () => {
    const a = JSON.stringify(computeRideAnalytics(mkInput(), settings));
    const b = JSON.stringify(computeRideAnalytics(mkInput(), settings));
    expect(a).toBe(b);
  });

  it('handles a workout with no data gracefully', () => {
    const empty = mkInput({ metrics: {}, route: [] });
    const a = computeRideAnalytics(empty, settings);
    expect(a.distanceM).toBeNull();
    expect(a.efficiency).toBeNull();
    expect(Object.keys(a.unavailable).length).toBeGreaterThan(4);
  });

  it('never derives timing across route-file or segment boundaries', () => {
    const boundaryOnly = mkInput({
      metrics: {},
      route: [
        { points: [{ t: min(0), lat: -48.41, lon: -123.41, ele: 10 }] },
        { points: [{ t: min(1), lat: -48.42, lon: -123.42, ele: 20 }] },
      ],
    });
    const analytics = computeRideAnalytics(boundaryOnly, settings);
    expect(analytics.movingTimeS).toBeNull();
    expect(analytics.maxSpeedMs).toBeNull();
  });

  it('resets elevation hysteresis at every route boundary', () => {
    const analytics = computeRideAnalytics(
      mkInput({
        metrics: {},
        route: [
          {
            points: [
              { t: min(0), lat: 1, lon: 1, ele: 10 },
              { t: min(1), lat: 1, lon: 1, ele: 20 },
            ],
          },
          {
            points: [
              { t: min(2), lat: 1, lon: 1, ele: 100 },
              { t: min(3), lat: 1, lon: 1, ele: 110 },
            ],
          },
        ],
      }),
      settings,
    );
    expect(analytics.elevation.gainM).toBe(20);
    expect(analytics.elevation.lossM).toBe(0);
  });

  it('keeps untimed geometry and elevation without treating it as timing evidence', () => {
    const mixedTiming = mkInput({
      metrics: {},
      route: [
        {
          points: [
            { t: min(0), lat: -48.41, lon: -123.41, ele: 10 },
            { t: null, lat: -48.42, lon: -123.42, ele: 20 },
            { t: min(2), lat: -48.43, lon: -123.43, ele: 30 },
          ],
        },
      ],
    });
    const analytics = computeRideAnalytics(mixedTiming, settings);
    expect(analytics.movingTimeS).toBeNull();
    expect(analytics.maxSpeedMs).toBeNull();
    expect(analytics.elevation.gainM).toBe(20);
    expect(analytics.elevation.minM).toBe(10);
    expect(analytics.elevation.maxM).toBe(30);
  });
});
