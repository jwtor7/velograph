import { describe, expect, it } from 'vitest';
import type { MetricSample, RoutePoint, WorkoutDetail } from './api.ts';
import {
  buildRideExport,
  DEFAULT_ROUTE_REDACTION_RADIUS_M,
  MAX_ROUTE_REDACTION_RADIUS_M,
  MIN_ROUTE_REDACTION_RADIUS_M,
  serializeRideExport,
} from './ride-export.ts';

function syntheticDetail(): WorkoutDetail {
  const startUtc = Date.UTC(2038, 6, 12, 10);
  return {
    workout: {
      id: 17,
      type: 'outdoor_cycling',
      startUtc,
      endUtc: startUtc + 1_800_000,
    },
    metrics: {
      heart_rate: [
        { t: startUtc, value: 112 },
        { t: startUtc + 900_000, value: 128 },
      ],
      distance: [
        { t: startUtc, value: 0 },
        { t: startUtc + 900_000, value: 5_000 },
      ],
      energy: [
        { t: startUtc, value: 31_000 },
        { t: startUtc + 900_000, value: 34_000 },
      ],
    },
    route: [
      {
        points: [
          { t: startUtc, lat: 0, lon: 0, ele: 10 },
          { t: startUtc + 600_000, lat: 0, lon: 0.01, ele: 20 },
          { t: startUtc + 1_200_000, lat: 0, lon: 0.02, ele: 15 },
          { t: startUtc + 1_800_000, lat: 0, lon: 0.03, ele: 10 },
        ],
      },
    ],
    analytics: null,
  };
}

function addSyntheticAnalytics(detail: WorkoutDetail): void {
  detail.analytics = {
    formulaVersion: 'analytics-synthetic',
    workoutId: detail.workout.id,
    durationS: 1_800,
    movingTimeS: 1_740,
    distanceM: 9_000,
    avgSpeedMs: 5,
    maxSpeedMs: 8,
    heartRate: { avg: 120, max: 148, min: 92, coverage: 0.98 },
    cadence: { avg: 81, max: 104, min: 62, coverage: 0.94 },
    energyKj: 320,
    elevation: { gainM: 65, lossM: 61, minM: 10, maxM: 42 },
    zones: [{ zone: 2, label: 'Zone 2', seconds: 900, share: 0.5 }],
    efficiency: 0.15,
    decouplingPct: 2.5,
    pacingVariability: 0.08,
    splits: [
      {
        index: 1,
        kind: 'km',
        startOffsetS: 0,
        durationS: 200,
        distanceM: 1_000,
        avgSpeedMs: 5,
        avgHr: 118,
      },
    ],
    unavailable: {},
  };
}

describe('ride export', () => {
  it('defaults to a portable metadata-free export with both route endpoints redacted', () => {
    const source = syntheticDetail();
    const exported = buildRideExport(source);

    expect(exported.privacy).toEqual({
      sourceMetadataIncluded: false,
      routeEndpointsRedacted: true,
      routeRedactionRadiusM: DEFAULT_ROUTE_REDACTION_RADIUS_M,
    });
    expect(exported.workout).not.toHaveProperty('id');
    expect(exported.route[0]?.points.map((point) => point.lon)).toEqual([0.01, 0.02]);
    expect(source.route[0]?.points).toHaveLength(4);
    expect(exported.units.metricSamples.energy).toBe('J');
    expect(exported.units.analytics.energyKj).toBe('kJ');
    expect(exported.metrics.energy?.[0]?.value).toBe(31_000);
    expect(JSON.stringify(exported)).not.toContain('sourceFile');
    expect(JSON.stringify(exported)).not.toContain('device');
  });

  it('uses an explicit analytics allow-list, omits local IDs, and declares every numeric unit', () => {
    const detail = syntheticDetail();
    addSyntheticAnalytics(detail);

    const exported = buildRideExport(detail);
    const serialized = serializeRideExport(detail);

    expect(exported.analytics).not.toHaveProperty('workoutId');
    expect(serialized).not.toContain('"workoutId"');
    expect(exported.units.analytics).toEqual({
      durationS: 's',
      movingTimeS: 's',
      distanceM: 'm',
      avgSpeedMs: 'm/s',
      maxSpeedMs: 'm/s',
      heartRate: { avg: 'bpm', max: 'bpm', min: 'bpm', coverage: 'ratio' },
      cadence: { avg: 'rpm', max: 'rpm', min: 'rpm', coverage: 'ratio' },
      energyKj: 'kJ',
      elevation: { gainM: 'm', lossM: 'm', minM: 'm', maxM: 'm' },
      zones: { zone: 'ordinal', seconds: 's', share: 'ratio' },
      efficiency: 'km/h per bpm',
      decouplingPct: 'percent',
      pacingVariability: 'ratio',
      splits: {
        index: 'ordinal',
        startOffsetS: 's',
        durationS: 's',
        distanceM: 'm',
        avgSpeedMs: 'm/s',
        avgHr: 'bpm',
      },
    });
  });

  it('strips runtime-only metric context, route course, and undeclared properties', () => {
    const detail = syntheticDetail();
    const metricSample = detail.metrics.heart_rate![0]! as MetricSample & {
      context: string;
      runtimeCanary: string;
    };
    metricSample.context = 'synthetic-context-canary';
    metricSample.runtimeCanary = 'synthetic-metric-canary';
    const routePoint = detail.route[0]!.points[1]! as RoutePoint & {
      course: number;
      runtimeCanary: string;
    };
    routePoint.course = 271;
    routePoint.runtimeCanary = 'synthetic-route-canary';

    const exported = buildRideExport(detail, { redactRouteEndpoints: false });
    const serialized = serializeRideExport(detail, { redactRouteEndpoints: false });

    expect(exported.metrics.heart_rate![0]).toEqual({
      t: detail.workout.startUtc,
      value: 112,
    });
    expect(exported.route[0]!.points[1]).toEqual({
      t: detail.workout.startUtc + 600_000,
      lat: 0,
      lon: 0.01,
      ele: 20,
    });
    expect(serialized).not.toContain('context');
    expect(serialized).not.toContain('course');
    expect(serialized).not.toContain('runtimeCanary');
    expect(serialized).not.toContain('synthetic-metric-canary');
    expect(serialized).not.toContain('synthetic-route-canary');
  });

  it('makes unredacted coordinates an explicit option and records that choice', () => {
    const exported = buildRideExport(syntheticDetail(), {
      redactRouteEndpoints: false,
      routeRedactionRadiusM: 900,
    });

    expect(exported.privacy.routeEndpointsRedacted).toBe(false);
    expect(exported.privacy.routeRedactionRadiusM).toBe(0);
    expect(exported.route[0]?.points).toHaveLength(4);
  });

  it('clamps the configurable radius and serializes identical inputs byte-for-byte', () => {
    const detail = syntheticDetail();
    const first = serializeRideExport(detail, {
      routeRedactionRadiusM: MAX_ROUTE_REDACTION_RADIUS_M + 50_000,
    });
    const second = serializeRideExport(detail, {
      routeRedactionRadiusM: MAX_ROUTE_REDACTION_RADIUS_M + 50_000,
    });

    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first).privacy.routeRedactionRadiusM).toBe(MAX_ROUTE_REDACTION_RADIUS_M);
    expect(JSON.parse(first).route).toEqual([]);
  });

  it('treats a zero redaction radius as the safe positive minimum', () => {
    const exported = buildRideExport(syntheticDetail(), {
      redactRouteEndpoints: true,
      routeRedactionRadiusM: 0,
    });

    expect(exported.privacy).toMatchObject({
      routeEndpointsRedacted: true,
      routeRedactionRadiusM: MIN_ROUTE_REDACTION_RADIUS_M,
    });
    expect(exported.route[0]?.points.map((point) => point.lon)).toEqual([0.01, 0.02]);
  });

  it('preserves a segment gap when a route revisits a redacted endpoint area', () => {
    const detail = syntheticDetail();
    detail.route[0]!.points.splice(2, 0, {
      t: detail.workout.startUtc + 1_000_000,
      lat: 0,
      lon: 1 / 1_000,
      ele: 12,
    });

    const exported = buildRideExport(detail, { routeRedactionRadiusM: 500 });

    expect(exported.route.map((segment) => segment.points.map((point) => point.lon))).toEqual([
      [0.01],
      [0.02],
    ]);
  });
});
