// apps/cli/src/index.ts
import { readFileSync as readFileSync2, readdirSync as readdirSync2, statSync } from "node:fs";
import { basename, join as join4 } from "node:path";

// packages/db/src/database.ts
import DatabaseConstructor from "better-sqlite3";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// packages/db/src/migrate.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
function applyMigrations(db, dir) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map(
      (r) => r.name
    )
  );
  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const runOne = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        Date.now()
      );
    });
    runOne();
    ran.push(file);
  }
  return ran;
}

// packages/db/src/database.ts
var MIGRATIONS_DIR = join2(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
function openDatabase(path) {
  const db = new DatabaseConstructor(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  applyMigrations(db, MIGRATIONS_DIR);
  return db;
}

// packages/db/src/datadir.ts
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join as join3, resolve } from "node:path";
function resolveDataDir(env = process.env) {
  const fromEnv = env["VELO_DATA_DIR"];
  let dir;
  if (fromEnv && fromEnv.trim() !== "") {
    dir = isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
  } else if (process.platform === "darwin") {
    dir = join3(homedir(), "Library", "Application Support", "velograph");
  } else if (process.platform === "win32") {
    dir = join3(env["APPDATA"] ?? join3(homedir(), "AppData", "Roaming"), "velograph");
  } else {
    dir = join3(env["XDG_DATA_HOME"] ?? join3(homedir(), ".local", "share"), "velograph");
  }
  guardAgainstCheckout(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function guardAgainstCheckout(dir) {
  let cursor = resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join3(cursor, ".git"))) {
      throw new Error(
        `VELO_DATA_DIR (${dir}) is inside a git checkout; choose a location outside any repository`
      );
    }
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }
}
function databasePath(dataDir) {
  return join3(dataDir, "velograph.sqlite3");
}

// packages/db/src/repository.ts
var Repository = class {
  db;
  constructor(db) {
    this.db = db;
  }
  transaction(fn) {
    return this.db.transaction(fn)();
  }
  createBatch(importerVersion, createdAt) {
    const r = this.db.prepare(
      "INSERT INTO import_batches (created_at, status, importer_version) VALUES (?, 'pending', ?)"
    ).run(createdAt, importerVersion);
    return Number(r.lastInsertRowid);
  }
  finishBatch(batchId, status, counts) {
    this.db.prepare("UPDATE import_batches SET status = ?, counts_json = ? WHERE id = ?").run(status, JSON.stringify(counts), batchId);
  }
  findSourceFileByHash(sha256) {
    return this.db.prepare("SELECT id, status FROM source_files WHERE sha256 = ?").get(sha256);
  }
  insertSourceFile(row) {
    const r = this.db.prepare(
      `INSERT INTO source_files
           (batch_id, sha256, original_name, detected_type, parser_version, status, error_code, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.batchId,
      row.sha256,
      row.originalName,
      row.detectedType,
      row.parserVersion,
      row.status,
      row.errorCode ?? null,
      row.sizeBytes
    );
    return Number(r.lastInsertRowid);
  }
  /**
   * Find a workout of this type whose time span overlaps or lies within
   * `toleranceMs` of [start, end] (IMP-005 association).
   */
  findCandidateWorkout(type, start, end, toleranceMs) {
    return this.db.prepare(
      `SELECT * FROM workouts
         WHERE type = ? AND start_utc <= ? AND end_utc >= ?
         ORDER BY start_utc LIMIT 1`
    ).get(type, end + toleranceMs, start - toleranceMs);
  }
  createWorkout(type, start, end, provenance) {
    const r = this.db.prepare(
      `INSERT INTO workouts (type, start_utc, end_utc, timezone, duration_s, provenance)
         VALUES (?, ?, ?, NULL, ?, ?)`
    ).run(type, start, end, Math.round((end - start) / 1e3), provenance);
    return Number(r.lastInsertRowid);
  }
  /** Widen a workout's span to include [start, end]. */
  extendWorkoutSpan(workoutId, start, end) {
    this.db.prepare(
      `UPDATE workouts SET
           start_utc = MIN(start_utc, ?),
           end_utc = MAX(end_utc, ?),
           duration_s = CAST(ROUND((MAX(end_utc, ?) - MIN(start_utc, ?)) / 1000.0) AS INTEGER)
         WHERE id = ?`
    ).run(start, end, end, start, workoutId);
  }
  insertMetricSeries(row) {
    const first = row.samples[0];
    const last = row.samples[row.samples.length - 1];
    const r = this.db.prepare(
      `INSERT INTO metric_series
           (workout_id, source_file_id, metric_type, unit, source, start_utc, end_utc, sample_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.workoutId,
      row.sourceFileId,
      row.metric,
      row.unit,
      row.source,
      first.t,
      last.t,
      row.samples.length
    );
    const seriesId = Number(r.lastInsertRowid);
    const ins = this.db.prepare(
      `INSERT INTO metric_samples (series_id, t_utc, value, value_min, value_max, context)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of row.samples) {
      ins.run(seriesId, s.t, s.value, s.min ?? null, s.max ?? null, s.context ?? null);
    }
    return seriesId;
  }
  insertRoute(row) {
    const points = row.segments.flatMap((s) => s.points);
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const bounds = {
      latMin: Math.min(...lats),
      latMax: Math.max(...lats),
      lonMin: Math.min(...lons),
      lonMax: Math.max(...lons)
    };
    const r = this.db.prepare(
      `INSERT INTO routes (workout_id, source_file_id, source_format, point_count, distance_m, bounds_json)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      row.workoutId,
      row.sourceFileId,
      row.format,
      points.length,
      row.distanceM,
      JSON.stringify(bounds)
    );
    const routeId = Number(r.lastInsertRowid);
    const ins = this.db.prepare(
      `INSERT INTO route_points
         (route_id, segment, seq, t_utc, lat, lon, ele_m, speed_ms, course_deg, hacc_m, vacc_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          p.vAcc ?? null
        );
      });
    });
    return routeId;
  }
  /** A workout already has a GPX route (IMP-006 GPX preferred over CSV). */
  workoutRouteFormat(workoutId) {
    const r = this.db.prepare("SELECT source_format FROM routes WHERE workout_id = ? ORDER BY id LIMIT 1").get(workoutId);
    return r?.source_format;
  }
  deleteRoutesForWorkout(workoutId) {
    this.db.prepare("DELETE FROM routes WHERE workout_id = ?").run(workoutId);
  }
  listWorkouts() {
    return this.db.prepare("SELECT * FROM workouts ORDER BY start_utc").all();
  }
  getWorkout(workoutId) {
    return this.db.prepare("SELECT * FROM workouts WHERE id = ?").get(workoutId);
  }
  /** Distinct source_files ids a workout's metric series and route(s) reference. */
  sourceFileIdsForWorkout(workoutId) {
    const rows = this.db.prepare(
      `SELECT source_file_id AS id FROM metric_series WHERE workout_id = ?
         UNION
         SELECT source_file_id AS id FROM routes WHERE workout_id = ?`
    ).all(workoutId, workoutId);
    return rows.map((r) => r.id);
  }
  /**
   * Delete a workout and every row that belongs to it, in one transaction.
   * Schema-level ON DELETE CASCADE handles metric_series/samples,
   * routes/route_points, analytics_snapshots, insight_runs, and notes_tags.
   * source_files rows that become unreferenced by any remaining workout are
   * removed too (their content hash is forgotten so a later re-import of the
   * same file is not skipped as a duplicate) — see docs/data-management.md.
   * A source file still referenced by another workout is left untouched.
   * Returns null if the workout does not exist.
   */
  deleteWorkout(workoutId) {
    return this.transaction(() => {
      if (!this.getWorkout(workoutId)) return null;
      const candidateIds = this.sourceFileIdsForWorkout(workoutId);
      this.db.prepare("DELETE FROM workouts WHERE id = ?").run(workoutId);
      const stillReferenced = this.db.prepare(
        `SELECT 1 AS x FROM metric_series WHERE source_file_id = ?
         UNION ALL
         SELECT 1 AS x FROM routes WHERE source_file_id = ?
         LIMIT 1`
      );
      const deleteSourceFile = this.db.prepare("DELETE FROM source_files WHERE id = ?");
      const removedSourceFileIds = [];
      for (const id of candidateIds) {
        if (stillReferenced.get(id, id) === void 0) {
          deleteSourceFile.run(id);
          removedSourceFileIds.push(id);
        }
      }
      return { removedSourceFileIds };
    });
  }
  /**
   * Recompute a workout's start/end/duration from its current metric_series
   * and route_points rows (repair: re-derive association bounds from stored
   * normalized data rather than trusting a possibly-stale span). Returns
   * false when the workout has no dated child rows left to derive bounds
   * from.
   */
  recomputeWorkoutSpan(workoutId) {
    const bounds = this.db.prepare(
      `SELECT MIN(mn) AS start, MAX(mx) AS end FROM (
           SELECT start_utc AS mn, end_utc AS mx FROM metric_series WHERE workout_id = ?
           UNION ALL
           SELECT MIN(rp.t_utc), MAX(rp.t_utc)
             FROM route_points rp JOIN routes r ON r.id = rp.route_id
             WHERE r.workout_id = ? AND rp.t_utc IS NOT NULL
         )`
    ).get(workoutId, workoutId);
    if (bounds.start == null || bounds.end == null) return false;
    this.db.prepare(
      `UPDATE workouts SET
           start_utc = ?, end_utc = ?,
           duration_s = CAST(ROUND((? - ?) / 1000.0) AS INTEGER)
         WHERE id = ?`
    ).run(bounds.start, bounds.end, bounds.end, bounds.start, workoutId);
    return true;
  }
  /** Delete analytics snapshots left over from a prior formula version (repair). */
  deleteStaleAnalyticsSnapshots(workoutId, currentFormulaVersion) {
    const r = this.db.prepare("DELETE FROM analytics_snapshots WHERE workout_id = ? AND formula_version != ?").run(workoutId, currentFormulaVersion);
    return r.changes;
  }
  countRows(table) {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return r.n;
  }
  getSetting(key) {
    const r = this.db.prepare("SELECT value_json FROM user_settings WHERE key = ?").get(key);
    return r ? JSON.parse(r.value_json) : void 0;
  }
  setSetting(key, value) {
    this.db.prepare(
      `INSERT INTO user_settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
    ).run(key, JSON.stringify(value));
  }
};

// packages/db/src/analytics-input.ts
function loadWorkoutData(db, workoutId) {
  const w = db.prepare("SELECT id, type, start_utc, end_utc FROM workouts WHERE id = ?").get(workoutId);
  if (!w) return null;
  const metrics = {};
  const seriesRows = db.prepare(
    "SELECT id, metric_type FROM metric_series WHERE workout_id = ? ORDER BY metric_type, id"
  ).all(workoutId);
  for (const series of seriesRows) {
    const rows = db.prepare(
      `SELECT t_utc, value, value_min, value_max, context
         FROM metric_samples WHERE series_id = ? AND valid = 1 ORDER BY t_utc, id`
    ).all(series.id);
    const key = series.metric_type;
    const samples = rows.map((r) => {
      const s = { t: r.t_utc, value: r.value };
      if (r.value_min != null) s.min = r.value_min;
      if (r.value_max != null) s.max = r.value_max;
      if (r.context != null) s.context = r.context;
      return s;
    });
    metrics[key] = [...metrics[key] ?? [], ...samples].sort((a, b) => a.t - b.t);
  }
  const route = [];
  const routeRow = db.prepare("SELECT id FROM routes WHERE workout_id = ? ORDER BY id LIMIT 1").get(workoutId);
  if (routeRow) {
    const points = db.prepare(
      `SELECT segment, t_utc, lat, lon, ele_m, speed_ms, course_deg
         FROM route_points WHERE route_id = ? ORDER BY segment, seq`
    ).all(routeRow.id);
    let currentSeg = -1;
    for (const p of points) {
      if (p.segment !== currentSeg) {
        route.push({ points: [] });
        currentSeg = p.segment;
      }
      const point = { t: p.t_utc ?? 0, lat: p.lat, lon: p.lon };
      if (p.ele_m != null) point.ele = p.ele_m;
      if (p.speed_ms != null) point.speed = p.speed_ms;
      if (p.course_deg != null) point.course = p.course_deg;
      route[route.length - 1].points.push(point);
    }
  }
  return {
    workout: { id: w.id, type: w.type, startUtc: w.start_utc, endUtc: w.end_utc },
    metrics,
    route
  };
}
function saveAnalyticsSnapshot(db, row) {
  db.prepare(
    `INSERT INTO analytics_snapshots
       (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
     VALUES (?, 'workout', ?, ?, ?, ?, ?)
     ON CONFLICT (workout_id, scope, formula_version, settings_hash, input_hash)
     DO UPDATE SET result_json = excluded.result_json`
  ).run(
    row.workoutId,
    row.formulaVersion,
    row.settingsHash,
    row.inputHash,
    row.resultJson,
    row.createdAt
  );
}

// packages/db/src/backup.ts
import DatabaseConstructor2 from "better-sqlite3";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, rmSync } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
async function backupDatabase(db, destPath) {
  const resolved = resolve2(destPath);
  guardAgainstCheckout(dirname2(resolved));
  mkdirSync2(dirname2(resolved), { recursive: true });
  return db.backup(resolved);
}
function isVelographBackup(path) {
  if (!existsSync2(path)) return false;
  let probe;
  try {
    probe = new DatabaseConstructor2(path, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    return probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workouts'").get() !== void 0;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}
async function restoreDatabase(liveDb, dbPath, backupPath) {
  const resolvedBackup = resolve2(backupPath);
  if (!isVelographBackup(resolvedBackup)) {
    throw new Error("invalid_backup_file");
  }
  const source = new DatabaseConstructor2(resolvedBackup, { readonly: true, fileMustExist: true });
  try {
    liveDb.pragma("wal_checkpoint(TRUNCATE)");
    liveDb.close();
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync2(sidecar)) rmSync(sidecar);
    }
    await source.backup(resolve2(dbPath));
  } finally {
    source.close();
  }
  return openDatabase(dbPath);
}

// packages/analytics/src/settings.ts
var DEFAULT_ANALYTICS_SETTINGS = {
  hrZoneBounds: null,
  movingSpeedThresholdMs: 1,
  minCoverageForEfficiency: 0.7,
  elevationHysteresisM: 1
};
var ZONE_LABELS = [
  "Z1 Recovery",
  "Z2 Endurance",
  "Z3 Tempo",
  "Z4 Threshold",
  "Z5 VO2 Max",
  "Z6 Anaerobic"
];

// packages/analytics/src/engine.ts
var FORMULA_VERSION = "analytics-v1";
var COVERAGE_GAP_CAP_MS = 9e4;
var round3 = (v) => Math.round(v * 1e3) / 1e3;
var round1 = (v) => Math.round(v * 10) / 10;
function computeRideAnalytics(input, settings) {
  const durationS = Math.round((input.workout.endUtc - input.workout.startUtc) / 1e3);
  const unavailable = {};
  const hrSamples = input.metrics.heart_rate ?? [];
  const cadSamples = input.metrics.cadence ?? [];
  const distSamples = input.metrics.distance ?? [];
  const energySamples = input.metrics.energy ?? [];
  const heartRate = metricStat(hrSamples, durationS);
  const cadence = metricStat(cadSamples, durationS);
  const distanceM = distSamples.length ? round3(distSamples.reduce((acc, s) => acc + s.value, 0)) : null;
  if (distanceM == null) unavailable["distance"] = "no_distance_samples";
  const energyKj = energySamples.length ? round3(energySamples.reduce((acc, s) => acc + s.value, 0) / 1e3) : null;
  if (energyKj == null) unavailable["energy"] = "no_energy_samples";
  const routeSpeeds = collectRouteSpeeds(input.route);
  const movingTimeS = movingTime(input.route, settings.movingSpeedThresholdMs);
  if (movingTimeS == null) unavailable["moving_time"] = "no_route_timing";
  const avgSpeedMs = distanceM != null && movingTimeS != null && movingTimeS > 0 ? round3(distanceM / movingTimeS) : distanceM != null && durationS > 0 ? round3(distanceM / durationS) : null;
  if (avgSpeedMs == null) unavailable["avg_speed"] = "no_distance_or_duration";
  const maxSpeedMs = routeSpeeds.length ? round3(Math.max(...routeSpeeds)) : null;
  if (maxSpeedMs == null) unavailable["max_speed"] = "no_route_speeds";
  const elevation = elevationProfile(input.route, settings.elevationHysteresisM);
  if (elevation.gainM == null) unavailable["elevation"] = "no_elevation_data";
  const zones = settings.hrZoneBounds ? zoneTimes(hrSamples, settings.hrZoneBounds, durationS) : null;
  if (!settings.hrZoneBounds) unavailable["zones"] = "zones_not_configured";
  const efficiency = efficiencyRatio(avgSpeedMs, heartRate, settings.minCoverageForEfficiency);
  if (efficiency == null) unavailable["efficiency"] = "insufficient_coverage_or_inputs";
  const decouplingPct = decoupling(input, settings);
  if (decouplingPct == null) unavailable["decoupling"] = "insufficient_half_data";
  const pacingVariability = pacing(distSamples);
  if (pacingVariability == null)
    unavailable["pacing_variability"] = "insufficient_distance_samples";
  return {
    formulaVersion: FORMULA_VERSION,
    workoutId: input.workout.id,
    durationS,
    movingTimeS,
    distanceM,
    avgSpeedMs,
    maxSpeedMs,
    heartRate,
    cadence,
    energyKj,
    elevation,
    zones,
    efficiency,
    decouplingPct,
    pacingVariability,
    splits: computeSplits(input),
    unavailable
  };
}
function metricStat(samples, durationS) {
  if (samples.length === 0) {
    return { avg: null, max: null, min: null, coverage: null, sampleCount: 0 };
  }
  const weights = intervalWeights(samples);
  let wSum = 0;
  let vSum = 0;
  let max = -Infinity;
  let min = Infinity;
  samples.forEach((s, i) => {
    const w = weights[i];
    wSum += w;
    vSum += s.value * w;
    const hi = s.max ?? s.value;
    const lo = s.min ?? s.value;
    if (hi > max) max = hi;
    if (lo < min) min = lo;
  });
  const coverage = durationS > 0 ? Math.min(1, wSum / 1e3 / durationS) : null;
  return {
    avg: wSum > 0 ? round3(vSum / wSum) : null,
    max: round3(max),
    min: round3(min),
    coverage: coverage != null ? round3(coverage) : null,
    sampleCount: samples.length
  };
}
function intervalWeights(samples) {
  const n = samples.length;
  if (n === 1) return [6e4];
  const gaps = [];
  for (let i = 0; i < n - 1; i++) {
    gaps.push(Math.min(samples[i + 1].t - samples[i].t, COVERAGE_GAP_CAP_MS));
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)];
  return [...gaps, median];
}
function collectRouteSpeeds(route) {
  const speeds = [];
  for (const seg of route) {
    for (const p of seg.points) {
      if (p.speed != null && Number.isFinite(p.speed)) speeds.push(p.speed);
    }
  }
  if (speeds.length > 0) return speeds;
  for (const seg of route) {
    for (let i = 0; i < seg.points.length - 1; i++) {
      const a = seg.points[i];
      const b = seg.points[i + 1];
      if (a.t == null || b.t == null || b.t <= a.t) continue;
      const dtS = (b.t - a.t) / 1e3;
      if (dtS * 1e3 > COVERAGE_GAP_CAP_MS) continue;
      speeds.push(haversineM(a.lat, a.lon, b.lat, b.lon) / dtS);
    }
  }
  return speeds;
}
function haversineM(aLat, aLon, bLat, bLon) {
  const R = 63710088e-1;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function movingTime(route, thresholdMs) {
  let ms = 0;
  let sawTiming = false;
  for (const seg of route) {
    for (let i = 0; i < seg.points.length - 1; i++) {
      const a = seg.points[i];
      const b = seg.points[i + 1];
      if (a.t == null || b.t == null || b.t <= a.t) continue;
      sawTiming = true;
      const dt = Math.min(b.t - a.t, COVERAGE_GAP_CAP_MS);
      const speed = a.speed ?? haversineM(a.lat, a.lon, b.lat, b.lon) / ((b.t - a.t) / 1e3);
      if (speed >= thresholdMs) ms += dt;
    }
  }
  return sawTiming ? Math.round(ms / 1e3) : null;
}
function elevationProfile(route, hysteresisM) {
  const eles = [];
  for (const seg of route) {
    for (const p of seg.points) {
      if (p.ele != null) eles.push(p.ele);
    }
  }
  if (eles.length < 2) return { gainM: null, lossM: null, minM: null, maxM: null };
  let gain = 0;
  let loss = 0;
  let anchor = eles[0];
  for (const e of eles) {
    const delta = e - anchor;
    if (delta >= hysteresisM) {
      gain += delta;
      anchor = e;
    } else if (delta <= -hysteresisM) {
      loss += -delta;
      anchor = e;
    }
  }
  return {
    gainM: round1(gain),
    lossM: round1(loss),
    minM: round1(Math.min(...eles)),
    maxM: round1(Math.max(...eles))
  };
}
function zoneTimes(samples, bounds, durationS) {
  const zoneCount = bounds.length + 1;
  const ms = new Array(zoneCount).fill(0);
  if (samples.length > 0) {
    const weights = intervalWeights(samples);
    samples.forEach((s, i) => {
      let z = 0;
      while (z < bounds.length && s.value >= bounds[z]) z++;
      ms[z] += weights[i];
    });
  }
  const totalS = Math.max(durationS, ms.reduce((a, b) => a + b, 0) / 1e3);
  return ms.map((m, i) => ({
    zone: i + 1,
    label: ZONE_LABELS[i] ?? `Z${i + 1}`,
    seconds: Math.round(m / 1e3),
    share: totalS > 0 ? round3(m / 1e3 / totalS) : 0
  }));
}
function efficiencyRatio(avgSpeedMs, hr, minCoverage) {
  if (avgSpeedMs == null || hr.avg == null || hr.coverage == null) return null;
  if (hr.coverage < minCoverage || hr.avg <= 0) return null;
  return round3(avgSpeedMs * 3.6 / hr.avg);
}
function decoupling(input, settings) {
  const hr = input.metrics.heart_rate ?? [];
  const dist = input.metrics.distance ?? [];
  if (hr.length < 4 || dist.length < 4) return null;
  const mid = input.workout.startUtc + (input.workout.endUtc - input.workout.startUtc) / 2;
  const halfEff = (from, to) => {
    const hrHalf = hr.filter((s) => s.t >= from && s.t < to);
    const distHalf = dist.filter((s) => s.t >= from && s.t < to);
    if (hrHalf.length < 2 || distHalf.length < 2) return null;
    const stat = metricStat(hrHalf, (to - from) / 1e3);
    if (stat.avg == null || stat.coverage == null) return null;
    if (stat.coverage < settings.minCoverageForEfficiency) return null;
    const meters = distHalf.reduce((a, s) => a + s.value, 0);
    const speedKmh = meters / ((to - from) / 1e3) * 3.6;
    return speedKmh / stat.avg;
  };
  const first = halfEff(input.workout.startUtc, mid);
  const second = halfEff(mid, input.workout.endUtc);
  if (first == null || second == null || first <= 0) return null;
  return round3((first - second) / first * 100);
}
function pacing(dist) {
  if (dist.length < 4) return null;
  const values = dist.map((s) => s.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return round3(Math.sqrt(variance) / mean);
}
function computeSplits(input) {
  const splits = [];
  const dist = input.metrics.distance ?? [];
  const hr = input.metrics.heart_rate ?? [];
  const start = input.workout.startUtc;
  let cum = 0;
  let kmIndex = 0;
  let splitStartT = start;
  let splitStartCum = 0;
  for (const s of dist) {
    cum += s.value;
    while (cum - splitStartCum >= 1e3) {
      kmIndex++;
      const durationS = Math.max(1, Math.round((s.t - splitStartT) / 1e3));
      splits.push({
        index: kmIndex,
        kind: "km",
        startOffsetS: Math.round((splitStartT - start) / 1e3),
        durationS,
        distanceM: 1e3,
        avgSpeedMs: round3(1e3 / durationS),
        avgHr: avgInWindow(hr, splitStartT, s.t)
      });
      splitStartT = s.t;
      splitStartCum += 1e3;
    }
  }
  const windowMs = 5 * 60 * 1e3;
  let idx = 0;
  for (let t = start; t < input.workout.endUtc; t += windowMs) {
    idx++;
    const to = Math.min(t + windowMs, input.workout.endUtc);
    const meters = dist.filter((s) => s.t >= t && s.t < to).reduce((a, s) => a + s.value, 0);
    const durationS = Math.round((to - t) / 1e3);
    splits.push({
      index: idx,
      kind: "time",
      startOffsetS: Math.round((t - start) / 1e3),
      durationS,
      distanceM: meters > 0 ? round3(meters) : null,
      avgSpeedMs: meters > 0 && durationS > 0 ? round3(meters / durationS) : null,
      avgHr: avgInWindow(hr, t, to)
    });
  }
  return splits;
}
function avgInWindow(samples, from, to) {
  const inWin = samples.filter((s) => s.t >= from && s.t < to);
  if (inWin.length === 0) return null;
  const stat = metricStat(inWin, (to - from) / 1e3);
  return stat.avg;
}

// packages/shared/src/types.ts
var CANONICAL_UNITS = {
  heart_rate: "bpm",
  cadence: "rpm",
  distance: "m",
  energy: "J"
};

// packages/shared/src/time.ts
var ISO_NO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
var ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/;
var zoneFormatters = /* @__PURE__ */ new Map();
function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}
function systemTimeZone() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
}
function formatterForZone(timeZone) {
  const existing = zoneFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}
function localPartsAt(instant, timeZone) {
  const parts = Object.fromEntries(
    formatterForZone(timeZone).formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts["year"],
    month: parts["month"],
    day: parts["day"],
    hour: parts["hour"],
    minute: parts["minute"],
    second: parts["second"]
  };
}
function wallTimeAsUtc(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond
  );
}
function zonedWallTimeToUtc(parts, timeZone) {
  if (!isValidTimeZone(timeZone)) return null;
  const desired = wallTimeAsUtc(parts);
  let guess = desired;
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < 6; i++) {
    if (seen.has(guess)) return null;
    seen.add(guess);
    const local = localPartsAt(guess, timeZone);
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
      parts.millisecond
    );
    const delta = desired - represented;
    if (delta === 0) return guess;
    guess += delta;
  }
  return null;
}
function parseInstant(raw, options = {}) {
  const s = raw.trim();
  let m = ISO_NO_OFFSET.exec(s);
  let offsetMin = 0;
  let hasExplicitOffset = false;
  if (!m) {
    m = ISO_WITH_OFFSET.exec(s);
    if (!m) return null;
    hasExplicitOffset = true;
    const off = m[8];
    if (off !== "Z") {
      const sign = off.startsWith("-") ? -1 : 1;
      const digits = off.slice(1).replace(":", "");
      offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
  }
  const [, y, mo, d, h, mi, sec, frac] = m;
  const parts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(sec),
    millisecond: frac ? Number(frac.padEnd(3, "0")) : 0
  };
  if (!hasExplicitOffset && options.defaultTimeZone) {
    return zonedWallTimeToUtc(parts, options.defaultTimeZone);
  }
  const ms = wallTimeAsUtc(parts);
  if (Number.isNaN(ms)) return null;
  return ms - offsetMin * 6e4;
}

// packages/shared/src/hash.ts
import { createHash } from "node:crypto";
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

// apps/api/src/analytics-service.ts
var SETTINGS_KEY = "analytics";
function loadSettings(db) {
  const stored = new Repository(db).getSetting(SETTINGS_KEY);
  const requestedZone = stored?.timeZone;
  const timeZone = typeof requestedZone === "string" && isValidTimeZone(requestedZone) ? requestedZone : systemTimeZone();
  return { ...DEFAULT_ANALYTICS_SETTINGS, ...stored ?? {}, timeZone };
}
function repairWorkout(db, workoutId, now) {
  const repo = new Repository(db);
  return repo.transaction(() => {
    if (!repo.getWorkout(workoutId)) return null;
    repo.recomputeWorkoutSpan(workoutId);
    repo.deleteStaleAnalyticsSnapshots(workoutId, FORMULA_VERSION);
    const input = loadWorkoutData(db, workoutId);
    if (!input) return null;
    const settings = loadSettings(db);
    const settingsHash = sha256Hex(stableStringify(settings));
    const inputHash = sha256Hex(stableStringify(input));
    const result = computeRideAnalytics(input, settings);
    saveAnalyticsSnapshot(db, {
      workoutId,
      formulaVersion: FORMULA_VERSION,
      settingsHash,
      inputHash,
      resultJson: stableStringify(result),
      createdAt: now
    });
    return result;
  });
}

// packages/importers/src/csv.ts
var CsvError = class extends Error {
  line;
  constructor(message, line) {
    super(message);
    this.name = "CsvError";
    this.line = line;
  }
};
var CsvStreamParser = class {
  field = "";
  row = [];
  inQuotes = false;
  afterQuote = false;
  sawAny = false;
  line = 1;
  first = true;
  onRow;
  constructor(onRow) {
    this.onRow = onRow;
  }
  push(chunk) {
    let s = chunk;
    if (this.first) {
      if (s.charCodeAt(0) === 65279) s = s.slice(1);
      this.first = false;
    }
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.inQuotes) {
        if (this.afterQuote) {
          this.afterQuote = false;
          if (c === '"') {
            this.field += '"';
            continue;
          }
          this.inQuotes = false;
        } else if (c === '"') {
          this.afterQuote = true;
          continue;
        } else {
          if (c === "\n") this.line++;
          this.field += c;
          continue;
        }
      }
      if (c === '"') {
        if (this.field !== "") throw new CsvError("quote inside unquoted field", this.line);
        this.inQuotes = true;
        this.sawAny = true;
      } else if (c === ",") {
        this.endField();
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        this.endRow();
        this.line++;
      } else {
        this.field += c;
        this.sawAny = true;
      }
    }
  }
  end() {
    if (this.inQuotes && !this.afterQuote) throw new CsvError("unterminated quote", this.line);
    this.endRow();
  }
  endField() {
    this.row.push(this.field);
    this.field = "";
    this.sawAny = true;
    this.afterQuote = false;
    this.inQuotes = false;
  }
  endRow() {
    this.afterQuote = false;
    this.inQuotes = false;
    if (!this.sawAny && this.row.length === 0) return;
    this.row.push(this.field);
    this.field = "";
    const complete = this.row;
    this.row = [];
    this.sawAny = false;
    this.onRow(complete, this.line);
  }
};
function parseCsv(text) {
  const rows = [];
  const p = new CsvStreamParser((row) => rows.push(row));
  p.push(text);
  p.end();
  return rows;
}

// packages/importers/src/gpx.ts
var DEFAULT_GPX_LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  maxPoints: 5e5,
  maxDepth: 32
};
var GpxError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "GpxError";
    this.code = code;
  }
};
var ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'"
};
var decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITY_MAP[m]);
var localName = (tag) => {
  const idx = tag.indexOf(":");
  return idx === -1 ? tag : tag.slice(idx + 1);
};
function parseGpx(input, limits = DEFAULT_GPX_LIMITS) {
  if (input.length > limits.maxBytes) {
    throw new GpxError("gpx_limits_exceeded", "input exceeds size limit");
  }
  if (/<!(DOCTYPE|ENTITY)/i.test(input)) {
    throw new GpxError("xml_doctype_rejected", "DTD and entity declarations are not allowed");
  }
  const tagRe = /<\/?([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;
  const segments = [];
  let current = null;
  let point = null;
  let dropped = 0;
  let totalPoints = 0;
  let depth = 0;
  let sawGpxRoot = false;
  const stack = [];
  let lastIndex = 0;
  let textTarget = null;
  let textStart = -1;
  const openPointField = (name, index) => {
    if (!point) return;
    if (name === "ele" || name === "time" || name === "speed" || name === "course") {
      textTarget = name;
      textStart = index;
    }
  };
  const closePointField = (name, index, raw) => {
    if (!point || !textTarget || localName(name) !== textTarget) return;
    const text = decodeEntities(raw.slice(textStart, index)).trim();
    if (textTarget === "ele") {
      const v = Number(text);
      if (Number.isFinite(v) && v > -500 && v < 1e4) point.ele = v;
    } else if (textTarget === "time") {
      const t = parseInstant(text.replace(/Z$/, "Z"));
      if (t != null) point.t = t;
    } else if (textTarget === "speed") {
      const v = Number(text);
      if (Number.isFinite(v) && v >= 0 && v < 150) point.speed = v;
    } else if (textTarget === "course") {
      const v = Number(text);
      if (Number.isFinite(v) && v >= 0 && v < 360) point.course = v;
    }
    textTarget = null;
    textStart = -1;
  };
  let m;
  while ((m = tagRe.exec(input)) !== null) {
    if (m[1] === void 0) continue;
    const rawTag = m[0];
    const name = localName(m[1]);
    const attrs = m[2] ?? "";
    const selfClosing = m[3] === "/";
    const isClose = rawTag.startsWith("</");
    if (isClose) {
      closePointField(m[1], m.index, input);
      const expected = stack.pop();
      depth--;
      if (expected === void 0) throw new GpxError("malformed_xml", "unbalanced closing tag");
      if (name === "trkpt" && point) {
        totalPoints++;
        if (totalPoints > limits.maxPoints) {
          throw new GpxError("gpx_limits_exceeded", "too many track points");
        }
        if (isValidPoint(point)) current?.push(point);
        else dropped++;
        point = null;
      } else if (name === "trkseg" && current) {
        if (current.length > 0) segments.push({ points: current });
        current = null;
      }
      lastIndex = tagRe.lastIndex;
      continue;
    }
    if (!selfClosing) {
      stack.push(m[1]);
      depth++;
      if (depth > limits.maxDepth) throw new GpxError("gpx_limits_exceeded", "nesting too deep");
    }
    if (name === "gpx") sawGpxRoot = true;
    else if (name === "trkseg") current = [];
    else if (name === "trkpt") {
      point = {};
      const lat = attrValue(attrs, "lat");
      const lon = attrValue(attrs, "lon");
      const latN = lat == null ? NaN : Number(lat);
      const lonN = lon == null ? NaN : Number(lon);
      if (Number.isFinite(latN)) point.lat = latN;
      if (Number.isFinite(lonN)) point.lon = lonN;
      if (selfClosing) {
        totalPoints++;
        if (totalPoints > limits.maxPoints) {
          throw new GpxError("gpx_limits_exceeded", "too many track points");
        }
        if (isValidPoint(point)) current?.push(point);
        else dropped++;
        point = null;
      }
    } else if (!selfClosing && point) {
      openPointField(name, tagRe.lastIndex);
    }
    lastIndex = tagRe.lastIndex;
  }
  void lastIndex;
  if (!sawGpxRoot) throw new GpxError("malformed_xml", "no gpx root element");
  if (stack.length !== 0) throw new GpxError("malformed_xml", "unclosed elements");
  return { segments, droppedPoints: dropped };
}
function attrValue(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? "");
}
function isValidPoint(p) {
  return typeof p.lat === "number" && typeof p.lon === "number" && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

// packages/importers/src/zip.ts
import { unzipSync } from "fflate";
var DEFAULT_ZIP_LIMITS = {
  maxEntries: 2e3,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024
};
var ZipError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
};
var NESTED_ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
function extractZip(zipData, limits = DEFAULT_ZIP_LIMITS) {
  let decoded;
  let entrySeen = 0;
  try {
    decoded = unzipSync(zipData, {
      filter: (file) => {
        entrySeen++;
        if (entrySeen > limits.maxEntries) {
          throw new ZipError("zip_limits_exceeded", "too many entries");
        }
        validateEntryName(file.name);
        if (file.name.endsWith("/")) return false;
        if (NESTED_ARCHIVE.test(file.name)) {
          throw new ZipError("zip_entry_rejected", "nested archives are not supported");
        }
        if (file.originalSize > limits.maxEntryBytes) {
          throw new ZipError("zip_limits_exceeded", "entry exceeds size limit");
        }
        return true;
      }
    });
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError("io_error", "zip could not be read");
  }
  const entries = [];
  let total = 0;
  for (const [name, data] of Object.entries(decoded)) {
    total += data.length;
    if (data.length > limits.maxEntryBytes || total > limits.maxTotalBytes) {
      throw new ZipError("zip_limits_exceeded", "decompressed size exceeds limit");
    }
    if (name.split("/").includes("__MACOSX")) continue;
    const base = name.split("/").filter(Boolean).pop();
    if (!base || base.startsWith(".")) continue;
    entries.push({ name: base, data });
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function validateEntryName(name) {
  if (name.includes("\0") || name.includes("\\")) {
    throw new ZipError("zip_entry_rejected", "entry name contains forbidden characters");
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ZipError("zip_entry_rejected", "absolute entry paths are not allowed");
  }
  if (name.split("/").includes("..")) {
    throw new ZipError("zip_entry_rejected", "path traversal entry rejected");
  }
}

// packages/importers/src/adapters.ts
var ADAPTER_VERSION = "hae-csv-v1";
var AdapterError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
};
function parseHaeFilename(name) {
  const m = /^(Outdoor|Indoor) Cycling-(.+?)-(\d{8}_\d{6})\.(csv|gpx)$/i.exec(name.trim());
  if (!m) return null;
  return {
    workoutType: m[1].toLowerCase() === "indoor" ? "indoor_cycling" : "outdoor_cycling",
    label: m[2],
    stampHint: m[3]
  };
}
var norm = (h) => h.toLowerCase().replace(/\s+|\(|\)/g, "");
var CSV_SHAPES = [
  {
    metric: "heart_rate",
    value: ["avgbpm", "avgcount/min", "avg", "heartratebpm", "bpm"],
    min: ["minbpm", "mincount/min", "min"],
    max: ["maxbpm", "maxcount/min", "max"],
    toCanonical: (v) => v
  },
  {
    metric: "cadence",
    value: ["cadencerpm", "cyclingcadencecount/min", "cadence", "rpm"],
    toCanonical: (v) => v
  },
  {
    metric: "distance",
    value: ["cyclingdistancekm", "distancekm", "distance"],
    toCanonical: (v) => v * 1e3
    // km → m
  },
  {
    metric: "energy",
    value: ["activeenergykj", "energykj", "activeenergy", "energy"],
    toCanonical: (v) => v * 1e3
    // kJ → J
  }
];
var ROUTE_CSV_HEADERS = ["timestamp", "latitude", "longitude"];
function parseHaeCsv(name, text, options = {}) {
  const info = parseHaeFilename(name);
  if (!info) throw new AdapterError("unsupported_file_type", "filename not recognized");
  if (text.trim() === "") throw new AdapterError("empty_file", "file is empty");
  let rows;
  try {
    rows = parseCsv(text);
  } catch {
    throw new AdapterError("malformed_csv", "CSV structure invalid");
  }
  if (rows.length < 2) throw new AdapterError("no_valid_samples", "no data rows");
  const header = rows[0].map(norm);
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const tIdx = idx(["date/time", "datetime", "date", "timestamp"]);
  if (tIdx === -1) throw new AdapterError("unrecognized_headers", "no timestamp column");
  if (ROUTE_CSV_HEADERS.every((h) => header.includes(h))) {
    return parseRouteCsvRows(info, rows, header, options);
  }
  const shape = CSV_SHAPES.find((s) => idx(s.value) !== -1);
  if (!shape) throw new AdapterError("unrecognized_headers", "no known metric column");
  const vIdx = idx(shape.value);
  const minIdx = shape.min ? idx(shape.min) : -1;
  const maxIdx = shape.max ? idx(shape.max) : -1;
  const srcIdx = idx(["source"]);
  const ctxIdx = idx(["context"]);
  const samples = [];
  let source = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const t = parseInstant(row[tIdx] ?? "", { defaultTimeZone: options.timeZone ?? null });
    const v = Number(row[vIdx]);
    if (t == null || !Number.isFinite(v)) continue;
    const s = { t, value: shape.toCanonical(v) };
    if (minIdx !== -1 && row[minIdx] !== "" && Number.isFinite(Number(row[minIdx]))) {
      s.min = shape.toCanonical(Number(row[minIdx]));
    }
    if (maxIdx !== -1 && row[maxIdx] !== "" && Number.isFinite(Number(row[maxIdx]))) {
      s.max = shape.toCanonical(Number(row[maxIdx]));
    }
    if (ctxIdx !== -1 && row[ctxIdx]) s.context = row[ctxIdx];
    if (srcIdx !== -1 && row[srcIdx]) source = row[srcIdx];
    samples.push(s);
  }
  if (samples.length === 0) throw new AdapterError("no_valid_samples", "no parseable rows");
  samples.sort((a, b) => a.t - b.t);
  return { kind: "metric", metric: shape.metric, workoutType: info.workoutType, source, samples };
}
function parseRouteCsvRows(info, rows, header, options) {
  const col = (n) => header.indexOf(n);
  const tIdx = col("timestamp");
  const latIdx = col("latitude");
  const lonIdx = col("longitude");
  const altIdx = header.findIndex((h) => h.startsWith("altitude"));
  const spdIdx = header.findIndex((h) => h.startsWith("speed"));
  const crsIdx = header.findIndex((h) => h.startsWith("course"));
  const haIdx = header.findIndex((h) => h.startsWith("horizontalaccuracy"));
  const vaIdx = header.findIndex((h) => h.startsWith("verticalaccuracy"));
  const points = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const t = parseInstant(row[tIdx] ?? "", { defaultTimeZone: options.timeZone ?? null });
    const lat = Number(row[latIdx]);
    const lon = Number(row[lonIdx]);
    if (t == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const p = { t, lat, lon };
    const opt = (idx, key) => {
      if (idx !== -1) {
        const v = Number(row[idx]);
        if (Number.isFinite(v)) p[key] = v;
      }
    };
    opt(altIdx, "ele");
    opt(spdIdx, "speed");
    opt(crsIdx, "course");
    opt(haIdx, "hAcc");
    opt(vaIdx, "vAcc");
    points.push(p);
  }
  if (points.length === 0) throw new AdapterError("no_valid_samples", "no valid route rows");
  points.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const segments = [];
  let seg = [];
  let prev = null;
  for (const p of points) {
    if (prev != null && p.t != null && p.t - prev > 6e4 && seg.length) {
      segments.push({ points: seg });
      seg = [];
    }
    seg.push(p);
    if (p.t != null) prev = p.t;
  }
  if (seg.length) segments.push({ points: seg });
  return { kind: "route", format: "csv", workoutType: info.workoutType, segments };
}
function parseHaeGpx(name, text) {
  const info = parseHaeFilename(name);
  const workoutType = info?.workoutType ?? "outdoor_cycling";
  try {
    const { segments } = parseGpx(text);
    if (segments.length === 0) throw new AdapterError("no_valid_samples", "no track points");
    return { kind: "route", format: "gpx", workoutType, segments };
  } catch (err) {
    if (err instanceof GpxError) throw new AdapterError(err.code, err.message);
    throw err;
  }
}

// packages/importers/src/association.ts
var DEFAULT_ASSOCIATION_TOLERANCE_MS = 10 * 60 * 1e3;
function sampleTimeRange(file) {
  if (file.kind === "metric") {
    if (file.samples.length === 0) return null;
    return { start: file.samples[0].t, end: file.samples[file.samples.length - 1].t };
  }
  const times = file.segments.flatMap((s) => s.points.map((p) => p.t)).filter((t) => t != null);
  if (times.length === 0) return null;
  return { start: Math.min(...times), end: Math.max(...times) };
}

// packages/importers/src/importer.ts
var IMPORTER_VERSION = "importer-v1";
function runImport(db, inputFiles, opts = {}) {
  const repo = new Repository(db);
  const now = opts.now ?? Date.now();
  const toleranceMs = opts.toleranceMs ?? DEFAULT_ASSOCIATION_TOLERANCE_MS;
  const files = [];
  for (const f of inputFiles) {
    if (f.name.toLowerCase().endsWith(".zip")) {
      files.push(...extractZip(f.data));
    } else {
      files.push(f);
    }
  }
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const counts = {
    imported: 0,
    skippedDuplicates: 0,
    quarantined: 0,
    workoutsCreated: 0,
    workoutsUpdated: 0
  };
  const quarantinedFiles = [];
  const batchId = repo.transaction(() => {
    const id = repo.createBatch(IMPORTER_VERSION, now);
    for (const file of files) {
      const hash = sha256Hex(file.data);
      const existing = repo.findSourceFileByHash(hash);
      const safeName = sanitizeName(file.name);
      if (existing) {
        counts.skippedDuplicates++;
        continue;
      }
      let parsed;
      try {
        parsed = parseFile(file, opts.timeZone);
      } catch (err) {
        const code = err instanceof AdapterError ? err.code : err instanceof ZipError ? err.code : "io_error";
        repo.insertSourceFile({
          batchId: id,
          sha256: hash,
          originalName: safeName,
          detectedType: "unknown",
          parserVersion: ADAPTER_VERSION,
          status: "quarantined",
          errorCode: code,
          sizeBytes: file.data.length
        });
        counts.quarantined++;
        quarantinedFiles.push({ name: safeName, code });
        continue;
      }
      const range = sampleTimeRange(parsed);
      if (!range) {
        repo.insertSourceFile({
          batchId: id,
          sha256: hash,
          originalName: safeName,
          detectedType: "unknown",
          parserVersion: ADAPTER_VERSION,
          status: "quarantined",
          errorCode: "timestamps_invalid",
          sizeBytes: file.data.length
        });
        counts.quarantined++;
        quarantinedFiles.push({ name: safeName, code: "timestamps_invalid" });
        continue;
      }
      const detectedType = parsed.kind === "metric" ? `metric:${parsed.metric}` : `route:${parsed.format}`;
      const sourceFileId = repo.insertSourceFile({
        batchId: id,
        sha256: hash,
        originalName: safeName,
        detectedType,
        parserVersion: ADAPTER_VERSION,
        status: "imported",
        sizeBytes: file.data.length
      });
      const candidate = repo.findCandidateWorkout(
        parsed.workoutType,
        range.start,
        range.end,
        toleranceMs
      );
      let workoutId;
      if (candidate) {
        workoutId = candidate.id;
        repo.extendWorkoutSpan(workoutId, range.start, range.end);
        counts.workoutsUpdated++;
      } else {
        workoutId = repo.createWorkout(parsed.workoutType, range.start, range.end, "import");
        counts.workoutsCreated++;
      }
      if (parsed.kind === "metric") {
        repo.insertMetricSeries({
          workoutId,
          sourceFileId,
          metric: parsed.metric,
          unit: CANONICAL_UNITS[parsed.metric],
          source: parsed.source,
          samples: parsed.samples
        });
      } else {
        const existingFormat = repo.workoutRouteFormat(workoutId);
        if (existingFormat === void 0) {
          repo.insertRoute({
            workoutId,
            sourceFileId,
            format: parsed.format,
            segments: parsed.segments,
            distanceM: null
          });
        } else if (existingFormat === "csv" && parsed.format === "gpx") {
          repo.deleteRoutesForWorkout(workoutId);
          repo.insertRoute({
            workoutId,
            sourceFileId,
            format: "gpx",
            segments: parsed.segments,
            distanceM: null
          });
        }
      }
      counts.imported++;
    }
    repo.finishBatch(id, "committed", counts);
    return id;
  });
  return { batchId, ...counts, quarantinedFiles };
}
function parseFile(file, timeZone) {
  const lower = file.name.toLowerCase();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(file.data);
  if (lower.endsWith(".gpx")) return parseHaeGpx(file.name, text);
  if (lower.endsWith(".csv")) {
    if (!parseHaeFilename(file.name)) {
      throw new AdapterError("unsupported_file_type", "filename not recognized");
    }
    return parseHaeCsv(file.name, text, timeZone ? { timeZone } : {});
  }
  throw new AdapterError("unsupported_file_type", "extension not supported");
}
function sanitizeName(name) {
  return name.split(/[\\/]/).filter(Boolean).pop() ?? "unnamed";
}

// apps/cli/src/index.ts
var USAGE = [
  "Usage:",
  "  velograph-import import <file|dir|zip>... [--data-dir <dir>]",
  "  velograph-import delete <workoutId> [--data-dir <dir>]",
  "  velograph-import backup <destPath> [--data-dir <dir>]",
  "  velograph-import restore <backupPath> [--data-dir <dir>]",
  "  velograph-import repair <workoutId> [--data-dir <dir>]"
].join("\n");
function collectFiles(paths) {
  const files = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync2(p).sort()) {
        const full = join4(p, entry);
        if (!statSync(full).isFile()) continue;
        if (/\.(csv|gpx|zip)$/i.test(entry)) {
          files.push({ name: entry, data: readFileSync2(full) });
        }
      }
    } else {
      files.push({ name: importFileName(p), data: readFileSync2(p) });
    }
  }
  return files;
}
function importFileName(path) {
  return basename(path.replaceAll("\\", "/"));
}
function extractDataDirOverride(args) {
  const rest = [...args];
  const indexes = rest.flatMap((value, index) => value === "--data-dir" ? [index] : []);
  if (indexes.length === 0) return { rest, dataDir: void 0, valid: true };
  if (indexes.length !== 1) return { rest, dataDir: void 0, valid: false };
  const idx = indexes[0];
  const dataDir = rest[idx + 1];
  if (dataDir === void 0 || dataDir.trim() === "" || dataDir.startsWith("--")) {
    return { rest, dataDir: void 0, valid: false };
  }
  rest.splice(idx, 2);
  return { rest, dataDir, valid: true };
}
function runImportCmd(args) {
  if (args.length === 0) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const db = openDatabase(databasePath(dataDir));
  try {
    const files = collectFiles(args);
    if (files.length === 0) {
      console.error("No importable files found (.csv, .gpx, .zip)");
      return 2;
    }
    const result = runImport(db, files, { timeZone: systemTimeZone() });
    console.log(
      [
        `Batch ${result.batchId} committed`,
        `  imported files:     ${result.imported}`,
        `  duplicates skipped: ${result.skippedDuplicates}`,
        `  quarantined:        ${result.quarantined}`,
        `  workouts created:   ${result.workoutsCreated}`
      ].join("\n")
    );
    for (const q of result.quarantinedFiles) {
      console.log(`  quarantined: ${q.name} [${q.code}]`);
    }
    return 0;
  } finally {
    db.close();
  }
}
function runDeleteCmd(args) {
  const id = Number(args[0]);
  if (!args[0] || !Number.isInteger(id)) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const db = openDatabase(databasePath(dataDir));
  try {
    const result = new Repository(db).deleteWorkout(id);
    if (!result) {
      console.error(`Workout ${id} not found`);
      return 1;
    }
    console.log(
      `Deleted workout ${id} (removed ${result.removedSourceFileIds.length} exclusive source file record(s))`
    );
    return 0;
  } finally {
    db.close();
  }
}
function runRepairCmd(args) {
  const id = Number(args[0]);
  if (!args[0] || !Number.isInteger(id)) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const db = openDatabase(databasePath(dataDir));
  try {
    const analytics = repairWorkout(db, id, Date.now());
    if (!analytics) {
      console.error(`Workout ${id} not found`);
      return 1;
    }
    console.log(`Repaired workout ${id} (formula ${analytics.formulaVersion})`);
    return 0;
  } finally {
    db.close();
  }
}
async function runBackupCmd(args) {
  const dest = args[0];
  if (!dest) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const db = openDatabase(databasePath(dataDir));
  try {
    const result = await backupDatabase(db, dest);
    console.log(`Backup written (${result.totalPages} page(s))`);
    return 0;
  } catch (err) {
    console.error(`Backup failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return 1;
  } finally {
    db.close();
  }
}
async function runRestoreCmd(args) {
  const source = args[0];
  if (!source) {
    console.log(USAGE);
    return 2;
  }
  const dataDir = resolveDataDir();
  const dbPath = databasePath(dataDir);
  const db = openDatabase(dbPath);
  try {
    const restored = await restoreDatabase(db, dbPath, source);
    restored.close();
    console.log("Database restored from backup");
    return 0;
  } catch (err) {
    console.error(`Restore failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return 1;
  }
}
async function main(argv) {
  const args = [...argv];
  const cmd = args.shift();
  const { rest, dataDir, valid } = extractDataDirOverride(args);
  if (!valid) {
    console.log(USAGE);
    return 2;
  }
  if (dataDir !== void 0) process.env["VELO_DATA_DIR"] = dataDir;
  switch (cmd) {
    case "import":
      return runImportCmd(rest);
    case "delete":
      return runDeleteCmd(rest);
    case "repair":
      return runRepairCmd(rest);
    case "backup":
      return runBackupCmd(rest);
    case "restore":
      return runRestoreCmd(rest);
    default:
      console.log(USAGE);
      return 2;
  }
}
export {
  importFileName,
  main
};
