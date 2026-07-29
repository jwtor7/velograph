import type { MetricSample, RouteSegment } from '@velograph/shared';
import type { Database } from 'better-sqlite3';

/**
 * Load one workout's normalized data in the shape the pure analytics engine
 * consumes (structurally matches @velograph/analytics AnalyticsInput — the db
 * package stays independent of the engine).
 */
export interface WorkoutData {
  workout: { id: number; type: string; startUtc: number; endUtc: number };
  metrics: Partial<Record<'heart_rate' | 'cadence' | 'distance' | 'energy', MetricSample[]>>;
  route: RouteSegment[];
}

export function loadWorkoutData(db: Database, workoutId: number): WorkoutData | null {
  const w = db
    .prepare('SELECT id, type, start_utc, end_utc FROM workouts WHERE id = ?')
    .get(workoutId) as { id: number; type: string; start_utc: number; end_utc: number } | undefined;
  if (!w) return null;

  const metrics: WorkoutData['metrics'] = {};
  const seriesRows = db
    .prepare(
      'SELECT id, metric_type FROM metric_series WHERE workout_id = ? ORDER BY metric_type, id',
    )
    .all(workoutId) as { id: number; metric_type: string }[];
  for (const series of seriesRows) {
    const rows = db
      .prepare(
        `SELECT t_utc, value, value_min, value_max, context
         FROM metric_samples WHERE series_id = ? AND valid = 1 ORDER BY t_utc, id`,
      )
      .all(series.id) as {
      t_utc: number;
      value: number;
      value_min: number | null;
      value_max: number | null;
      context: string | null;
    }[];
    const key = series.metric_type as keyof WorkoutData['metrics'];
    const samples: MetricSample[] = rows.map((r) => {
      const s: MetricSample = { t: r.t_utc, value: r.value };
      if (r.value_min != null) s.min = r.value_min;
      if (r.value_max != null) s.max = r.value_max;
      if (r.context != null) s.context = r.context;
      return s;
    });
    metrics[key] = [...(metrics[key] ?? []), ...samples].sort((a, b) => a.t - b.t);
  }

  const route: RouteSegment[] = [];
  const routeRow = db
    .prepare('SELECT id FROM routes WHERE workout_id = ? ORDER BY id LIMIT 1')
    .get(workoutId) as { id: number } | undefined;
  if (routeRow) {
    const points = db
      .prepare(
        `SELECT segment, t_utc, lat, lon, ele_m, speed_ms, course_deg
         FROM route_points WHERE route_id = ? ORDER BY segment, seq`,
      )
      .all(routeRow.id) as {
      segment: number;
      t_utc: number | null;
      lat: number;
      lon: number;
      ele_m: number | null;
      speed_ms: number | null;
      course_deg: number | null;
    }[];
    let currentSeg = -1;
    for (const p of points) {
      if (p.segment !== currentSeg) {
        route.push({ points: [] });
        currentSeg = p.segment;
      }
      const point: RouteSegment['points'][number] = { lat: p.lat, lon: p.lon };
      if (p.t_utc != null) point.t = p.t_utc;
      if (p.ele_m != null) point.ele = p.ele_m;
      if (p.speed_ms != null) point.speed = p.speed_ms;
      if (p.course_deg != null) point.course = p.course_deg;
      route[route.length - 1]!.points.push(point);
    }
  }

  return {
    workout: { id: w.id, type: w.type, startUtc: w.start_utc, endUtc: w.end_utc },
    metrics,
    route,
  };
}

/** Persist an analytics snapshot keyed by formula version + hashes (ANA-009). */
export function saveAnalyticsSnapshot(
  db: Database,
  row: {
    workoutId: number;
    formulaVersion: string;
    settingsHash: string;
    inputHash: string;
    resultJson: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO analytics_snapshots
       (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
     VALUES (?, 'workout', ?, ?, ?, ?, ?)
     ON CONFLICT (workout_id, scope, formula_version, settings_hash, input_hash)
     DO UPDATE SET result_json = excluded.result_json`,
  ).run(
    row.workoutId,
    row.formulaVersion,
    row.settingsHash,
    row.inputHash,
    row.resultJson,
    row.createdAt,
  );
}

export function getAnalyticsSnapshot(
  db: Database,
  workoutId: number,
  formulaVersion: string,
  settingsHash: string,
  inputHash: string,
): string | undefined {
  const r = db
    .prepare(
      `SELECT result_json FROM analytics_snapshots
       WHERE workout_id = ? AND scope = 'workout' AND formula_version = ?
         AND settings_hash = ? AND input_hash = ?`,
    )
    .get(workoutId, formulaVersion, settingsHash, inputHash) as { result_json: string } | undefined;
  return r?.result_json;
}
