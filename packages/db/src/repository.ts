import type { Database } from 'better-sqlite3';
import type {
  ImportCounts,
  MetricKind,
  MetricSample,
  QuarantineCode,
  RoutePoint,
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

export interface SourceFileRow {
  id: number;
  status: string;
  parserVersion: string;
  detectedType: string;
}

interface SourceFileWrite {
  batchId: number;
  originalName: string;
  detectedType: string;
  parserVersion: string;
  status: 'imported' | 'skipped_duplicate' | 'quarantined';
  errorCode?: QuarantineCode;
  sizeBytes: number;
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

  findSourceFileByHash(sha256: string): SourceFileRow | undefined {
    return this.db
      .prepare(
        `SELECT id, status, parser_version AS parserVersion, detected_type AS detectedType
         FROM source_files WHERE sha256 = ?`,
      )
      .get(sha256) as SourceFileRow | undefined;
  }

  insertSourceFile(
    row: SourceFileWrite & {
      sha256: string;
    },
  ): number {
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

  /** Reuse the hash-unique inventory row when its parser version changes. */
  updateSourceFile(sourceFileId: number, row: SourceFileWrite): void {
    const result = this.db
      .prepare(
        `UPDATE source_files SET
           batch_id = ?, original_name = ?, detected_type = ?, parser_version = ?,
           status = ?, error_code = ?, size_bytes = ?
         WHERE id = ?`,
      )
      .run(
        row.batchId,
        row.originalName,
        row.detectedType,
        row.parserVersion,
        row.status,
        row.errorCode ?? null,
        row.sizeBytes,
        sourceFileId,
      );
    if (result.changes !== 1) throw new Error('source_file_not_found');
  }

  /**
   * Record a value-free parser-upgrade failure without changing the canonical
   * source row or its last-known-good normalized data.
   */
  recordSourceFileReprocessingFailure(row: {
    sourceFileId: number;
    batchId: number;
    attemptedParserVersion: string;
    errorCode: QuarantineCode;
    createdAt: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO source_file_reprocessing_failures
           (source_file_id, batch_id, attempted_parser_version, error_code, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.sourceFileId, row.batchId, row.attemptedParserVersion, row.errorCode, row.createdAt);
    return Number(result.lastInsertRowid);
  }

  /** Distinct workouts that own one source, including provenance-only relationships. */
  workoutIdsForSourceFile(sourceFileId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT workout_id AS id FROM workout_source_files WHERE source_file_id = ?
         UNION
         SELECT workout_id AS id FROM metric_series WHERE source_file_id = ?
         UNION
         SELECT workout_id AS id FROM routes WHERE source_file_id = ?
         ORDER BY id`,
      )
      .all(sourceFileId, sourceFileId, sourceFileId) as { id: number }[];
    return rows.map((row) => row.id);
  }

  /** Record source provenance even when its normalized geometry is superseded or ignored. */
  linkSourceFileToWorkout(workoutId: number, sourceFileId: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workout_source_files (workout_id, source_file_id)
         VALUES (?, ?)`,
      )
      .run(workoutId, sourceFileId);
  }

  /**
   * Remove normalized rows owned by one source before a parser-version
   * reprocessing pass. Empty workout shells are retained so successful
   * replacement can preserve stable identity and user-authored children;
   * callers must always invoke finalizeSourceFileReprocessing before commit.
   */
  detachSourceFileData(sourceFileId: number): number[] {
    const workoutIds = this.workoutIdsForSourceFile(sourceFileId);

    this.db.prepare('DELETE FROM metric_series WHERE source_file_id = ?').run(sourceFileId);
    this.db.prepare('DELETE FROM routes WHERE source_file_id = ?').run(sourceFileId);

    const hasNormalizedData = this.db.prepare(
      `SELECT 1 AS present FROM metric_series WHERE workout_id = ?
       UNION ALL
       SELECT 1 AS present FROM routes WHERE workout_id = ?
       LIMIT 1`,
    );
    for (const workoutId of workoutIds) {
      this.invalidateWorkoutDerivedOutputs(workoutId);
      if (hasNormalizedData.get(workoutId, workoutId) !== undefined) {
        this.recomputeWorkoutSpan(workoutId);
      }
    }
    return workoutIds;
  }

  /**
   * Complete a parser-version replacement by deriving surviving workout spans
   * from current rows. A workout shell is never deleted here: stable workout
   * identity and user-authored children such as notes/tags are not parser-owned.
   */
  finalizeSourceFileReprocessing(workoutIds: readonly number[]): void {
    for (const workoutId of workoutIds) {
      this.recomputeWorkoutSpan(workoutId);
    }
  }

  /** Inputs changed: cached deterministic and narrative outputs are no longer current. */
  invalidateWorkoutDerivedOutputs(workoutId: number): void {
    this.db.prepare('DELETE FROM analytics_snapshots WHERE workout_id = ?').run(workoutId);
    this.db.prepare('DELETE FROM insight_runs WHERE workout_id = ?').run(workoutId);
  }

  /**
   * Find every workout of this type whose time span overlaps or lies within
   * `toleranceMs` of [start, end] (IMP-005 association). Returning every
   * candidate is essential: ambiguity must be quarantined, never hidden by an
   * arbitrary earliest-row choice.
   */
  findCandidateWorkouts(
    type: WorkoutType,
    start: number,
    end: number,
    toleranceMs: number,
  ): WorkoutRow[] {
    return this.db
      .prepare(
        `SELECT * FROM workouts
         WHERE type = ? AND start_utc <= ? AND end_utc >= ?
         ORDER BY start_utc, id`,
      )
      .all(type, end + toleranceMs, start - toleranceMs) as WorkoutRow[];
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
    const seriesId = this.createMetricSeries({
      workoutId: row.workoutId,
      sourceFileId: row.sourceFileId,
      metric: row.metric,
      unit: row.unit,
      source: row.source,
      startUtc: first.t,
      endUtc: last.t,
      sampleCount: row.samples.length,
    });
    this.insertMetricSampleChunk(seriesId, row.samples);
    return seriesId;
  }

  createMetricSeries(row: {
    workoutId: number;
    sourceFileId: number;
    metric: MetricKind;
    unit: string;
    source: string | null;
    startUtc: number;
    endUtc: number;
    sampleCount: number;
  }): number {
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
        row.startUtc,
        row.endUtc,
        row.sampleCount,
      );
    return Number(r.lastInsertRowid);
  }

  insertMetricSampleChunk(seriesId: number, samples: readonly MetricSample[]): void {
    const ins = this.db.prepare(
      `INSERT INTO metric_samples (series_id, t_utc, value, value_min, value_max, context)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const s of samples) {
      ins.run(seriesId, s.t, s.value, s.min ?? null, s.max ?? null, s.context ?? null);
    }
  }

  insertRoute(row: {
    workoutId: number;
    sourceFileId: number;
    format: 'gpx' | 'csv';
    segments: RouteSegment[];
    distanceM: number | null;
  }): number {
    let pointCount = 0;
    let latMin = Number.POSITIVE_INFINITY;
    let latMax = Number.NEGATIVE_INFINITY;
    let lonMin = Number.POSITIVE_INFINITY;
    let lonMax = Number.NEGATIVE_INFINITY;
    for (const segment of row.segments) {
      for (const point of segment.points) {
        pointCount++;
        if (point.lat < latMin) latMin = point.lat;
        if (point.lat > latMax) latMax = point.lat;
        if (point.lon < lonMin) lonMin = point.lon;
        if (point.lon > lonMax) lonMax = point.lon;
      }
    }
    if (pointCount === 0) throw new Error('route_has_no_points');
    const bounds = { latMin, latMax, lonMin, lonMax };
    const routeId = this.createRoute({
      workoutId: row.workoutId,
      sourceFileId: row.sourceFileId,
      format: row.format,
      pointCount,
      distanceM: row.distanceM,
      bounds,
    });
    row.segments.forEach((segment, segIdx) => {
      this.insertRoutePointChunk(routeId, segIdx, 0, segment.points);
    });
    return routeId;
  }

  createRoute(row: {
    workoutId: number;
    sourceFileId: number;
    format: 'gpx' | 'csv';
    pointCount: number;
    distanceM: number | null;
    bounds: { latMin: number; latMax: number; lonMin: number; lonMax: number };
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO routes (workout_id, source_file_id, source_format, point_count, distance_m, bounds_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.workoutId,
        row.sourceFileId,
        row.format,
        row.pointCount,
        row.distanceM,
        JSON.stringify(row.bounds),
      );
    return Number(r.lastInsertRowid);
  }

  insertRoutePointChunk(
    routeId: number,
    segmentIndex: number,
    startSeq: number,
    points: readonly RoutePoint[],
  ): void {
    const ins = this.db.prepare(
      `INSERT INTO route_points
         (route_id, segment, seq, t_utc, lat, lon, ele_m, speed_ms, course_deg, hacc_m, vacc_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    points.forEach((p, index) => {
      ins.run(
        routeId,
        segmentIndex,
        startSeq + index,
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

  getWorkout(workoutId: number): WorkoutRow | undefined {
    return this.db.prepare('SELECT * FROM workouts WHERE id = ?').get(workoutId) as
      WorkoutRow | undefined;
  }

  /**
   * Distinct source inventory owned by a workout, including superseded and
   * fallback-only route files whose normalized geometry is not active.
   */
  sourceFileIdsForWorkout(workoutId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT source_file_id AS id FROM workout_source_files WHERE workout_id = ?
         UNION
         SELECT source_file_id AS id FROM metric_series WHERE workout_id = ?
         UNION
         SELECT source_file_id AS id FROM routes WHERE workout_id = ?
         ORDER BY id`,
      )
      .all(workoutId, workoutId, workoutId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /**
   * Delete a workout and every row that belongs to it, in one transaction.
   * Schema-level ON DELETE CASCADE handles metric_series/samples,
   * routes/route_points, analytics_snapshots, insight_runs, and notes_tags.
   * workout_source_files preserves ownership independently of active
   * normalized rows. source_files rows that become unowned by every remaining
   * workout are removed too (their content hash is forgotten so a later
   * re-import of the same file is not skipped as a duplicate) — see
   * docs/data-management.md.
   * A source file still referenced by another workout is left untouched.
   * Returns null if the workout does not exist.
   */
  deleteWorkout(workoutId: number): { removedSourceFileIds: number[] } | null {
    return this.transaction(() => {
      if (!this.getWorkout(workoutId)) return null;
      const candidateIds = this.sourceFileIdsForWorkout(workoutId);
      this.db.prepare('DELETE FROM workouts WHERE id = ?').run(workoutId);

      const stillReferenced = this.db.prepare(
        `SELECT 1 AS x FROM workout_source_files WHERE source_file_id = ?
         UNION ALL
         SELECT 1 AS x FROM metric_series WHERE source_file_id = ?
         UNION ALL
         SELECT 1 AS x FROM routes WHERE source_file_id = ?
         LIMIT 1`,
      );
      const deleteSourceFile = this.db.prepare('DELETE FROM source_files WHERE id = ?');
      const removedSourceFileIds: number[] = [];
      for (const id of candidateIds) {
        if (stillReferenced.get(id, id, id) === undefined) {
          deleteSourceFile.run(id);
          removedSourceFileIds.push(id);
        }
      }
      return { removedSourceFileIds };
    });
  }

  /**
   * Delete every persisted application row while preserving the SQLite schema
   * and ordered migration history. The explicit child-to-parent order also
   * clears nullable/global analytics and insight rows that are not owned by a
   * workout. This intentionally does not VACUUM or claim physical secure
   * erasure; see docs/data-management.md.
   */
  deleteAllData(): void {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM source_file_reprocessing_failures;
        DELETE FROM workout_source_files;
        DELETE FROM notes_tags;
        DELETE FROM insight_runs;
        DELETE FROM analytics_snapshots;
        DELETE FROM route_points;
        DELETE FROM routes;
        DELETE FROM metric_samples;
        DELETE FROM metric_series;
        DELETE FROM workouts;
        DELETE FROM source_files;
        DELETE FROM import_batches;
        DELETE FROM user_settings;
        DELETE FROM backup_manifests;
      `);
    });
  }

  /**
   * Recompute a workout's start/end/duration from its current metric_series
   * and route_points rows (repair: re-derive association bounds from stored
   * normalized data rather than trusting a possibly-stale span). Returns
   * false when the workout has no dated child rows left to derive bounds
   * from.
   */
  recomputeWorkoutSpan(workoutId: number): boolean {
    const bounds = this.db
      .prepare(
        `SELECT MIN(mn) AS start, MAX(mx) AS end FROM (
           SELECT start_utc AS mn, end_utc AS mx FROM metric_series WHERE workout_id = ?
           UNION ALL
           SELECT MIN(rp.t_utc), MAX(rp.t_utc)
             FROM route_points rp JOIN routes r ON r.id = rp.route_id
             WHERE r.workout_id = ? AND rp.t_utc IS NOT NULL
         )`,
      )
      .get(workoutId, workoutId) as { start: number | null; end: number | null };
    if (bounds.start == null || bounds.end == null) return false;
    this.db
      .prepare(
        `UPDATE workouts SET
           start_utc = ?, end_utc = ?,
           duration_s = CAST(ROUND((? - ?) / 1000.0) AS INTEGER)
         WHERE id = ?`,
      )
      .run(bounds.start, bounds.end, bounds.end, bounds.start, workoutId);
    return true;
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
