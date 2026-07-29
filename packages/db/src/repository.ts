import type { Database } from 'better-sqlite3';
import type {
  ImportCounts,
  MetricKind,
  MetricSample,
  QuarantineCode,
  RouteSegment,
  WorkoutType,
} from '@velograph/shared';

export interface WorkoutRow {
  id: number;
  type: string;
  start_utc: number;
  end_utc: number;
  timezone: string | null;
  duration_s: number;
  provenance: string;
  quality_state: string;
}

/** Typed query layer over the Velograph schema. */
export class Repository {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createBatch(importerVersion: string, createdAt: number): number {
    const r = this.db
      .prepare(
        "INSERT INTO import_batches (created_at, status, importer_version) VALUES (?, 'pending', ?)",
      )
      .run(createdAt, importerVersion);
    return Number(r.lastInsertRowid);
  }

  finishBatch(batchId: number, status: 'committed' | 'failed', counts: ImportCounts): void {
    this.db
      .prepare('UPDATE import_batches SET status = ?, counts_json = ? WHERE id = ?')
      .run(status, JSON.stringify(counts), batchId);
  }

  findSourceFileByHash(sha256: string): { id: number; status: string } | undefined {
    return this.db.prepare('SELECT id, status FROM source_files WHERE sha256 = ?').get(sha256) as
      { id: number; status: string } | undefined;
  }

  insertSourceFile(row: {
    batchId: number;
    sha256: string;
    originalName: string;
    detectedType: string;
    parserVersion: string;
    status: 'imported' | 'skipped_duplicate' | 'quarantined';
    errorCode?: QuarantineCode;
    sizeBytes: number;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO source_files
           (batch_id, sha256, original_name, detected_type, parser_version, status, error_code, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.batchId,
        row.sha256,
        row.originalName,
        row.detectedType,
        row.parserVersion,
        row.status,
        row.errorCode ?? null,
        row.sizeBytes,
      );
    return Number(r.lastInsertRowid);
  }

  /**
   * Find a workout of this type whose time span overlaps or lies within
   * `toleranceMs` of [start, end] (IMP-005 association).
   */
  findCandidateWorkout(
    type: WorkoutType,
    start: number,
    end: number,
    toleranceMs: number,
  ): WorkoutRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM workouts
         WHERE type = ? AND start_utc <= ? AND end_utc >= ?
         ORDER BY start_utc LIMIT 1`,
      )
      .get(type, end + toleranceMs, start - toleranceMs) as WorkoutRow | undefined;
  }

  createWorkout(type: WorkoutType, start: number, end: number, provenance: string): number {
    const r = this.db
      .prepare(
        `INSERT INTO workouts (type, start_utc, end_utc, timezone, duration_s, provenance)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(type, start, end, Math.round((end - start) / 1000), provenance);
    return Number(r.lastInsertRowid);
  }

  /** Widen a workout's span to include [start, end]. */
  extendWorkoutSpan(workoutId: number, start: number, end: number): void {
    this.db
      .prepare(
        `UPDATE workouts SET
           start_utc = MIN(start_utc, ?),
           end_utc = MAX(end_utc, ?),
           duration_s = CAST(ROUND((MAX(end_utc, ?) - MIN(start_utc, ?)) / 1000.0) AS INTEGER)
         WHERE id = ?`,
      )
      .run(start, end, end, start, workoutId);
  }

  insertMetricSeries(row: {
    workoutId: number;
    sourceFileId: number;
    metric: MetricKind;
    unit: string;
    source: string | null;
    samples: MetricSample[];
  }): number {
    const first = row.samples[0]!;
    const last = row.samples[row.samples.length - 1]!;
    const r = this.db
      .prepare(
        `INSERT INTO metric_series
           (workout_id, source_file_id, metric_type, unit, source, start_utc, end_utc, sample_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.workoutId,
        row.sourceFileId,
        row.metric,
        row.unit,
        row.source,
        first.t,
        last.t,
        row.samples.length,
      );
    const seriesId = Number(r.lastInsertRowid);
    const ins = this.db.prepare(
      `INSERT INTO metric_samples (series_id, t_utc, value, value_min, value_max, context)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const s of row.samples) {
      ins.run(seriesId, s.t, s.value, s.min ?? null, s.max ?? null, s.context ?? null);
    }
    return seriesId;
  }

  insertRoute(row: {
    workoutId: number;
    sourceFileId: number;
    format: 'gpx' | 'csv';
    segments: RouteSegment[];
    distanceM: number | null;
  }): number {
    const points = row.segments.flatMap((s) => s.points);
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const bounds = {
      latMin: Math.min(...lats),
      latMax: Math.max(...lats),
      lonMin: Math.min(...lons),
      lonMax: Math.max(...lons),
    };
    const r = this.db
      .prepare(
        `INSERT INTO routes (workout_id, source_file_id, source_format, point_count, distance_m, bounds_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.workoutId,
        row.sourceFileId,
        row.format,
        points.length,
        row.distanceM,
        JSON.stringify(bounds),
      );
    const routeId = Number(r.lastInsertRowid);
    const ins = this.db.prepare(
      `INSERT INTO route_points
         (route_id, segment, seq, t_utc, lat, lon, ele_m, speed_ms, course_deg, hacc_m, vacc_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    row.segments.forEach((segment, segIdx) => {
      segment.points.forEach((p, i) => {
        ins.run(
          routeId,
          segIdx,
          i,
          p.t ?? null,
          p.lat,
          p.lon,
          p.ele ?? null,
          p.speed ?? null,
          p.course ?? null,
          p.hAcc ?? null,
          p.vAcc ?? null,
        );
      });
    });
    return routeId;
  }

  /** A workout already has a GPX route (IMP-006 GPX preferred over CSV). */
  workoutRouteFormat(workoutId: number): 'gpx' | 'csv' | undefined {
    const r = this.db
      .prepare('SELECT source_format FROM routes WHERE workout_id = ? ORDER BY id LIMIT 1')
      .get(workoutId) as { source_format: 'gpx' | 'csv' } | undefined;
    return r?.source_format;
  }

  deleteRoutesForWorkout(workoutId: number): void {
    this.db.prepare('DELETE FROM routes WHERE workout_id = ?').run(workoutId);
  }

  listWorkouts(): WorkoutRow[] {
    return this.db.prepare('SELECT * FROM workouts ORDER BY start_utc').all() as WorkoutRow[];
  }

  countRows(
    table: 'workouts' | 'metric_samples' | 'route_points' | 'metric_series' | 'routes',
  ): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return r.n;
  }

  getSetting<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value_json FROM user_settings WHERE key = ?').get(key) as
      { value_json: string } | undefined;
    return r ? (JSON.parse(r.value_json) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO user_settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value));
  }
}
