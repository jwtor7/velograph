import type { RoutePoint, WorkoutDetail } from './api.ts';

export const DEFAULT_ROUTE_REDACTION_RADIUS_M = 500;
export const MIN_ROUTE_REDACTION_RADIUS_M = 50;
export const MAX_ROUTE_REDACTION_RADIUS_M = 5_000;
export const RIDE_EXPORT_SCHEMA_VERSION = 'velograph-ride-export-v1';

export interface RideExportOptions {
  redactRouteEndpoints?: boolean;
  routeRedactionRadiusM?: number;
}

export type RideExportAnalytics = Omit<NonNullable<WorkoutDetail['analytics']>, 'workoutId'>;

export interface RideExport {
  schemaVersion: typeof RIDE_EXPORT_SCHEMA_VERSION;
  privacy: {
    sourceMetadataIncluded: false;
    routeEndpointsRedacted: boolean;
    routeRedactionRadiusM: number;
  };
  units: {
    time: 'unix_epoch_ms_utc';
    metricSamples: {
      heartRate: 'bpm';
      cadence: 'rpm';
      distance: 'm';
      energy: 'J';
    };
    routePoints: {
      coordinates: 'decimal_degrees';
      elevation: 'm';
      speed: 'm/s';
    };
    analytics: {
      durationS: 's';
      movingTimeS: 's';
      distanceM: 'm';
      avgSpeedMs: 'm/s';
      maxSpeedMs: 'm/s';
      heartRate: {
        avg: 'bpm';
        max: 'bpm';
        min: 'bpm';
        coverage: 'ratio';
      };
      cadence: {
        avg: 'rpm';
        max: 'rpm';
        min: 'rpm';
        coverage: 'ratio';
      };
      energyKj: 'kJ';
      elevation: {
        gainM: 'm';
        lossM: 'm';
        minM: 'm';
        maxM: 'm';
      };
      zones: {
        zone: 'ordinal';
        seconds: 's';
        share: 'ratio';
      };
      efficiency: 'km/h per bpm';
      decouplingPct: 'percent';
      pacingVariability: 'ratio';
      splits: {
        index: 'ordinal';
        startOffsetS: 's';
        durationS: 's';
        distanceM: 'm';
        avgSpeedMs: 'm/s';
        avgHr: 'bpm';
      };
    };
  };
  workout: Omit<WorkoutDetail['workout'], 'id'>;
  metrics: WorkoutDetail['metrics'];
  route: WorkoutDetail['route'];
  analytics: RideExportAnalytics | null;
}

function clampRedactionRadius(radius: number | undefined): number {
  if (radius === undefined) return DEFAULT_ROUTE_REDACTION_RADIUS_M;
  if (!Number.isFinite(radius)) return DEFAULT_ROUTE_REDACTION_RADIUS_M;
  return Math.min(
    MAX_ROUTE_REDACTION_RADIUS_M,
    Math.max(MIN_ROUTE_REDACTION_RADIUS_M, Math.round(radius)),
  );
}

function distanceM(a: RoutePoint, b: RoutePoint): number {
  const earthRadiusM = 6_371_008.8;
  const toRadians = Math.PI / 180;
  const lat1 = a.lat * toRadians;
  const lat2 = b.lat * toRadians;
  const dLat = (b.lat - a.lat) * toRadians;
  const dLon = (b.lon - a.lon) * toRadians;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const haversine = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function projectPortableMetrics(metrics: WorkoutDetail['metrics']): WorkoutDetail['metrics'] {
  const projected: WorkoutDetail['metrics'] = {};
  for (const metricType of ['heart_rate', 'cadence', 'distance', 'energy'] as const) {
    const samples = metrics[metricType];
    if (!samples) continue;
    projected[metricType] = samples.map((sample) => ({
      t: sample.t,
      value: sample.value,
      ...(sample.min === undefined ? {} : { min: sample.min }),
      ...(sample.max === undefined ? {} : { max: sample.max }),
    }));
  }
  return projected;
}

function projectPortableRoute(route: WorkoutDetail['route']): WorkoutDetail['route'] {
  return route.map((segment) => ({
    points: segment.points.map((point) => ({
      t: point.t,
      lat: point.lat,
      lon: point.lon,
      ...(point.ele === undefined ? {} : { ele: point.ele }),
      ...(point.speed === undefined ? {} : { speed: point.speed }),
    })),
  }));
}

function redactRouteEndpoints(
  route: WorkoutDetail['route'],
  radiusM: number,
): WorkoutDetail['route'] {
  const populatedSegments = route.filter((segment) => segment.points.length > 0);
  const start = populatedSegments[0]?.points[0];
  const finalSegment = populatedSegments[populatedSegments.length - 1];
  const finish = finalSegment?.points[finalSegment.points.length - 1];

  if (!start || !finish || radiusM <= 0) {
    return route.map((segment) => ({
      points: segment.points.map((point) => ({ ...point })),
    }));
  }

  const redacted: WorkoutDetail['route'] = [];
  for (const segment of route) {
    let retainedRun: RoutePoint[] = [];
    const flush = () => {
      if (retainedRun.length > 0) redacted.push({ points: retainedRun });
      retainedRun = [];
    };
    for (const point of segment.points) {
      const retained = distanceM(point, start) >= radiusM && distanceM(point, finish) >= radiusM;
      if (retained) retainedRun.push({ ...point });
      else flush();
    }
    flush();
  }
  return redacted;
}

function projectPortableAnalytics(
  analytics: WorkoutDetail['analytics'],
): RideExportAnalytics | null {
  if (!analytics) return null;
  return {
    formulaVersion: analytics.formulaVersion,
    durationS: analytics.durationS,
    movingTimeS: analytics.movingTimeS,
    distanceM: analytics.distanceM,
    avgSpeedMs: analytics.avgSpeedMs,
    maxSpeedMs: analytics.maxSpeedMs,
    heartRate: {
      avg: analytics.heartRate.avg,
      max: analytics.heartRate.max,
      min: analytics.heartRate.min,
      coverage: analytics.heartRate.coverage,
    },
    cadence: {
      avg: analytics.cadence.avg,
      max: analytics.cadence.max,
      min: analytics.cadence.min,
      coverage: analytics.cadence.coverage,
    },
    energyKj: analytics.energyKj,
    elevation: {
      gainM: analytics.elevation.gainM,
      lossM: analytics.elevation.lossM,
      minM: analytics.elevation.minM,
      maxM: analytics.elevation.maxM,
    },
    zones:
      analytics.zones?.map((zone) => ({
        zone: zone.zone,
        label: zone.label,
        seconds: zone.seconds,
        share: zone.share,
      })) ?? null,
    efficiency: analytics.efficiency,
    decouplingPct: analytics.decouplingPct,
    pacingVariability: analytics.pacingVariability,
    splits: analytics.splits.map((split) => ({
      index: split.index,
      kind: split.kind,
      startOffsetS: split.startOffsetS,
      durationS: split.durationS,
      distanceM: split.distanceM,
      avgSpeedMs: split.avgSpeedMs,
      avgHr: split.avgHr,
    })),
    unavailable: { ...analytics.unavailable },
  };
}

/** Build a portable ride export without source/device metadata. */
export function buildRideExport(
  detail: WorkoutDetail,
  options: RideExportOptions = {},
): RideExport {
  const routeEndpointsRedacted = options.redactRouteEndpoints ?? true;
  const routeRedactionRadiusM = routeEndpointsRedacted
    ? clampRedactionRadius(options.routeRedactionRadiusM)
    : 0;
  const portableRoute = projectPortableRoute(detail.route);

  return {
    schemaVersion: RIDE_EXPORT_SCHEMA_VERSION,
    privacy: {
      sourceMetadataIncluded: false,
      routeEndpointsRedacted,
      routeRedactionRadiusM,
    },
    units: {
      time: 'unix_epoch_ms_utc',
      metricSamples: {
        heartRate: 'bpm',
        cadence: 'rpm',
        distance: 'm',
        energy: 'J',
      },
      routePoints: {
        coordinates: 'decimal_degrees',
        elevation: 'm',
        speed: 'm/s',
      },
      analytics: {
        durationS: 's',
        movingTimeS: 's',
        distanceM: 'm',
        avgSpeedMs: 'm/s',
        maxSpeedMs: 'm/s',
        heartRate: {
          avg: 'bpm',
          max: 'bpm',
          min: 'bpm',
          coverage: 'ratio',
        },
        cadence: {
          avg: 'rpm',
          max: 'rpm',
          min: 'rpm',
          coverage: 'ratio',
        },
        energyKj: 'kJ',
        elevation: {
          gainM: 'm',
          lossM: 'm',
          minM: 'm',
          maxM: 'm',
        },
        zones: {
          zone: 'ordinal',
          seconds: 's',
          share: 'ratio',
        },
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
      },
    },
    workout: {
      type: detail.workout.type,
      startUtc: detail.workout.startUtc,
      endUtc: detail.workout.endUtc,
    },
    metrics: projectPortableMetrics(detail.metrics),
    route: routeEndpointsRedacted
      ? redactRouteEndpoints(portableRoute, routeRedactionRadiusM)
      : redactRouteEndpoints(portableRoute, 0),
    analytics: projectPortableAnalytics(detail.analytics),
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Byte-stable for identical canonical ride data and privacy settings. */
export function serializeRideExport(
  detail: WorkoutDetail,
  options: RideExportOptions = {},
): string {
  return `${JSON.stringify(sortJson(buildRideExport(detail, options)), null, 2)}\n`;
}

export function downloadRideExport(detail: WorkoutDetail, options: RideExportOptions = {}): void {
  const blob = new Blob([serializeRideExport(detail, options)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'velograph-ride.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
