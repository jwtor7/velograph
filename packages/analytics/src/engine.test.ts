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
    dist.push({ t: min(i), value: i > 20 ? 250 : 300 }); // slower 2nd half, higher HR
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

describe('deterministic analytics engine', () => {
  it('computes the core summary (ANA-001)', () => {
    const a = computeRideAnalytics(mkInput(), settings);
    expect(a.formulaVersion).toBe(FORMULA_VERSION);
    expect(a.durationS).toBe(2400);
    expect(a.distanceM).toBeCloseTo(41 * 300 - 20 * 50, 3);
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

  it('zone times are interval-weighted and sum to the covered span (ANA-002)', () => {
    const a = computeRideAnalytics(mkInput(), settings);
    expect(a.zones).not.toBeNull();
    const total = a.zones!.reduce((s, z) => s + z.seconds, 0);
    expect(total).toBeGreaterThan(2300);
    expect(total).toBeLessThanOrEqual(2460);
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

  it('detects positive decoupling when 2nd half is slower at higher HR (ANA-004)', () => {
    const a = computeRideAnalytics(mkInput(), settings);
    expect(a.decouplingPct).not.toBeNull();
    expect(a.decouplingPct!).toBeGreaterThan(5);
  });

  it('produces km and time splits (ANA-005)', () => {
    const a = computeRideAnalytics(mkInput(), settings);
    const km = a.splits.filter((s) => s.kind === 'km');
    const time = a.splits.filter((s) => s.kind === 'time');
    expect(km.length).toBeGreaterThan(5);
    expect(time.length).toBe(8); // 40 min / 5 min
    expect(time[0]!.avgHr).not.toBeNull();
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
});
