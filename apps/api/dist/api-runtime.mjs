// apps/api/src/server.ts
import { createServer } from "node:http";
import { existsSync as existsSync4, readFileSync as readFileSync2, statSync as statSync4 } from "node:fs";
import { extname, join as join6, normalize } from "node:path";

// packages/db/src/database.ts
import DatabaseConstructor from "better-sqlite3";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// packages/db/src/migrate.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  const date = /* @__PURE__ */ new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}
function isValidWallTime(parts) {
  if (parts.year < 0 || parts.year > 9999 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59 || parts.second < 0 || parts.second > 59 || parts.millisecond < 0 || parts.millisecond > 999) {
    return false;
  }
  const instant = wallTimeAsUtc(parts);
  if (!Number.isFinite(instant)) return false;
  const roundTrip = new Date(instant);
  return roundTrip.getUTCFullYear() === parts.year && roundTrip.getUTCMonth() + 1 === parts.month && roundTrip.getUTCDate() === parts.day && roundTrip.getUTCHours() === parts.hour && roundTrip.getUTCMinutes() === parts.minute && roundTrip.getUTCSeconds() === parts.second && roundTrip.getUTCMilliseconds() === parts.millisecond;
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
      const offsetHour = Number(digits.slice(0, 2));
      const offsetMinute = Number(digits.slice(2, 4));
      if (offsetHour > 14 || offsetMinute > 59 || offsetHour === 14 && offsetMinute !== 0) {
        return null;
      }
      offsetMin = sign * (offsetHour * 60 + offsetMinute);
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
  if (!isValidWallTime(parts)) return null;
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

// packages/shared/src/version.ts
var APP_VERSION = "0.1.0";

// packages/shared/src/import-limits.ts
var DEFAULT_IMPORT_UPLOAD_LIMITS = {
  maxFiles: 128,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalDecodedBytes: 64 * 1024 * 1024,
  maxBodyBytes: 88 * 1024 * 1024,
  maxNameLength: 255,
  maxIdLength: 64
};

// packages/db/src/migrate.ts
var LEGACY_FILENAME_ONLY_CHECKSUMS = {
  "0001_init.sql": "788d5ec37f21e6963c8c8e8241d6984400e7249433dbd1919242d7fe4931f242"
};
function listMigrationFiles(dir) {
  const files = readdirSync(dir).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  const sequenceIds = /* @__PURE__ */ new Set();
  for (const file of files) {
    const sequenceId = file.slice(0, 4);
    if (sequenceIds.has(sequenceId)) {
      throw new Error("migration_files_invalid");
    }
    sequenceIds.add(sequenceId);
  }
  return files;
}
function listMigrations(dir) {
  return listMigrationFiles(dir).map((name) => ({
    name,
    checksum: sha256Hex(readFileSync(join(dir, name)))
  }));
}
function isOrderedMigrationPrefix(recorded, available) {
  return recorded.length <= available.length && recorded.every((migration, index) => migration === available[index]);
}
function applyMigrations(db, dir) {
  const migrations = listMigrations(dir);
  const prepareHistory = db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
    );
    const columns = db.prepare("PRAGMA table_info(schema_migrations)").all();
    if (!columns.some((column) => column.name === "checksum")) {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    }
    const applied = db.prepare(
      "SELECT name, applied_at AS appliedAt, checksum FROM schema_migrations ORDER BY rowid"
    ).all();
    if (!isOrderedMigrationPrefix(
      applied.map((row) => row.name),
      migrations.map((migration) => migration.name)
    )) {
      throw new Error("migration_history_invalid");
    }
    for (const [index, row] of applied.entries()) {
      const expected = migrations[index];
      if (row.checksum !== null) {
        if (row.checksum !== expected.checksum) {
          throw new Error("migration_checksum_mismatch");
        }
        continue;
      }
      const releasedChecksum = LEGACY_FILENAME_ONLY_CHECKSUMS[row.name];
      if (releasedChecksum === void 0) {
        throw new Error("migration_checksum_missing");
      }
      if (expected.checksum !== releasedChecksum) {
        throw new Error("migration_checksum_mismatch");
      }
    }
    const adopt = db.prepare("UPDATE schema_migrations SET checksum = ? WHERE name = ?");
    for (const [index, row] of applied.entries()) {
      if (row.checksum === null) {
        adopt.run(migrations[index].checksum, row.name);
      }
    }
    return applied.length;
  });
  const appliedCount = prepareHistory();
  const ran = [];
  for (const migration of migrations.slice(appliedCount)) {
    const sql = readFileSync(join(dir, migration.name), "utf8");
    const runOne = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)").run(
        migration.name,
        Date.now(),
        migration.checksum
      );
    });
    runOne();
    ran.push(migration.name);
  }
  return ran;
}
function readAppliedMigrations(db) {
  const columns = db.prepare("PRAGMA table_info(schema_migrations)").all();
  const hasChecksum = columns.some((column) => column.name === "checksum");
  const rows = db.prepare(
    hasChecksum ? "SELECT name, applied_at AS appliedAt, checksum FROM schema_migrations ORDER BY rowid" : "SELECT name, applied_at AS appliedAt, NULL AS checksum FROM schema_migrations ORDER BY rowid"
  ).all();
  return rows.map((row) => {
    if (typeof row.name !== "string" || typeof row.appliedAt !== "number" || !Number.isSafeInteger(row.appliedAt) || row.appliedAt < 0 || typeof row.checksum !== "string" || !/^[a-f0-9]{64}$/.test(row.checksum)) {
      throw new Error("migration_history_invalid");
    }
    return {
      name: row.name,
      appliedAt: row.appliedAt,
      checksum: row.checksum
    };
  });
}

// packages/db/src/database.ts
var MIGRATIONS_DIR = join2(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
function openDatabase(path) {
  const db = new DatabaseConstructor(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    applyMigrations(db, MIGRATIONS_DIR);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
    }
    throw error;
  }
}
function checkpointDatabase(db) {
  const rows = db.pragma("wal_checkpoint(TRUNCATE)");
  if (rows[0]?.busy !== 0) {
    throw new Error("wal_checkpoint_busy");
  }
}

// packages/db/src/datadir.ts
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname as dirname2, isAbsolute, join as join3, resolve } from "node:path";
var INVALID_DATA_PATH = "invalid_data_path";
var DATA_PATH_INSIDE_CHECKOUT = "data_path_inside_checkout";
function isMissingPathError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function validateMissingComponent(component) {
  if (component === "" || component === "." || component === ".." || component.includes("\0")) {
    throw new Error(INVALID_DATA_PATH);
  }
}
function canonicalizeDataPath(path) {
  let cursor = resolve(path);
  const missing = [];
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (missing.length > 0 && !stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error(INVALID_DATA_PATH);
      }
      let canonicalAncestor;
      try {
        canonicalAncestor = realpathSync(cursor);
      } catch {
        throw new Error(INVALID_DATA_PATH);
      }
      return missing.reduce(
        (candidate, component) => join3(candidate, component),
        canonicalAncestor
      );
    } catch (error) {
      if (!isMissingPathError(error)) {
        if (error instanceof Error && error.message === INVALID_DATA_PATH) throw error;
        throw new Error(INVALID_DATA_PATH);
      }
      const parent = dirname2(cursor);
      if (parent === cursor) throw new Error(INVALID_DATA_PATH);
      const component = basename(cursor);
      validateMissingComponent(component);
      missing.unshift(component);
      cursor = parent;
    }
  }
}
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
  const canonicalDir = guardAgainstCheckout(dir);
  try {
    mkdirSync(canonicalDir, { recursive: true });
  } catch {
    throw new Error(INVALID_DATA_PATH);
  }
  return guardAgainstCheckout(canonicalDir);
}
function guardAgainstCheckout(path) {
  const canonicalPath = canonicalizeDataPath(path);
  let cursor = canonicalPath;
  while (true) {
    if (existsSync(join3(cursor, ".git"))) {
      throw new Error(DATA_PATH_INSIDE_CHECKOUT);
    }
    const parent = dirname2(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return canonicalPath;
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
    return this.db.prepare(
      `SELECT id, status, parser_version AS parserVersion, detected_type AS detectedType
         FROM source_files WHERE sha256 = ?`
    ).get(sha256);
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
  /** Reuse the hash-unique inventory row when its parser version changes. */
  updateSourceFile(sourceFileId, row) {
    const result = this.db.prepare(
      `UPDATE source_files SET
           batch_id = ?, original_name = ?, detected_type = ?, parser_version = ?,
           status = ?, error_code = ?, size_bytes = ?
         WHERE id = ?`
    ).run(
      row.batchId,
      row.originalName,
      row.detectedType,
      row.parserVersion,
      row.status,
      row.errorCode ?? null,
      row.sizeBytes,
      sourceFileId
    );
    if (result.changes !== 1) throw new Error("source_file_not_found");
  }
  /**
   * Record a value-free parser-upgrade failure without changing the canonical
   * source row or its last-known-good normalized data.
   */
  recordSourceFileReprocessingFailure(row) {
    const result = this.db.prepare(
      `INSERT INTO source_file_reprocessing_failures
           (source_file_id, batch_id, attempted_parser_version, error_code, created_at)
         VALUES (?, ?, ?, ?, ?)`
    ).run(row.sourceFileId, row.batchId, row.attemptedParserVersion, row.errorCode, row.createdAt);
    return Number(result.lastInsertRowid);
  }
  /** Distinct workouts that own one source, including provenance-only relationships. */
  workoutIdsForSourceFile(sourceFileId) {
    const rows = this.db.prepare(
      `SELECT workout_id AS id FROM workout_source_files WHERE source_file_id = ?
         UNION
         SELECT workout_id AS id FROM metric_series WHERE source_file_id = ?
         UNION
         SELECT workout_id AS id FROM routes WHERE source_file_id = ?
         ORDER BY id`
    ).all(sourceFileId, sourceFileId, sourceFileId);
    return rows.map((row) => row.id);
  }
  /** Record source provenance even when its normalized geometry is superseded or ignored. */
  linkSourceFileToWorkout(workoutId, sourceFileId) {
    this.db.prepare(
      `INSERT OR IGNORE INTO workout_source_files (workout_id, source_file_id)
         VALUES (?, ?)`
    ).run(workoutId, sourceFileId);
  }
  /**
   * Remove normalized rows owned by one source before a parser-version
   * reprocessing pass. Empty workout shells are retained so successful
   * replacement can preserve stable identity and user-authored children;
   * callers must always invoke finalizeSourceFileReprocessing before commit.
   */
  detachSourceFileData(sourceFileId) {
    const workoutIds = this.workoutIdsForSourceFile(sourceFileId);
    this.db.prepare("DELETE FROM metric_series WHERE source_file_id = ?").run(sourceFileId);
    this.db.prepare("DELETE FROM routes WHERE source_file_id = ?").run(sourceFileId);
    const hasNormalizedData = this.db.prepare(
      `SELECT 1 AS present FROM metric_series WHERE workout_id = ?
       UNION ALL
       SELECT 1 AS present FROM routes WHERE workout_id = ?
       LIMIT 1`
    );
    for (const workoutId of workoutIds) {
      this.invalidateWorkoutDerivedOutputs(workoutId);
      if (hasNormalizedData.get(workoutId, workoutId) !== void 0) {
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
  finalizeSourceFileReprocessing(workoutIds) {
    for (const workoutId of workoutIds) {
      this.recomputeWorkoutSpan(workoutId);
    }
  }
  /** Inputs changed: cached deterministic and narrative outputs are no longer current. */
  invalidateWorkoutDerivedOutputs(workoutId) {
    this.db.prepare("DELETE FROM analytics_snapshots WHERE workout_id = ?").run(workoutId);
    this.db.prepare("DELETE FROM insight_runs WHERE workout_id = ?").run(workoutId);
  }
  /**
   * Find every workout of this type whose time span overlaps or lies within
   * `toleranceMs` of [start, end] (IMP-005 association). Returning every
   * candidate is essential: ambiguity must be quarantined, never hidden by an
   * arbitrary earliest-row choice.
   */
  findCandidateWorkouts(type, start, end, toleranceMs) {
    return this.db.prepare(
      `SELECT * FROM workouts
         WHERE type = ? AND start_utc <= ? AND end_utc >= ?
         ORDER BY start_utc, id`
    ).all(type, end + toleranceMs, start - toleranceMs);
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
    const seriesId = this.createMetricSeries({
      workoutId: row.workoutId,
      sourceFileId: row.sourceFileId,
      metric: row.metric,
      unit: row.unit,
      source: row.source,
      startUtc: first.t,
      endUtc: last.t,
      sampleCount: row.samples.length
    });
    this.insertMetricSampleChunk(seriesId, row.samples);
    return seriesId;
  }
  createMetricSeries(row) {
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
      row.startUtc,
      row.endUtc,
      row.sampleCount
    );
    return Number(r.lastInsertRowid);
  }
  insertMetricSampleChunk(seriesId, samples) {
    const ins = this.db.prepare(
      `INSERT INTO metric_samples (series_id, t_utc, value, value_min, value_max, context)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of samples) {
      ins.run(seriesId, s.t, s.value, s.min ?? null, s.max ?? null, s.context ?? null);
    }
  }
  insertRoute(row) {
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
    if (pointCount === 0) throw new Error("route_has_no_points");
    const bounds = { latMin, latMax, lonMin, lonMax };
    const routeId = this.createRoute({
      workoutId: row.workoutId,
      sourceFileId: row.sourceFileId,
      format: row.format,
      pointCount,
      distanceM: row.distanceM,
      bounds
    });
    row.segments.forEach((segment, segIdx) => {
      this.insertRoutePointChunk(routeId, segIdx, 0, segment.points);
    });
    return routeId;
  }
  createRoute(row) {
    const r = this.db.prepare(
      `INSERT INTO routes (workout_id, source_file_id, source_format, point_count, distance_m, bounds_json)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      row.workoutId,
      row.sourceFileId,
      row.format,
      row.pointCount,
      row.distanceM,
      JSON.stringify(row.bounds)
    );
    return Number(r.lastInsertRowid);
  }
  insertRoutePointChunk(routeId, segmentIndex, startSeq, points) {
    const ins = this.db.prepare(
      `INSERT INTO route_points
         (route_id, segment, seq, t_utc, lat, lon, ele_m, speed_ms, course_deg, hacc_m, vacc_m)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        p.vAcc ?? null
      );
    });
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
  /**
   * Distinct source inventory owned by a workout, including superseded and
   * fallback-only route files whose normalized geometry is not active.
   */
  sourceFileIdsForWorkout(workoutId) {
    const rows = this.db.prepare(
      `SELECT source_file_id AS id FROM workout_source_files WHERE workout_id = ?
         UNION
         SELECT source_file_id AS id FROM metric_series WHERE workout_id = ?
         UNION
         SELECT source_file_id AS id FROM routes WHERE workout_id = ?
         ORDER BY id`
    ).all(workoutId, workoutId, workoutId);
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
  deleteWorkout(workoutId) {
    return this.transaction(() => {
      if (!this.getWorkout(workoutId)) return null;
      const candidateIds = this.sourceFileIdsForWorkout(workoutId);
      this.db.prepare("DELETE FROM workouts WHERE id = ?").run(workoutId);
      const stillReferenced = this.db.prepare(
        `SELECT 1 AS x FROM workout_source_files WHERE source_file_id = ?
         UNION ALL
         SELECT 1 AS x FROM metric_series WHERE source_file_id = ?
         UNION ALL
         SELECT 1 AS x FROM routes WHERE source_file_id = ?
         LIMIT 1`
      );
      const deleteSourceFile = this.db.prepare("DELETE FROM source_files WHERE id = ?");
      const removedSourceFileIds = [];
      for (const id of candidateIds) {
        if (stillReferenced.get(id, id, id) === void 0) {
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
  deleteAllData() {
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
var AnalyticsSnapshotConflictError = class extends Error {
  code = "analytics_snapshot_conflict";
  constructor() {
    super("analytics_snapshot_conflict");
    this.name = "AnalyticsSnapshotConflictError";
  }
};
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
  const route2 = [];
  const routeRows = db.prepare("SELECT id FROM routes WHERE workout_id = ? ORDER BY id").all(workoutId);
  const loadRoutePoints = db.prepare(
    `SELECT segment, t_utc, lat, lon, ele_m, speed_ms, course_deg
     FROM route_points WHERE route_id = ? ORDER BY segment, seq, id`
  );
  for (const routeRow of routeRows) {
    const points = loadRoutePoints.all(routeRow.id);
    let currentSeg;
    for (const p of points) {
      if (p.segment !== currentSeg) {
        route2.push({ points: [] });
        currentSeg = p.segment;
      }
      const point = {
        t: p.t_utc,
        lat: p.lat,
        lon: p.lon
      };
      if (p.ele_m != null) point.ele = p.ele_m;
      if (p.speed_ms != null) point.speed = p.speed_ms;
      if (p.course_deg != null) point.course = p.course_deg;
      route2[route2.length - 1].points.push(point);
    }
  }
  return {
    workout: { id: w.id, type: w.type, startUtc: w.start_utc, endUtc: w.end_utc },
    metrics,
    route: route2
  };
}
function saveAnalyticsSnapshot(db, row) {
  return db.transaction(() => {
    const inserted = db.prepare(
      `INSERT INTO analytics_snapshots
           (workout_id, scope, formula_version, settings_hash, input_hash, result_json, created_at)
         VALUES (?, 'workout', ?, ?, ?, ?, ?)
         ON CONFLICT (workout_id, scope, formula_version, settings_hash, input_hash)
         DO NOTHING`
    ).run(
      row.workoutId,
      row.formulaVersion,
      row.settingsHash,
      row.inputHash,
      row.resultJson,
      row.createdAt
    );
    if (inserted.changes === 1) return "inserted";
    const existing = db.prepare(
      `SELECT result_json FROM analytics_snapshots
         WHERE workout_id = ? AND scope = 'workout' AND formula_version = ?
           AND settings_hash = ? AND input_hash = ?`
    ).get(row.workoutId, row.formulaVersion, row.settingsHash, row.inputHash);
    if (!existing || existing.result_json !== row.resultJson) {
      throw new AnalyticsSnapshotConflictError();
    }
    return "existing";
  })();
}
function getAnalyticsSnapshot(db, workoutId, formulaVersion, settingsHash, inputHash) {
  const r = db.prepare(
    `SELECT result_json FROM analytics_snapshots
       WHERE workout_id = ? AND scope = 'workout' AND formula_version = ?
         AND settings_hash = ? AND input_hash = ?`
  ).get(workoutId, formulaVersion, settingsHash, inputHash);
  return r?.result_json;
}

// packages/db/src/backup.ts
import DatabaseConstructor2 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync as existsSync2,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  openSync,
  realpathSync as realpathSync2,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { basename as basename2, dirname as dirname3, join as join4, resolve as resolve2 } from "node:path";

// packages/db/src/backup-manifest.ts
import { createHash as createHash2 } from "node:crypto";
var BACKUP_FORMAT_VERSION = 1;
var BACKUP_INCLUDED_CATEGORIES = {
  analytics: true,
  credentials: false,
  normalizedData: true,
  notesAndTags: true,
  rawSourceFiles: false,
  settings: true,
  sourceMetadata: true
};
var BackupManifestError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "BackupManifestError";
    this.code = code;
  }
};
function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}
function updateLengthPrefixed(hash, value) {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}
function updateValue(hash, value) {
  if (value === null) {
    hash.update("null");
    return;
  }
  if (typeof value === "string") {
    hash.update("string");
    updateLengthPrefixed(hash, Buffer.from(value, "utf8"));
    return;
  }
  if (typeof value === "number") {
    hash.update("number");
    hash.update(Object.is(value, -0) ? "-0" : String(value));
    return;
  }
  if (typeof value === "bigint") {
    hash.update("bigint");
    hash.update(value.toString());
    return;
  }
  if (value instanceof Uint8Array) {
    hash.update("bytes");
    updateLengthPrefixed(hash, value);
    return;
  }
  throw new BackupManifestError("invalid_backup_manifest");
}
function tableChecksum(db, table) {
  const quotedTable = quoteIdentifier(table);
  const columns = db.prepare(`PRAGMA table_info(${quotedTable})`).all();
  if (columns.length === 0) throw new BackupManifestError("invalid_backup_manifest");
  const primaryKey = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => quoteIdentifier(column.name));
  const orderBy = primaryKey.length > 0 ? primaryKey.join(", ") : "rowid";
  const selected = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const statement = db.prepare(`SELECT ${selected} FROM ${quotedTable} ORDER BY ${orderBy}`).raw().safeIntegers();
  const hash = createHash2("sha256");
  updateLengthPrefixed(hash, Buffer.from(table, "utf8"));
  updateLengthPrefixed(
    hash,
    Buffer.from(stableStringify(columns.map(({ name, pk }) => ({ name, pk }))), "utf8")
  );
  for (const row of statement.iterate()) {
    hash.update("row");
    for (const value of row) updateValue(hash, value);
  }
  return hash.digest("hex");
}
function dataTables(db) {
  return db.prepare(
    `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
           AND substr(name, 1, 7) <> 'sqlite_'
           AND name <> 'backup_manifests'
         ORDER BY name`
  ).all().map((row) => row.name);
}
function calculateTableChecksums(db) {
  return Object.fromEntries(dataTables(db).map((table) => [table, tableChecksum(db, table)]));
}
function writeBackupManifest(db, createdAt = Date.now()) {
  const migrations = readAppliedMigrations(db);
  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    schemaVersion: migrations.at(-1)?.name ?? "uninitialized",
    createdAt,
    includedCategories: BACKUP_INCLUDED_CATEGORIES,
    checksums: {
      algorithm: "sha256",
      tables: calculateTableChecksums(db)
    }
  };
  db.transaction(() => {
    db.prepare("DELETE FROM backup_manifests").run();
    db.prepare(
      `INSERT INTO backup_manifests (
        id,
        format_version,
        app_version,
        schema_version,
        created_at,
        included_categories_json,
        checksums_json,
        manifest_checksum
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      manifest.formatVersion,
      manifest.appVersion,
      manifest.schemaVersion,
      manifest.createdAt,
      stableStringify(manifest.includedCategories),
      stableStringify(manifest.checksums),
      sha256Hex(stableStringify(manifest))
    );
  })();
  return manifest;
}
function parseObject(value) {
  if (typeof value !== "string") throw new BackupManifestError("invalid_backup_manifest");
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BackupManifestError("invalid_backup_manifest");
    }
    return parsed;
  } catch (error) {
    if (error instanceof BackupManifestError) throw error;
    throw new BackupManifestError("invalid_backup_manifest");
  }
}
function readManifest(db) {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'backup_manifests'").get();
  if (!table) return null;
  const rows = db.prepare(
    `SELECT
        id,
        format_version AS formatVersion,
        app_version AS appVersion,
        schema_version AS schemaVersion,
        created_at AS createdAt,
        included_categories_json AS includedCategoriesJson,
        checksums_json AS checksumsJson,
        manifest_checksum AS manifestChecksum
       FROM backup_manifests`
  ).all();
  if (rows.length !== 1) throw new BackupManifestError("invalid_backup_manifest");
  const row = rows[0];
  if (row.id !== 1 || typeof row.formatVersion !== "number" || !Number.isSafeInteger(row.formatVersion) || typeof row.appVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(row.appVersion) || typeof row.schemaVersion !== "string" || !/^\d{4}_.+\.sql$/.test(row.schemaVersion) || typeof row.createdAt !== "number" || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || typeof row.manifestChecksum !== "string" || !/^[a-f0-9]{64}$/.test(row.manifestChecksum)) {
    throw new BackupManifestError("invalid_backup_manifest");
  }
  if (row.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupManifestError("incompatible_backup_format");
  }
  const included = parseObject(row.includedCategoriesJson);
  if (stableStringify(included) !== stableStringify(BACKUP_INCLUDED_CATEGORIES)) {
    throw new BackupManifestError("invalid_backup_manifest");
  }
  const checksumContainer = parseObject(row.checksumsJson);
  const tables = checksumContainer.tables;
  if (checksumContainer.algorithm !== "sha256" || !tables || typeof tables !== "object" || Array.isArray(tables) || Object.values(tables).some(
    (checksum) => typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)
  )) {
    throw new BackupManifestError("invalid_backup_manifest");
  }
  const manifest = {
    formatVersion: row.formatVersion,
    appVersion: row.appVersion,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    includedCategories: BACKUP_INCLUDED_CATEGORIES,
    checksums: {
      algorithm: "sha256",
      tables
    }
  };
  if (sha256Hex(stableStringify(manifest)) !== row.manifestChecksum) {
    throw new BackupManifestError("invalid_backup_checksum");
  }
  return manifest;
}
function verifyBackupManifest(db) {
  const manifest = readManifest(db);
  if (!manifest) return { manifest: null, legacyBackup: true };
  const migrations = readAppliedMigrations(db);
  if (manifest.schemaVersion !== (migrations.at(-1)?.name ?? "uninitialized")) {
    throw new BackupManifestError("invalid_backup_manifest");
  }
  const actual = calculateTableChecksums(db);
  if (stableStringify(actual) !== stableStringify(manifest.checksums.tables)) {
    throw new BackupManifestError("invalid_backup_checksum");
  }
  return { manifest, legacyBackup: false };
}

// packages/db/src/backup.ts
var BackupValidationError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "BackupValidationError";
    this.code = code;
  }
};
var RestoreValidationError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "RestoreValidationError";
    this.code = code;
  }
};
var RestoreDatabaseError = class extends Error {
  code;
  recoveredDatabase;
  constructor(code, recoveredDatabase) {
    super(code);
    this.name = "RestoreDatabaseError";
    this.code = code;
    this.recoveredDatabase = recoveredDatabase;
  }
};
var backupDestinationLocks = /* @__PURE__ */ new Map();
var BACKUP_LOCK_RETRY_MS = 25;
var BACKUP_LOCK_DIRECTORY_NAME = ".velograph-backup.lock";
var BACKUP_LOCK_FILENAME = "lock.sqlite3";
function validationGuardAgainstCheckout(path) {
  try {
    guardAgainstCheckout(path);
  } catch {
    throw new BackupValidationError("destination_inside_checkout");
  }
}
function canonicalEntryPath(path) {
  const absolute = resolve2(path);
  try {
    return join4(realpathSync2(dirname3(absolute)), basename2(absolute));
  } catch {
    throw new BackupValidationError("invalid_backup_destination");
  }
}
function fileIdentity(path) {
  try {
    const stats = statSync(path, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return void 0;
  }
}
function identitiesMatch(a, b) {
  return a !== void 0 && b !== void 0 && a.dev === b.dev && a.ino === b.ino;
}
function stableCanonicalDirectory(path, expected) {
  try {
    const stats = lstatSync2(path);
    const identity = lstatSync2(path, { bigint: true });
    return !stats.isSymbolicLink() && stats.isDirectory() && realpathSync2(path) === path && identitiesMatch(expected, { dev: identity.dev, ino: identity.ino });
  } catch {
    return false;
  }
}
function requiredDirectoryIdentity(path) {
  try {
    const stats = lstatSync2(path);
    if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync2(path) !== path) {
      throw new BackupValidationError("invalid_backup_destination");
    }
    const identity = lstatSync2(path, { bigint: true });
    return { dev: identity.dev, ino: identity.ino };
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError("invalid_backup_destination");
  }
}
function assertDestinationDoesNotConflictWithLiveDatabase(db, target) {
  if (db.memory || db.name === "" || db.name === ":memory:") return;
  const liveEntries = /* @__PURE__ */ new Set([canonicalEntryPath(db.name)]);
  try {
    liveEntries.add(realpathSync2(resolve2(db.name)));
  } catch {
    throw new BackupValidationError("invalid_backup_destination");
  }
  const protectedPaths = [...liveEntries].flatMap((livePath) => [
    livePath,
    `${livePath}-wal`,
    `${livePath}-shm`,
    `${livePath}-journal`
  ]);
  const targetIdentity = fileIdentity(target);
  if (protectedPaths.some(
    (protectedPath) => target === protectedPath || identitiesMatch(targetIdentity, fileIdentity(protectedPath))
  )) {
    throw new BackupValidationError("destination_conflicts_with_live_database");
  }
}
function backupLockDirectoryPath(parent) {
  return join4(parent, BACKUP_LOCK_DIRECTORY_NAME);
}
function backupLockFilePath(parent) {
  return join4(backupLockDirectoryPath(parent), BACKUP_LOCK_FILENAME);
}
function pathUsesReservedBackupLockDirectory(path) {
  let current = resolve2(path);
  for (; ; ) {
    if (basename2(current).toLowerCase() === BACKUP_LOCK_DIRECTORY_NAME.toLowerCase()) return true;
    const next = dirname3(current);
    if (next === current) return false;
    current = next;
  }
}
function reservedBackupLockFiles(parent) {
  const lockPath = backupLockFilePath(parent);
  return [lockPath, `${lockPath}-wal`, `${lockPath}-shm`, `${lockPath}-journal`];
}
function assertTargetDoesNotConflictWithBackupLock(target, parent) {
  const reservedPaths = reservedBackupLockFiles(parent);
  const targetIdentity = fileIdentity(target);
  if (pathUsesReservedBackupLockDirectory(target) || reservedPaths.some(
    (reservedPath) => target.toLowerCase() === reservedPath.toLowerCase() || identitiesMatch(targetIdentity, fileIdentity(reservedPath))
  )) {
    throw new BackupValidationError("invalid_backup_destination");
  }
}
function privateLockDirectoryIsStable(lock, parent, parentIdentity) {
  try {
    const descriptorStats = fstatSync(lock.directoryDescriptor);
    const descriptorIdentity = fstatSync(lock.directoryDescriptor, { bigint: true });
    const pathStats = lstatSync2(lock.directoryPath);
    const pathIdentity = lstatSync2(lock.directoryPath, { bigint: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
    return stableCanonicalDirectory(parent, parentIdentity) && descriptorStats.isDirectory() && (descriptorStats.mode & 511) === 448 && (uid === void 0 || descriptorStats.uid === uid) && !pathStats.isSymbolicLink() && pathStats.isDirectory() && (pathStats.mode & 511) === 448 && (uid === void 0 || pathStats.uid === uid) && identitiesMatch(lock.directoryIdentity, {
      dev: descriptorIdentity.dev,
      ino: descriptorIdentity.ino
    }) && identitiesMatch(lock.directoryIdentity, {
      dev: pathIdentity.dev,
      ino: pathIdentity.ino
    });
  } catch {
    return false;
  }
}
function privateLockFileIsStable(lock, parent, parentIdentity) {
  try {
    if (!privateLockDirectoryIsStable(lock, parent, parentIdentity)) return false;
    const descriptorStats = fstatSync(lock.fileDescriptor);
    const descriptorIdentity = fstatSync(lock.fileDescriptor, { bigint: true });
    const pathStats = lstatSync2(lock.filePath);
    const pathIdentity = lstatSync2(lock.filePath, { bigint: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
    return descriptorStats.isFile() && descriptorStats.nlink === 1 && (descriptorStats.mode & 511) === 384 && (uid === void 0 || descriptorStats.uid === uid) && !pathStats.isSymbolicLink() && pathStats.isFile() && pathStats.nlink === 1 && (pathStats.mode & 511) === 384 && (uid === void 0 || pathStats.uid === uid) && identitiesMatch(lock.fileIdentity, {
      dev: descriptorIdentity.dev,
      ino: descriptorIdentity.ino
    }) && identitiesMatch(lock.fileIdentity, {
      dev: pathIdentity.dev,
      ino: pathIdentity.ino
    });
  } catch {
    return false;
  }
}
function preparePrivateBackupLock(parent, parentIdentity) {
  const directoryPath = backupLockDirectoryPath(parent);
  const filePath = backupLockFilePath(parent);
  let directoryDescriptor;
  let fileDescriptor;
  try {
    if (!stableCanonicalDirectory(parent, parentIdentity)) {
      throw new BackupValidationError("invalid_backup_destination");
    }
    try {
      mkdirSync2(directoryPath, { mode: 448 });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw new BackupValidationError("invalid_backup_destination");
      }
    }
    directoryDescriptor = openSync(
      directoryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
    const directoryStats = fstatSync(directoryDescriptor);
    const directoryIdentity = fstatSync(directoryDescriptor, { bigint: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
    if (!directoryStats.isDirectory() || (directoryStats.mode & 511) !== 448 || uid !== void 0 && directoryStats.uid !== uid) {
      throw new BackupValidationError("invalid_backup_destination");
    }
    fchmodSync(directoryDescriptor, 448);
    try {
      fileDescriptor = openSync(
        filePath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        384
      );
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw new BackupValidationError("invalid_backup_destination");
      }
      fileDescriptor = openSync(filePath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    }
    const fileStats = fstatSync(fileDescriptor);
    const fileIdentity2 = fstatSync(fileDescriptor, { bigint: true });
    if (!fileStats.isFile() || fileStats.nlink !== 1 || (fileStats.mode & 511) !== 384 || uid !== void 0 && fileStats.uid !== uid) {
      throw new BackupValidationError("invalid_backup_destination");
    }
    fchmodSync(fileDescriptor, 384);
    const lock = {
      directoryPath,
      directoryIdentity: { dev: directoryIdentity.dev, ino: directoryIdentity.ino },
      directoryDescriptor,
      filePath,
      fileIdentity: { dev: fileIdentity2.dev, ino: fileIdentity2.ino },
      fileDescriptor
    };
    if (!privateLockFileIsStable(lock, parent, parentIdentity)) {
      throw new BackupValidationError("invalid_backup_destination");
    }
    return lock;
  } catch (error) {
    closeDescriptorQuietly(fileDescriptor);
    closeDescriptorQuietly(directoryDescriptor);
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError("invalid_backup_destination");
  }
}
function isSqliteLockContention(error) {
  const code = error?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}
function assertExclusiveLockCoversPreparedFile(lock, parent, parentIdentity) {
  let verifier;
  try {
    if (!privateLockFileIsStable(lock, parent, parentIdentity)) {
      throw new Error("backup_lock_identity_changed");
    }
    verifier = new DatabaseConstructor2(lock.filePath, {
      timeout: 0,
      fileMustExist: true
    });
    if (!privateLockFileIsStable(lock, parent, parentIdentity)) {
      throw new Error("backup_lock_identity_changed");
    }
    let observedExpectedContention = false;
    try {
      verifier.exec("BEGIN EXCLUSIVE");
      verifier.exec("ROLLBACK");
    } catch (error) {
      if (!isSqliteLockContention(error)) throw error;
      observedExpectedContention = true;
    }
    if (!observedExpectedContention) {
      throw new Error("backup_lock_opened_different_inode");
    }
    if (!privateLockFileIsStable(lock, parent, parentIdentity)) {
      throw new Error("backup_lock_identity_changed");
    }
  } finally {
    closeQuietly(verifier);
  }
}
async function acquireCrossProcessBackupLock(parent, parentIdentity, onContention, beforeLockOpen, afterLockOpen) {
  const lock = preparePrivateBackupLock(parent, parentIdentity);
  let lockDb;
  try {
    if (!privateLockFileIsStable(lock, parent, parentIdentity)) {
      throw new Error("backup_lock_identity_changed");
    }
    beforeLockOpen?.();
    lockDb = new DatabaseConstructor2(lock.filePath, {
      timeout: BACKUP_LOCK_RETRY_MS,
      fileMustExist: true
    });
    afterLockOpen?.();
    if (!privateLockFileIsStable(lock, parent, parentIdentity)) {
      throw new Error("backup_lock_identity_changed");
    }
    let reportedContention = false;
    for (; ; ) {
      try {
        if (!privateLockFileIsStable(lock, parent, parentIdentity)) {
          throw new Error("backup_lock_identity_changed");
        }
        lockDb.exec("BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if (!isSqliteLockContention(error)) throw error;
        if (!reportedContention) {
          reportedContention = true;
          onContention?.();
        }
        await new Promise((resolveDelay) => {
          setTimeout(resolveDelay, BACKUP_LOCK_RETRY_MS);
        });
      }
    }
    if (!privateLockFileIsStable(lock, parent, parentIdentity)) {
      throw new Error("backup_lock_identity_changed");
    }
    assertExclusiveLockCoversPreparedFile(lock, parent, parentIdentity);
  } catch {
    closeQuietly(lockDb);
    closeDescriptorQuietly(lock.fileDescriptor);
    closeDescriptorQuietly(lock.directoryDescriptor);
    throw new BackupValidationError("invalid_backup_destination");
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        lockDb?.exec("ROLLBACK");
      } catch {
      }
      closeQuietly(lockDb);
      closeDescriptorQuietly(lock.fileDescriptor);
      closeDescriptorQuietly(lock.directoryDescriptor);
    }
  };
}
function assertBackupParentStable(db, prepared) {
  let currentTarget;
  try {
    currentTarget = canonicalEntryPath(prepared.target);
  } catch {
    throw new BackupValidationError("invalid_backup_destination");
  }
  if (currentTarget !== prepared.target || !stableCanonicalDirectory(prepared.parent, prepared.parentIdentity)) {
    throw new BackupValidationError("invalid_backup_destination");
  }
  assertDestinationDoesNotConflictWithLiveDatabase(db, prepared.target);
}
function backupParentIsStable(db, prepared) {
  try {
    assertBackupParentStable(db, prepared);
    return true;
  } catch {
    return false;
  }
}
async function withBackupDestinationLock(db, prepared, onContention, beforeLockOpen, afterLockOpen, operation) {
  const lockKey = prepared.lockKey;
  const previous = backupDestinationLocks.get(lockKey) ?? Promise.resolve();
  let release;
  const ownTurn = new Promise((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.then(() => ownTurn);
  backupDestinationLocks.set(lockKey, tail);
  await previous;
  let crossProcessLock;
  try {
    assertBackupParentStable(db, prepared);
    crossProcessLock = await acquireCrossProcessBackupLock(
      prepared.parent,
      prepared.parentIdentity,
      onContention,
      beforeLockOpen,
      afterLockOpen
    );
    assertBackupParentStable(db, prepared);
    return await operation();
  } finally {
    crossProcessLock?.release();
    release();
    if (backupDestinationLocks.get(lockKey) === tail) {
      backupDestinationLocks.delete(lockKey);
    }
  }
}
function prepareBackupTarget(db, destPath) {
  const lexicalTarget = resolve2(destPath);
  const lexicalParent = dirname3(lexicalTarget);
  validationGuardAgainstCheckout(lexicalParent);
  assertTargetDoesNotConflictWithBackupLock(lexicalTarget, lexicalParent);
  try {
    mkdirSync2(lexicalParent, { recursive: true });
  } catch {
    throw new BackupValidationError("invalid_backup_destination");
  }
  const target = canonicalEntryPath(lexicalTarget);
  const parent = dirname3(target);
  validationGuardAgainstCheckout(parent);
  assertTargetDoesNotConflictWithBackupLock(target, parent);
  assertDestinationDoesNotConflictWithLiveDatabase(db, target);
  const parentIdentity = requiredDirectoryIdentity(parent);
  return {
    target,
    parent,
    parentIdentity,
    // macOS commonly uses a case-insensitive filesystem. Conservatively lock
    // the verified parent directory rather than a case-sensitive spelling of
    // one entry so aliases cannot acquire independent process locks.
    lockKey: `parent:${parentIdentity.dev}:${parentIdentity.ino}`
  };
}
async function backupDatabase(db, destPath, options = {}) {
  const prepared = prepareBackupTarget(db, destPath);
  return withBackupDestinationLock(
    db,
    prepared,
    options.onLockContention,
    options.beforeLockOpen,
    options.afterLockOpen,
    () => backupDatabaseAtTarget(db, prepared, options)
  );
}
async function backupDatabaseAtTarget(db, prepared, options) {
  const resolved = prepared.target;
  const parent = prepared.parent;
  const syncDirectory = options.syncDirectory ?? fsyncDirectory;
  assertBackupParentStable(db, prepared);
  const hadPrevious = existsSync2(resolved);
  let operationDirectory;
  let stagedPath;
  let previousPath;
  let recoveryPath;
  let installed = false;
  let stagedIdentity;
  let installedIdentity;
  let previousRestored = false;
  let previousSnapshotCreated = false;
  let retainOperationDirectory = false;
  try {
    try {
      operationDirectory = createPrivateOperationDirectory(
        parent,
        prepared.parentIdentity,
        "backup"
      );
      assertBackupOperationStable(db, prepared, operationDirectory);
    } catch (error) {
      if (error instanceof BackupValidationError) throw error;
      throw new BackupValidationError("invalid_backup_destination");
    }
    stagedPath = join4(operationDirectory.path, "stage.sqlite3");
    previousPath = join4(operationDirectory.path, "previous.sqlite3");
    recoveryPath = join4(operationDirectory.path, "recovery.sqlite3");
    if (hadPrevious) {
      assertBackupOperationStable(db, prepared, operationDirectory);
      createPrivateArtifact(previousPath);
      assertBackupOperationStable(db, prepared, operationDirectory);
      copyFileSync(resolved, previousPath);
      chmodSync(previousPath, 384);
      fsyncPath(previousPath);
      previousSnapshotCreated = true;
      assertBackupOperationStable(db, prepared, operationDirectory);
    }
    assertBackupOperationStable(db, prepared, operationDirectory);
    createPrivateArtifact(stagedPath);
    assertBackupOperationStable(db, prepared, operationDirectory);
    let progress;
    try {
      progress = options.stageBackup ? await options.stageBackup(db, stagedPath) : await db.backup(stagedPath);
    } catch (error) {
      if (!backupOperationIsStable(db, prepared, operationDirectory)) {
        throw new BackupValidationError("invalid_backup_destination");
      }
      throw error;
    }
    chmodSync(stagedPath, 384);
    assertBackupOperationStable(db, prepared, operationDirectory);
    let probe;
    let manifest;
    try {
      probe = new DatabaseConstructor2(stagedPath, {
        fileMustExist: true
      });
      validateCanonicalDatabase(probe);
      manifest = writeBackupManifest(probe);
      checkpointDatabase(probe);
    } finally {
      closeQuietly(probe);
    }
    removeSidecars(stagedPath);
    fsyncPath(stagedPath);
    stagedIdentity = requiredRegularFileIdentity(stagedPath);
    assertBackupOperationStable(db, prepared, operationDirectory);
    renameSync(stagedPath, resolved);
    installed = true;
    installedIdentity = stagedIdentity;
    if (!regularFileHasIdentity(resolved, installedIdentity)) {
      throw new BackupValidationError("invalid_backup_destination");
    }
    assertBackupParentStable(db, prepared);
    syncDirectory(parent);
    await options.afterInstall?.();
    assertBackupParentStable(db, prepared);
    return { ...progress, manifest };
  } catch (error) {
    if (installed && operationDirectory && previousPath && recoveryPath && backupOperationIsStable(db, prepared, operationDirectory)) {
      try {
        if (identitiesMatch(installedIdentity, fileIdentity(resolved))) {
          if (hadPrevious) {
            createPrivateArtifact(recoveryPath);
            assertBackupOperationStable(db, prepared, operationDirectory);
            copyFileSync(previousPath, recoveryPath);
            chmodSync(recoveryPath, 384);
            fsyncPath(recoveryPath);
            assertBackupParentStable(db, prepared);
            renameSync(recoveryPath, resolved);
            assertBackupParentStable(db, prepared);
            syncDirectory(parent);
            previousRestored = true;
          } else {
            assertBackupParentStable(db, prepared);
            removeArtifact(resolved);
            syncDirectory(parent);
          }
        }
      } catch {
      }
    }
    retainOperationDirectory = installed && hadPrevious && previousSnapshotCreated && !previousRestored;
    if (!backupParentIsStable(db, prepared) && !(error instanceof BackupValidationError)) {
      throw new BackupValidationError("invalid_backup_destination");
    }
    throw error;
  } finally {
    if (operationDirectory && !retainOperationDirectory) {
      removePrivateOperationDirectory(operationDirectory);
    }
  }
}
var canonicalDefinition;
function schemaSignature(db) {
  const rows = db.prepare(
    `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       WHERE substr(name, 1, 7) <> 'sqlite_'
       ORDER BY type, name, tbl_name`
  ).all();
  return JSON.stringify(rows);
}
function currentCanonicalDefinition() {
  if (canonicalDefinition) return canonicalDefinition;
  const canonical = openDatabase(":memory:");
  try {
    const migrationDescriptors = listMigrations(MIGRATIONS_DIR);
    canonicalDefinition = {
      migrations: migrationDescriptors.map((migration) => migration.name),
      migrationDescriptors,
      schema: schemaSignature(canonical)
    };
    return canonicalDefinition;
  } finally {
    canonical.close();
  }
}
function validateIntegrity(db) {
  let result;
  try {
    result = db.pragma("integrity_check", { simple: true });
  } catch {
    throw new RestoreValidationError("invalid_backup_integrity");
  }
  if (result !== "ok") {
    throw new RestoreValidationError("invalid_backup_integrity");
  }
}
function recordedMigrations(db) {
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!table) throw new RestoreValidationError("invalid_backup_migrations");
    const columns = db.prepare("PRAGMA table_info(schema_migrations)").all();
    const hasChecksum = columns.some((column) => column.name === "checksum");
    const rows = db.prepare(
      hasChecksum ? "SELECT name, applied_at AS appliedAt, checksum FROM schema_migrations ORDER BY rowid" : "SELECT name, applied_at AS appliedAt, NULL AS checksum FROM schema_migrations ORDER BY rowid"
    ).all();
    if (rows.some(
      (row) => typeof row.name !== "string" || typeof row.appliedAt !== "number" || !Number.isSafeInteger(row.appliedAt) || row.appliedAt < 0 || !(row.checksum === null || typeof row.checksum === "string" && /^[a-f0-9]{64}$/.test(row.checksum))
    )) {
      throw new RestoreValidationError("invalid_backup_migrations");
    }
    return rows.map((row) => ({
      name: row.name,
      checksum: row.checksum
    }));
  } catch (error) {
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError("invalid_backup_migrations");
  }
}
function validateMigrationPrefix(db, available) {
  const recorded = recordedMigrations(db);
  if (!isOrderedMigrationPrefix(
    recorded.map((migration) => migration.name),
    available.map((migration) => migration.name)
  )) {
    throw new RestoreValidationError("invalid_backup_migrations");
  }
  recorded.forEach((migration, index) => {
    if (migration.checksum !== null && migration.checksum !== available[index].checksum) {
      throw new RestoreValidationError("invalid_backup_migration");
    }
  });
  return recorded;
}
function validateForeignKeys(db) {
  let foreignKeyViolations;
  try {
    foreignKeyViolations = db.pragma("foreign_key_check");
  } catch {
    throw new RestoreValidationError("invalid_backup_foreign_keys");
  }
  if (foreignKeyViolations.length !== 0) {
    throw new RestoreValidationError("invalid_backup_foreign_keys");
  }
}
function validateCanonicalDatabase(db) {
  const canonical = currentCanonicalDefinition();
  validateIntegrity(db);
  const migrations = validateMigrationPrefix(db, canonical.migrationDescriptors);
  if (migrations.length !== canonical.migrationDescriptors.length || migrations.some(
    (migration, index) => migration.name !== canonical.migrationDescriptors[index].name || migration.checksum !== canonical.migrationDescriptors[index].checksum
  )) {
    throw new RestoreValidationError("invalid_backup_migrations");
  }
  validateForeignKeys(db);
  if (schemaSignature(db) !== canonical.schema) {
    throw new RestoreValidationError("invalid_backup_schema");
  }
}
function openBackupSource(path) {
  let probe;
  try {
    probe = new DatabaseConstructor2(path, { readonly: true, fileMustExist: true });
  } catch {
    throw new RestoreValidationError("invalid_backup_file");
  }
  try {
    validateIntegrity(probe);
    const migrations = validateMigrationPrefix(
      probe,
      currentCanonicalDefinition().migrationDescriptors
    );
    validateForeignKeys(probe);
    const verification = verifyBackupManifest(probe);
    return {
      database: probe,
      manifest: verification.manifest,
      legacyBackup: verification.legacyBackup,
      migrations
    };
  } catch (error) {
    try {
      probe.close();
    } catch {
    }
    if (error instanceof RestoreValidationError) throw error;
    if (error instanceof BackupManifestError) {
      throw new RestoreValidationError(error.code);
    }
    throw new RestoreValidationError("invalid_backup_file");
  }
}
function removeSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${path}${suffix}`;
    if (existsSync2(sidecar)) rmSync(sidecar, { force: true });
  }
}
function fsyncPath(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function fsyncDirectory(path) {
  try {
    fsyncPath(path);
  } catch (error) {
    const code = error.code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM") {
      return;
    }
    throw error;
  }
}
function createPrivateArtifact(path) {
  const fd = openSync(path, "wx", 384);
  try {
    chmodSync(path, 384);
  } finally {
    closeSync(fd);
  }
}
function createPrivateOperationDirectory(parent, parentIdentity, kind) {
  if (!stableCanonicalDirectory(parent, parentIdentity)) {
    throw new Error("operation_parent_invalid");
  }
  const path = join4(parent, `.velograph-${kind}-${randomUUID()}`);
  mkdirSync2(path, { mode: 448 });
  chmodSync(path, 448);
  const stats = lstatSync2(path);
  const identity = lstatSync2(path, { bigint: true });
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 511) !== 448 || uid !== void 0 && stats.uid !== uid) {
    throw new Error("private_operation_directory_invalid");
  }
  if (!stableCanonicalDirectory(parent, parentIdentity)) {
    throw new Error("operation_parent_changed");
  }
  return {
    path,
    parent,
    parentIdentity,
    identity: { dev: identity.dev, ino: identity.ino }
  };
}
function privateOperationDirectoryIsStable(operation) {
  if (!stableCanonicalDirectory(operation.parent, operation.parentIdentity)) return false;
  try {
    const stats = lstatSync2(operation.path);
    const identity = lstatSync2(operation.path, { bigint: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
    return !stats.isSymbolicLink() && stats.isDirectory() && (stats.mode & 511) === 448 && (uid === void 0 || stats.uid === uid) && identitiesMatch(operation.identity, { dev: identity.dev, ino: identity.ino });
  } catch {
    return false;
  }
}
function assertBackupOperationStable(db, prepared, operation) {
  assertBackupParentStable(db, prepared);
  if (!privateOperationDirectoryIsStable(operation)) {
    throw new BackupValidationError("invalid_backup_destination");
  }
}
function backupOperationIsStable(db, prepared, operation) {
  try {
    assertBackupOperationStable(db, prepared, operation);
    return true;
  } catch {
    return false;
  }
}
function removePrivateOperationDirectory(operation) {
  if (!privateOperationDirectoryIsStable(operation)) return;
  try {
    rmSync(operation.path, { recursive: true, force: true });
  } catch {
  }
}
function databaseMetadata(path) {
  const stats = statSync(path);
  return {
    mode: stats.mode & 4095,
    uid: stats.uid,
    gid: stats.gid
  };
}
function applyDatabaseMetadata(path, metadata) {
  const current = statSync(path);
  if (current.uid !== metadata.uid || current.gid !== metadata.gid) {
    chownSync(path, metadata.uid, metadata.gid);
  }
  chmodSync(path, metadata.mode);
}
function applyRecoveryArtifactMetadata(path, metadata) {
  const current = statSync(path);
  if (current.uid !== metadata.uid || current.gid !== metadata.gid) {
    chownSync(path, metadata.uid, metadata.gid);
  }
  chmodSync(path, 384);
}
function closeDescriptorQuietly(descriptor) {
  if (descriptor === void 0) return;
  try {
    closeSync(descriptor);
  } catch {
  }
}
function closeQuietly(db) {
  if (!db?.open) return;
  try {
    db.close();
  } catch {
  }
}
function removeArtifact(path) {
  try {
    removeSidecars(path);
  } catch {
  }
  try {
    if (existsSync2(path)) rmSync(path, { force: true });
  } catch {
  }
}
function normalizePreCutoverError(error) {
  if (error instanceof RestoreValidationError) return error;
  if (error instanceof Error && error.message === "wal_checkpoint_busy") {
    return new RestoreValidationError("restore_checkpoint_busy");
  }
  return new RestoreValidationError("restore_stage_failed");
}
function openAndValidateCanonical(path) {
  let staged;
  try {
    staged = openDatabase(path);
  } catch {
    throw new RestoreValidationError("invalid_backup_migration");
  }
  try {
    validateCanonicalDatabase(staged);
    return staged;
  } catch (error) {
    closeQuietly(staged);
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError("invalid_backup_schema");
  }
}
function requiredRegularFileIdentity(path) {
  const stats = lstatSync2(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("regular_file_identity_invalid");
  }
  const identity = lstatSync2(path, { bigint: true });
  return { dev: identity.dev, ino: identity.ino };
}
function regularFileHasIdentity(path, expected) {
  try {
    const stats = lstatSync2(path);
    const identity = lstatSync2(path, { bigint: true });
    return !stats.isSymbolicLink() && stats.isFile() && identitiesMatch(expected, { dev: identity.dev, ino: identity.ino });
  } catch {
    return false;
  }
}
function prepareRestoreTarget(liveDb, dbPath) {
  try {
    if (!liveDb.open || liveDb.memory || liveDb.name === "" || liveDb.name === ":memory:") {
      throw new Error("restore_requires_file_database");
    }
    const liveTarget = realpathSync2(resolve2(liveDb.name));
    const parent = dirname3(liveTarget);
    const parentIdentity = requiredRawDirectoryIdentity(parent);
    const originalIdentity = requiredRegularFileIdentity(liveTarget);
    const target = realpathSync2(resolve2(dbPath));
    if (target !== liveTarget || !identitiesMatch(originalIdentity, requiredRegularFileIdentity(target))) {
      throw new Error("restore_live_database_mismatch");
    }
    const prepared = {
      target,
      parent,
      parentIdentity,
      originalIdentity
    };
    if (!restoreTargetIsStable(prepared, originalIdentity)) {
      throw new Error("restore_parent_invalid");
    }
    return prepared;
  } catch {
    throw new RestoreValidationError("restore_stage_failed");
  }
}
function requiredRawDirectoryIdentity(path) {
  const stats = lstatSync2(path);
  if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync2(path) !== path) {
    throw new Error("directory_identity_invalid");
  }
  const identity = lstatSync2(path, { bigint: true });
  return { dev: identity.dev, ino: identity.ino };
}
function restoreTargetIsStable(prepared, expectedIdentity) {
  if (!stableCanonicalDirectory(prepared.parent, prepared.parentIdentity)) return false;
  try {
    return realpathSync2(prepared.target) === prepared.target && regularFileHasIdentity(prepared.target, expectedIdentity);
  } catch {
    return false;
  }
}
function assertRestoreTargetStable(prepared, expectedIdentity) {
  if (!restoreTargetIsStable(prepared, expectedIdentity)) {
    throw new Error("restore_target_changed");
  }
}
function restoreOperationIsStable(prepared, operation, expectedIdentity) {
  return restoreTargetIsStable(prepared, expectedIdentity) && privateOperationDirectoryIsStable(operation);
}
function assertRestoreOperationStable(prepared, operation, expectedIdentity) {
  assertRestoreTargetStable(prepared, expectedIdentity);
  if (!privateOperationDirectoryIsStable(operation)) {
    throw new Error("restore_operation_directory_changed");
  }
}
function openExpectedCanonicalDatabase(prepared, expectedIdentity, afterReopen) {
  assertRestoreTargetStable(prepared, expectedIdentity);
  let reopened;
  try {
    reopened = new DatabaseConstructor2(prepared.target, { fileMustExist: true });
    assertRestoreTargetStable(prepared, expectedIdentity);
    if (reopened.memory || reopened.name === "" || reopened.name === ":memory:" || realpathSync2(resolve2(reopened.name)) !== prepared.target) {
      throw new Error("restore_reopen_identity_mismatch");
    }
    validateCanonicalDatabase(reopened);
    reopened.pragma("foreign_keys = ON");
    reopened.pragma("synchronous = NORMAL");
    if (reopened.pragma("journal_mode", { simple: true }) !== "wal") {
      reopened.pragma("journal_mode = WAL");
    }
    afterReopen?.(reopened);
    if (!reopened.open) {
      throw new Error("restore_reopen_closed");
    }
    assertRestoreTargetStable(prepared, expectedIdentity);
    return reopened;
  } catch (error) {
    closeQuietly(reopened);
    throw error;
  }
}
async function reopenOriginal(prepared, operation, rollbackPath, rollbackIdentity, recoveryInstallPath, metadata, replacementInstalled, installedIdentity, afterReopen) {
  if (!replacementInstalled) {
    try {
      return openExpectedCanonicalDatabase(prepared, prepared.originalIdentity, afterReopen);
    } catch {
    }
  }
  const currentIdentity = replacementInstalled ? installedIdentity : prepared.originalIdentity;
  if (!currentIdentity || !restoreOperationIsStable(prepared, operation, currentIdentity) || !regularFileHasIdentity(rollbackPath, rollbackIdentity)) {
    return void 0;
  }
  let source;
  let recoveryProbe;
  try {
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    createPrivateArtifact(recoveryInstallPath);
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    source = new DatabaseConstructor2(rollbackPath, {
      readonly: true,
      fileMustExist: true
    });
    validateCanonicalDatabase(source);
    await source.backup(recoveryInstallPath);
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    if (!regularFileHasIdentity(rollbackPath, rollbackIdentity)) {
      throw new Error("restore_rollback_identity_changed");
    }
    closeQuietly(source);
    source = void 0;
    chmodSync(recoveryInstallPath, 384);
    recoveryProbe = new DatabaseConstructor2(recoveryInstallPath, {
      readonly: true,
      fileMustExist: true
    });
    validateCanonicalDatabase(recoveryProbe);
    recoveryProbe.close();
    recoveryProbe = void 0;
    removeSidecars(recoveryInstallPath);
    applyDatabaseMetadata(recoveryInstallPath, metadata);
    fsyncPath(recoveryInstallPath);
    const recoveryIdentity = requiredRegularFileIdentity(recoveryInstallPath);
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    removeSidecars(prepared.target);
    assertRestoreOperationStable(prepared, operation, currentIdentity);
    renameSync(recoveryInstallPath, prepared.target);
    assertRestoreTargetStable(prepared, recoveryIdentity);
    fsyncDirectory(prepared.parent);
    removeSidecars(prepared.target);
    assertRestoreTargetStable(prepared, recoveryIdentity);
    fsyncDirectory(prepared.parent);
    return openExpectedCanonicalDatabase(prepared, recoveryIdentity, afterReopen);
  } catch {
    return void 0;
  } finally {
    closeQuietly(recoveryProbe);
    closeQuietly(source);
    if (privateOperationDirectoryIsStable(operation)) {
      try {
        removeSidecars(rollbackPath);
      } catch {
      }
    }
  }
}
async function restoreDatabaseWithReport(liveDb, dbPath, backupPath, options = {}) {
  const prepared = prepareRestoreTarget(liveDb, dbPath);
  const resolvedBackup = resolve2(backupPath);
  const sourceInfo = openBackupSource(resolvedBackup);
  const source = sourceInfo.database;
  let operationDirectory;
  let stagedPath;
  let rollbackPath;
  let recoveryInstallPath;
  let staged;
  let rollbackProbe;
  let metadata;
  let stagedIdentity;
  let rollbackIdentity;
  let liveClosed = false;
  let replacementInstalled = false;
  let installedIdentity;
  let retainOperationDirectory = false;
  try {
    try {
      operationDirectory = createPrivateOperationDirectory(
        prepared.parent,
        prepared.parentIdentity,
        "restore"
      );
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    } catch {
      throw new RestoreValidationError("restore_stage_failed");
    }
    stagedPath = join4(operationDirectory.path, "stage.sqlite3");
    rollbackPath = join4(operationDirectory.path, "rollback.sqlite3");
    recoveryInstallPath = join4(operationDirectory.path, "recovery.sqlite3");
    metadata = databaseMetadata(prepared.target);
    try {
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      createPrivateArtifact(stagedPath);
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      if (options.stageBackup) {
        await options.stageBackup(source, stagedPath);
      } else {
        await source.backup(stagedPath);
      }
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      chmodSync(stagedPath, 384);
    } catch {
      throw new RestoreValidationError("restore_stage_failed");
    }
    let preMigration;
    try {
      preMigration = new DatabaseConstructor2(stagedPath, {
        readonly: true,
        fileMustExist: true
      });
      validateIntegrity(preMigration);
      validateMigrationPrefix(preMigration, currentCanonicalDefinition().migrationDescriptors);
    } finally {
      closeQuietly(preMigration);
    }
    staged = openAndValidateCanonical(stagedPath);
    checkpointDatabase(staged);
    staged.close();
    staged = void 0;
    removeSidecars(stagedPath);
    applyDatabaseMetadata(stagedPath, metadata);
    fsyncPath(stagedPath);
    stagedIdentity = requiredRegularFileIdentity(stagedPath);
    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    checkpointDatabase(liveDb);
    try {
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      createPrivateArtifact(rollbackPath);
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      if (options.rollbackBackup) {
        await options.rollbackBackup(liveDb, rollbackPath);
      } else {
        await liveDb.backup(rollbackPath);
      }
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      chmodSync(rollbackPath, 384);
    } catch {
      throw new RestoreValidationError("restore_rollback_failed");
    }
    rollbackProbe = new DatabaseConstructor2(rollbackPath, {
      readonly: true,
      fileMustExist: true
    });
    validateCanonicalDatabase(rollbackProbe);
    rollbackProbe.close();
    rollbackProbe = void 0;
    removeSidecars(rollbackPath);
    applyRecoveryArtifactMetadata(rollbackPath, metadata);
    fsyncPath(rollbackPath);
    rollbackIdentity = requiredRegularFileIdentity(rollbackPath);
    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    try {
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
      await options.beforeSwap?.();
      assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    } catch {
      throw new RestoreValidationError("restore_stage_failed");
    }
    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    try {
      liveDb.close();
      liveClosed = true;
    } catch (error) {
      liveClosed = !liveDb.open;
      throw error;
    }
    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    await options.afterLiveClose?.();
    assertRestoreOperationStable(prepared, operationDirectory, prepared.originalIdentity);
    renameSync(stagedPath, prepared.target);
    replacementInstalled = true;
    installedIdentity = stagedIdentity;
    assertRestoreOperationStable(prepared, operationDirectory, installedIdentity);
    fsyncDirectory(prepared.parent);
    removeSidecars(prepared.target);
    assertRestoreOperationStable(prepared, operationDirectory, installedIdentity);
    fsyncDirectory(prepared.parent);
    assertRestoreOperationStable(prepared, operationDirectory, installedIdentity);
    await options.afterInstall?.();
    assertRestoreOperationStable(prepared, operationDirectory, installedIdentity);
    const restored = openExpectedCanonicalDatabase(
      prepared,
      installedIdentity,
      options.afterReopen
    );
    const canonical = currentCanonicalDefinition();
    return {
      database: restored,
      report: {
        backupFormatVersion: sourceInfo.manifest?.formatVersion ?? null,
        backupAppVersion: sourceInfo.manifest?.appVersion ?? null,
        schemaVersion: canonical.migrations.at(-1) ?? "uninitialized",
        manifestVerified: sourceInfo.manifest !== null,
        checksumsVerified: sourceInfo.manifest !== null,
        databaseIntegrity: "ok",
        foreignKeys: "ok",
        legacyBackup: sourceInfo.legacyBackup,
        migrationsApplied: canonical.migrations.slice(sourceInfo.migrations.length).map((migration) => migration)
      }
    };
  } catch (error) {
    if (!liveClosed) {
      throw normalizePreCutoverError(error);
    }
    const recoveredDatabase = operationDirectory && rollbackPath && rollbackIdentity && recoveryInstallPath && metadata ? await reopenOriginal(
      prepared,
      operationDirectory,
      rollbackPath,
      rollbackIdentity,
      recoveryInstallPath,
      metadata,
      replacementInstalled,
      installedIdentity,
      options.afterReopen
    ) : void 0;
    retainOperationDirectory = recoveredDatabase === void 0;
    const primaryCode = replacementInstalled ? "restore_reopen_failed" : "restore_cutover_failed";
    throw new RestoreDatabaseError(
      recoveredDatabase ? primaryCode : "restore_recovery_failed",
      recoveredDatabase
    );
  } finally {
    closeQuietly(staged);
    closeQuietly(rollbackProbe);
    closeQuietly(source);
    if (operationDirectory && !retainOperationDirectory) {
      removePrivateOperationDirectory(operationDirectory);
    }
  }
}

// packages/importers/src/csv.ts
var DEFAULT_CSV_LIMITS = {
  maxBytes: 32 * 1024 * 1024,
  maxRows: 500001,
  maxColumns: 64,
  maxFieldChars: 64 * 1024
};
var CsvError = class extends Error {
  line;
  code;
  constructor(message, line, code = "malformed_csv") {
    super(message);
    this.name = "CsvError";
    this.line = line;
    this.code = code;
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
  emittedRows = 0;
  onRow;
  limits;
  constructor(onRow, limits = DEFAULT_CSV_LIMITS) {
    validateCsvLimits(limits);
    this.onRow = onRow;
    this.limits = limits;
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
            this.appendField('"');
            continue;
          }
          this.inQuotes = false;
        } else if (c === '"') {
          this.afterQuote = true;
          continue;
        } else {
          if (c === "\n") this.line++;
          this.appendField(c);
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
        this.appendField(c);
        this.sawAny = true;
      }
    }
  }
  end() {
    if (this.inQuotes && !this.afterQuote) throw new CsvError("unterminated quote", this.line);
    this.endRow();
  }
  endField() {
    if (this.row.length >= this.limits.maxColumns) {
      throw new CsvError("too many columns", this.line, "csv_limits_exceeded");
    }
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
    if (this.row.length >= this.limits.maxColumns) {
      throw new CsvError("too many columns", this.line, "csv_limits_exceeded");
    }
    this.row.push(this.field);
    this.field = "";
    const complete = this.row;
    this.row = [];
    this.sawAny = false;
    this.emittedRows++;
    if (this.emittedRows > this.limits.maxRows) {
      throw new CsvError("too many rows", this.line, "csv_limits_exceeded");
    }
    this.onRow(complete, this.line);
  }
  appendField(value) {
    if (this.field.length >= this.limits.maxFieldChars) {
      throw new CsvError("field too large", this.line, "csv_limits_exceeded");
    }
    this.field += value;
  }
};
function assertCsvByteLength(byteLength, maxBytes = DEFAULT_CSV_LIMITS.maxBytes) {
  if (!Number.isSafeInteger(byteLength) || !Number.isSafeInteger(maxBytes) || byteLength < 0 || maxBytes < 0 || byteLength > maxBytes) {
    throw new CsvError("input exceeds size limit", 1, "csv_limits_exceeded");
  }
}
function validateCsvLimits(limits) {
  for (const value of [limits.maxBytes, limits.maxRows, limits.maxColumns, limits.maxFieldChars]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CsvError("CSV limit is invalid", 1, "csv_limits_exceeded");
    }
  }
}

// packages/importers/src/numeric.ts
var DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function parseStrictNumber(raw, bounds = {}) {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === "" || !DECIMAL_NUMBER.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (bounds.min != null && value < bounds.min) return null;
  if (bounds.max != null && value > bounds.max) return null;
  if (bounds.minExclusive != null && value <= bounds.minExclusive) return null;
  if (bounds.maxExclusive != null && value >= bounds.maxExclusive) return null;
  return value;
}

// packages/importers/src/gpx.ts
var GPX_PARSER_VERSION = "gpx-v6";
var DEFAULT_GPX_LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  maxPoints: 5e5,
  maxDepth: 32,
  // Every valid trkpt consumes required lat + lon attributes. Keep enough
  // document-wide headroom for all 500k points plus metadata/extensions.
  maxAttributes: 11e5
};
var GpxError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "GpxError";
    this.code = code;
  }
};
function assertGpxByteLength(byteLength, maxBytes = DEFAULT_GPX_LIMITS.maxBytes) {
  if (!Number.isSafeInteger(byteLength) || !Number.isSafeInteger(maxBytes) || byteLength < 0 || maxBytes < 0) {
    throw new GpxError("gpx_limits_exceeded", "GPX byte limit is invalid");
  }
  if (byteLength > maxBytes) {
    throw new GpxError("gpx_limits_exceeded", "input exceeds size limit");
  }
}
var XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
var XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
var GPX_NAMESPACES = /* @__PURE__ */ new Set([
  "http://www.topografix.com/GPX/1/0",
  "http://www.topografix.com/GPX/1/1"
]);
var QNAME = "[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?";
var QNAME_AT_START = new RegExp(`^(${QNAME})`);
var CLOSE_TAG = new RegExp(`^<\\/(${QNAME})[\\u0009\\u000a\\u000d\\u0020]*>$`);
var PREDEFINED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};
var XML_SPACE_PATTERN = "[\\u0009\\u000a\\u000d\\u0020]";
var XML_DECLARATION = new RegExp(
  `^xml${XML_SPACE_PATTERN}+version${XML_SPACE_PATTERN}*=${XML_SPACE_PATTERN}*(?:"1\\.0"|'1\\.0')(?:${XML_SPACE_PATTERN}+encoding${XML_SPACE_PATTERN}*=${XML_SPACE_PATTERN}*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:${XML_SPACE_PATTERN}+standalone${XML_SPACE_PATTERN}*=${XML_SPACE_PATTERN}*(?:"(?:yes|no)"|'(?:yes|no)'))?${XML_SPACE_PATTERN}*$`
);
function parseGpx(input, limits = DEFAULT_GPX_LIMITS) {
  validateLimits(limits);
  if (exceedsUtf8Bytes(input, limits.maxBytes)) {
    throw new GpxError("gpx_limits_exceeded", "input exceeds size limit");
  }
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(input)) {
    throw new GpxError("xml_doctype_rejected", "DTD and entity declarations are not allowed");
  }
  const segments = [];
  let current = null;
  let point = null;
  let dropped = 0;
  let totalPoints = 0;
  let sawRoot = false;
  let rootClosed = false;
  let sawXmlDeclaration = false;
  let textCapture = null;
  const attributeBudget = { remaining: limits.maxAttributes };
  const stack = [];
  const baseNamespaceScope = {
    parent: null,
    declarations: /* @__PURE__ */ new Map([["xml", XML_NAMESPACE]])
  };
  const finishPoint = () => {
    if (!point) return;
    totalPoints++;
    if (totalPoints > limits.maxPoints) {
      throw new GpxError("gpx_limits_exceeded", "too many track points");
    }
    if (isValidPoint(point)) current?.push(point);
    else dropped++;
    point = null;
  };
  const finishField = (capture) => {
    if (!point) return;
    const text = capture.text.trim();
    if (capture.field === "ele") {
      const value = parseStrictNumber(text, { minExclusive: -500, maxExclusive: 1e4 });
      if (value != null) point.ele = value;
    } else if (capture.field === "time") {
      const timestamp = parseInstant(text);
      if (timestamp == null) {
        throw new GpxError("timestamps_invalid", "track-point timestamp invalid");
      }
      point.t = timestamp;
    } else if (capture.field === "speed") {
      const value = parseStrictNumber(text, { min: 0, maxExclusive: 150 });
      if (value != null) point.speed = value;
    } else {
      const value = parseStrictNumber(text, { min: 0, maxExclusive: 360 });
      if (value != null) point.course = value;
    }
  };
  const openElement = (tag) => {
    const { frame, attributes } = tag;
    if (textCapture) {
      throw new GpxError("malformed_xml", "point field contains nested markup");
    }
    if (isGpxElement(frame, "trkseg")) {
      if (current) throw new GpxError("malformed_xml", "track segments may not be nested");
      current = [];
    } else if (isGpxElement(frame, "trkpt")) {
      if (point) throw new GpxError("malformed_xml", "track points may not be nested");
      point = { t: null };
      const lat = attributes.get("lat") ?? null;
      const lon = attributes.get("lon") ?? null;
      const latNumber = parseStrictNumber(lat, { min: -90, max: 90 });
      const lonNumber = parseStrictNumber(lon, { min: -180, max: 180 });
      if (latNumber == null || lonNumber == null) {
        throw new GpxError("numeric_value_invalid", "required track-point coordinate invalid");
      }
      point.lat = latNumber;
      point.lon = lonNumber;
    } else if (point) {
      const field = pointField(frame);
      if (field) textCapture = { frame, field, text: "" };
    }
  };
  const closeElement = (frame) => {
    if (textCapture?.frame === frame) {
      finishField(textCapture);
      textCapture = null;
    }
    if (isGpxElement(frame, "trkpt")) {
      finishPoint();
    } else if (isGpxElement(frame, "trkseg")) {
      if (current && current.length > 0) segments.push({ points: current });
      current = null;
    }
  };
  const appendCapturedText = (text) => {
    if (textCapture) textCapture.text += text;
  };
  const consumeText = (raw) => {
    if (raw.length === 0) return;
    assertXmlCharacters(raw);
    if (stack.length === 0) {
      if (!/^[\u0009\u000a\u000d\u0020]*$/u.test(raw)) {
        throw new GpxError("malformed_xml", "content outside root element");
      }
      return;
    }
    if (raw.includes("]]>")) throw new GpxError("malformed_xml", "invalid character data");
    const decoded = decodeXmlText(raw);
    appendCapturedText(decoded);
  };
  let cursor = input.charCodeAt(0) === 65279 ? 1 : 0;
  const documentStart = cursor;
  while (cursor < input.length) {
    if (input[cursor] !== "<") {
      const nextTag = input.indexOf("<", cursor);
      const end2 = nextTag === -1 ? input.length : nextTag;
      consumeText(input.slice(cursor, end2));
      cursor = end2;
      continue;
    }
    if (input.startsWith("<!--", cursor)) {
      const end2 = input.indexOf("-->", cursor + 4);
      if (end2 === -1) throw new GpxError("malformed_xml", "unterminated comment");
      const body = input.slice(cursor + 4, end2);
      if (body.includes("--") || body.endsWith("-")) {
        throw new GpxError("malformed_xml", "invalid comment");
      }
      assertXmlCharacters(body);
      cursor = end2 + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", cursor)) {
      if (stack.length === 0) {
        throw new GpxError("malformed_xml", "CDATA outside root element");
      }
      const end2 = input.indexOf("]]>", cursor + 9);
      if (end2 === -1) throw new GpxError("malformed_xml", "unterminated CDATA");
      const body = input.slice(cursor + 9, end2);
      assertXmlCharacters(body);
      appendCapturedText(body);
      cursor = end2 + 3;
      continue;
    }
    if (input.startsWith("<?", cursor)) {
      const end2 = input.indexOf("?>", cursor + 2);
      if (end2 === -1) {
        throw new GpxError("malformed_xml", "unterminated processing instruction");
      }
      const body = input.slice(cursor + 2, end2);
      const target = /^([A-Za-z_][\w.-]*)(?:\s|$)/.exec(body)?.[1];
      if (!target) throw new GpxError("malformed_xml", "processing instruction is invalid");
      if (target.toLowerCase() === "xml") {
        if (target !== "xml" || sawXmlDeclaration || sawRoot || stack.length !== 0 || cursor !== documentStart) {
          throw new GpxError("malformed_xml", "XML declaration is misplaced");
        }
        if (!XML_DECLARATION.test(body)) {
          throw new GpxError("malformed_xml", "XML declaration is invalid");
        }
        sawXmlDeclaration = true;
      }
      assertXmlCharacters(body);
      cursor = end2 + 2;
      continue;
    }
    if (input.startsWith("</", cursor)) {
      const end2 = input.indexOf(">", cursor + 2);
      if (end2 === -1) throw new GpxError("malformed_xml", "unterminated closing tag");
      const token = input.slice(cursor, end2 + 1);
      const qName = CLOSE_TAG.exec(token)?.[1];
      if (!qName) throw new GpxError("malformed_xml", "closing tag is invalid");
      const expected = stack.at(-1);
      if (!expected) throw new GpxError("malformed_xml", "unbalanced closing tag");
      if (expected.qName !== qName) {
        throw new GpxError("malformed_xml", "mismatched closing tag");
      }
      closeElement(expected);
      stack.pop();
      if (stack.length === 0) rootClosed = true;
      cursor = end2 + 1;
      continue;
    }
    if (input.startsWith("<!", cursor)) {
      throw new GpxError("malformed_xml", "markup declaration is not supported");
    }
    const end = findStartTagEnd(input, cursor);
    const parentNamespaceScope = stack.at(-1)?.namespaceScope ?? baseNamespaceScope;
    const tag = parseStartTag(input.slice(cursor, end + 1), parentNamespaceScope, attributeBudget);
    if (stack.length === 0) {
      if (sawRoot || rootClosed) throw new GpxError("malformed_xml", "multiple root elements");
      if (!isGpxElement(tag.frame, "gpx")) {
        throw new GpxError("malformed_xml", "document root is not GPX");
      }
      sawRoot = true;
    }
    if (stack.length + 1 > limits.maxDepth) {
      throw new GpxError("gpx_limits_exceeded", "nesting too deep");
    }
    openElement(tag);
    if (tag.selfClosing) {
      closeElement(tag.frame);
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(tag.frame);
    }
    cursor = end + 1;
  }
  if (!sawRoot || !rootClosed) throw new GpxError("malformed_xml", "GPX root is incomplete");
  if (stack.length !== 0 || textCapture || point || current) {
    throw new GpxError("malformed_xml", "unclosed elements");
  }
  return { segments, droppedPoints: dropped };
}
function findStartTagEnd(input, start) {
  let quote = null;
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    } else if (char === "<") {
      throw new GpxError("malformed_xml", "start tag is invalid");
    }
  }
  throw new GpxError("malformed_xml", "unterminated start tag");
}
function parseStartTag(token, parentNamespaceScope, attributeBudget) {
  const selfClosing = /\/>$/.test(token);
  const body = token.slice(1, selfClosing ? -2 : -1);
  const nameMatch = QNAME_AT_START.exec(body);
  if (!nameMatch) throw new GpxError("malformed_xml", "start tag name is invalid");
  const qName = nameMatch[1];
  const remainder = body.slice(qName.length);
  if (remainder.length > 0 && !isXmlSpace(remainder[0])) {
    throw new GpxError("malformed_xml", "start tag is invalid");
  }
  const { attributes, namespaceScope } = parseAttributes(
    remainder,
    parentNamespaceScope,
    attributeBudget
  );
  const { prefix, local } = splitQName(qName);
  if (prefix === "xmlns") throw new GpxError("malformed_xml", "reserved prefix is invalid");
  const resolvedNamespaceUri = resolveNamespace(namespaceScope, prefix ?? "");
  if (prefix && resolvedNamespaceUri === void 0) {
    throw new GpxError("malformed_xml", "namespace prefix is not declared");
  }
  const namespaceUri = resolvedNamespaceUri ?? null;
  validateAttributeNamespaces(attributes, namespaceScope);
  return {
    frame: {
      qName,
      local,
      namespaceUri: namespaceUri ?? null,
      namespaceScope
    },
    attributes,
    selfClosing
  };
}
function parseAttributes(source, parentNamespaceScope, attributeBudget) {
  const attributes = /* @__PURE__ */ new Map();
  const declarations = /* @__PURE__ */ new Map();
  const namespaceScope = {
    parent: parentNamespaceScope,
    declarations
  };
  let cursor = 0;
  while (cursor < source.length) {
    const whitespaceStart = cursor;
    while (cursor < source.length && isXmlSpace(source[cursor])) cursor++;
    if (cursor === source.length) break;
    if (cursor === whitespaceStart) {
      throw new GpxError("malformed_xml", "attributes must be separated");
    }
    const nameMatch = QNAME_AT_START.exec(source.slice(cursor));
    if (!nameMatch) throw new GpxError("malformed_xml", "attribute name is invalid");
    if (attributeBudget.remaining === 0) {
      throw new GpxError("gpx_limits_exceeded", "too many attributes");
    }
    attributeBudget.remaining--;
    const qName = nameMatch[1];
    cursor += qName.length;
    while (cursor < source.length && isXmlSpace(source[cursor])) cursor++;
    if (source[cursor] !== "=") {
      throw new GpxError("malformed_xml", "attribute assignment is invalid");
    }
    cursor++;
    while (cursor < source.length && isXmlSpace(source[cursor])) cursor++;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new GpxError("malformed_xml", "attribute value must be quoted");
    }
    const valueStart = ++cursor;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd === -1) throw new GpxError("malformed_xml", "attribute value is unterminated");
    const rawValue = source.slice(valueStart, valueEnd);
    if (rawValue.includes("<")) {
      throw new GpxError("malformed_xml", "attribute value is invalid");
    }
    const value = decodeXmlText(rawValue);
    if (attributes.has(qName)) throw new GpxError("malformed_xml", "duplicate attribute");
    attributes.set(qName, value);
    applyNamespaceDeclaration(qName, value, declarations);
    cursor = valueEnd + 1;
  }
  return { attributes, namespaceScope };
}
function applyNamespaceDeclaration(qName, value, declarations) {
  if (qName === "xmlns") {
    if (value === XML_NAMESPACE || value === XMLNS_NAMESPACE) {
      throw new GpxError("malformed_xml", "default namespace is reserved");
    }
    declarations.set("", value === "" ? null : value);
    return;
  }
  if (!qName.startsWith("xmlns:")) return;
  const prefix = qName.slice("xmlns:".length);
  if (prefix === "xmlns" || value === "" || value === XMLNS_NAMESPACE || prefix === "xml" && value !== XML_NAMESPACE || prefix !== "xml" && value === XML_NAMESPACE) {
    throw new GpxError("malformed_xml", "namespace declaration is invalid");
  }
  declarations.set(prefix, value);
}
function validateAttributeNamespaces(attributes, namespaceScope) {
  const expandedNames = /* @__PURE__ */ new Set();
  for (const qName of attributes.keys()) {
    if (qName === "xmlns" || qName.startsWith("xmlns:")) continue;
    const { prefix, local } = splitQName(qName);
    if (prefix === "xmlns") throw new GpxError("malformed_xml", "reserved prefix is invalid");
    const namespaceUri = prefix ? resolveNamespace(namespaceScope, prefix) : "";
    if (prefix && namespaceUri === void 0) {
      throw new GpxError("malformed_xml", "attribute namespace prefix is not declared");
    }
    const expandedName = `${namespaceUri ?? ""}\0${local}`;
    if (expandedNames.has(expandedName)) {
      throw new GpxError("malformed_xml", "duplicate expanded attribute");
    }
    expandedNames.add(expandedName);
  }
}
function resolveNamespace(scope, prefix) {
  let current = scope;
  while (current) {
    if (current.declarations.has(prefix)) {
      return current.declarations.get(prefix) ?? void 0;
    }
    current = current.parent;
  }
  return void 0;
}
function splitQName(qName) {
  const colon = qName.indexOf(":");
  return colon === -1 ? { prefix: null, local: qName } : { prefix: qName.slice(0, colon), local: qName.slice(colon + 1) };
}
function isGpxElement(frame, local) {
  return frame.local === local && (frame.namespaceUri === null || frame.namespaceUri === "" || GPX_NAMESPACES.has(frame.namespaceUri));
}
function pointField(frame) {
  if (isGpxElement(frame, "ele")) return "ele";
  if (isGpxElement(frame, "time")) return "time";
  if (frame.local === "speed") return "speed";
  if (frame.local === "course") return "course";
  return null;
}
function decodeXmlText(raw) {
  assertXmlCharacters(raw);
  let decoded = "";
  for (let cursor = 0; cursor < raw.length; ) {
    const ampersand = raw.indexOf("&", cursor);
    if (ampersand === -1) {
      decoded += raw.slice(cursor);
      break;
    }
    decoded += raw.slice(cursor, ampersand);
    const semicolon = raw.indexOf(";", ampersand + 1);
    if (semicolon === -1) throw new GpxError("malformed_xml", "entity reference is invalid");
    const entity = raw.slice(ampersand + 1, semicolon);
    const predefined = PREDEFINED_ENTITIES[entity];
    if (predefined !== void 0) {
      decoded += predefined;
    } else {
      const codePoint = parseCharacterReference(entity);
      if (codePoint === null || !isXmlCodePoint(codePoint)) {
        throw new GpxError("malformed_xml", "entity reference is invalid");
      }
      decoded += String.fromCodePoint(codePoint);
    }
    cursor = semicolon + 1;
  }
  assertXmlCharacters(decoded);
  return decoded;
}
function parseCharacterReference(entity) {
  if (/^#x[0-9A-Fa-f]+$/.test(entity)) return Number.parseInt(entity.slice(2), 16);
  if (/^#[0-9]+$/.test(entity)) return Number.parseInt(entity.slice(1), 10);
  return null;
}
function validateLimits(limits) {
  if (!Number.isSafeInteger(limits.maxBytes) || !Number.isSafeInteger(limits.maxPoints) || !Number.isSafeInteger(limits.maxDepth) || !Number.isSafeInteger(limits.maxAttributes) || limits.maxBytes < 0 || limits.maxPoints < 0 || limits.maxDepth < 0 || limits.maxAttributes < 0) {
    throw new GpxError("gpx_limits_exceeded", "GPX limits are invalid");
  }
}
function exceedsUtf8Bytes(value, maxBytes) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 127) bytes += 1;
    else if (codeUnit <= 2047) bytes += 2;
    else if (codeUnit >= 55296 && codeUnit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return true;
  }
  return false;
}
function isXmlSpace(char) {
  return char === " " || char === "	" || char === "\r" || char === "\n";
}
function assertXmlCharacters(value) {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (!isXmlCodePoint(codePoint)) {
      throw new GpxError("malformed_xml", "invalid XML character");
    }
  }
}
function isXmlCodePoint(codePoint) {
  return codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32 && codePoint <= 55295 || codePoint >= 57344 && codePoint <= 65533 || codePoint >= 65536 && codePoint <= 1114111;
}
function isValidPoint(p) {
  return typeof p.lat === "number" && typeof p.lon === "number" && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

// packages/importers/src/zip.ts
import { inflateRawSync } from "node:zlib";
var ZIP_PARSER_VERSION = "zip-v2";
var DEFAULT_ZIP_LIMITS = {
  maxEntries: 2e3,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024
};
function createZipDecodedBudget(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ZipError("zip_limits_exceeded", "decoded-byte budget is invalid");
  }
  return { remainingBytes: maxBytes };
}
var ZipError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
};
var NESTED_ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
var EOCD_SIGNATURE = 101010256;
var CENTRAL_SIGNATURE = 33639248;
var LOCAL_SIGNATURE = 67324752;
var MAX_EOCD_SEARCH = 65535 + 22;
function isDecodedBudget(value) {
  return value !== void 0 && "remainingBytes" in value;
}
function viewOf(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function uint16(view, offset) {
  return view.getUint16(offset, true);
}
function uint32(view, offset) {
  return view.getUint32(offset, true);
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
function decodeName(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ZipError("zip_entry_rejected", "entry name is not valid UTF-8");
  }
}
function findEndOfCentralDirectory(data, view) {
  const start = Math.max(0, data.length - MAX_EOCD_SEARCH);
  for (let offset = data.length - 22; offset >= start; offset--) {
    if (uint32(view, offset) !== EOCD_SIGNATURE) continue;
    const commentBytes = uint16(view, offset + 20);
    if (offset + 22 + commentBytes === data.length) return offset;
  }
  throw new ZipError("io_error", "zip could not be read");
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
function skippedBeforeInflation(name) {
  if (name.endsWith("/")) return true;
  const parts = name.split("/").filter(Boolean);
  return parts.some((part) => part === "__MACOSX" || part.startsWith("."));
}
function prepareZip(zipData, limits) {
  if (!Number.isSafeInteger(limits.maxEntries) || !Number.isSafeInteger(limits.maxEntryBytes) || !Number.isSafeInteger(limits.maxTotalBytes) || limits.maxEntries < 0 || limits.maxEntryBytes < 0 || limits.maxTotalBytes < 0) {
    throw new ZipError("zip_limits_exceeded", "zip limits are invalid");
  }
  if (zipData.length < 22) throw new ZipError("io_error", "zip could not be read");
  const view = viewOf(zipData);
  const eocd = findEndOfCentralDirectory(zipData, view);
  const disk = uint16(view, eocd + 4);
  const centralDisk = uint16(view, eocd + 6);
  const entriesOnDisk = uint16(view, eocd + 8);
  const entryCount = uint16(view, eocd + 10);
  const centralBytes = uint32(view, eocd + 12);
  const centralOffset = uint32(view, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 65535 || centralBytes === 4294967295 || centralOffset === 4294967295) {
    throw new ZipError("zip_entry_rejected", "multi-disk and ZIP64 archives are not supported");
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError("zip_limits_exceeded", "too many entries");
  }
  if (centralOffset > eocd || centralBytes > eocd - centralOffset || centralOffset + centralBytes !== eocd) {
    throw new ZipError("io_error", "zip central directory is invalid");
  }
  const entries = [];
  const names = /* @__PURE__ */ new Set();
  const outputNames = /* @__PURE__ */ new Set();
  let declaredTotal = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || uint32(view, cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError("io_error", "zip central directory is invalid");
    }
    const flags = uint16(view, cursor + 8);
    const compression = uint16(view, cursor + 10);
    const crc = uint32(view, cursor + 16);
    const compressedBytes = uint32(view, cursor + 20);
    const declaredBytes = uint32(view, cursor + 24);
    const nameBytes = uint16(view, cursor + 28);
    const extraBytes = uint16(view, cursor + 30);
    const commentBytes = uint16(view, cursor + 32);
    const startDisk = uint16(view, cursor + 34);
    const localOffset = uint32(view, cursor + 42);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (next > eocd) throw new ZipError("io_error", "zip central directory is invalid");
    if (startDisk !== 0 || localOffset === 4294967295) {
      throw new ZipError("zip_entry_rejected", "multi-disk and ZIP64 archives are not supported");
    }
    if ((flags & 1) !== 0) {
      throw new ZipError("zip_entry_rejected", "encrypted entries are not supported");
    }
    if (compression !== 0 && compression !== 8) {
      throw new ZipError("zip_entry_rejected", "entry compression is not supported");
    }
    const centralNameBytes = zipData.subarray(cursor + 46, cursor + 46 + nameBytes);
    const name = decodeName(centralNameBytes);
    validateEntryName(name);
    if (names.has(name)) {
      throw new ZipError("zip_entry_rejected", "duplicate entry names are not supported");
    }
    names.add(name);
    if (localOffset + 30 > centralOffset || uint32(view, localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError("zip_entry_rejected", "entry header does not match its manifest");
    }
    const localFlags = uint16(view, localOffset + 6);
    const localCompression = uint16(view, localOffset + 8);
    const localCrc = uint32(view, localOffset + 14);
    const localCompressedBytes = uint32(view, localOffset + 18);
    const localDeclaredBytes = uint32(view, localOffset + 22);
    const localNameBytes = uint16(view, localOffset + 26);
    const localExtraBytes = uint16(view, localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameBytes + localExtraBytes;
    if (localHeaderEnd > centralOffset) {
      throw new ZipError("zip_entry_rejected", "entry header does not match its manifest");
    }
    const localName = zipData.subarray(localOffset + 30, localOffset + 30 + localNameBytes);
    const usesDescriptor = (flags & 8) !== 0;
    const localSizesMatch = usesDescriptor ? (localCrc === 0 || localCrc === crc) && (localCompressedBytes === 0 || localCompressedBytes === compressedBytes) && (localDeclaredBytes === 0 || localDeclaredBytes === declaredBytes) : localCrc === crc && localCompressedBytes === compressedBytes && localDeclaredBytes === declaredBytes;
    if (localFlags !== flags || localCompression !== compression || !bytesEqual(localName, centralNameBytes) || !localSizesMatch || compressedBytes > centralOffset - localHeaderEnd) {
      throw new ZipError("zip_entry_rejected", "entry header does not match its manifest");
    }
    const inflate = !skippedBeforeInflation(name);
    let outputName;
    if (inflate) {
      if (NESTED_ARCHIVE.test(name)) {
        throw new ZipError("zip_entry_rejected", "nested archives are not supported");
      }
      if (declaredBytes > limits.maxEntryBytes) {
        throw new ZipError("zip_limits_exceeded", "entry exceeds size limit");
      }
      declaredTotal += declaredBytes;
      if (declaredTotal > limits.maxTotalBytes) {
        throw new ZipError("zip_limits_exceeded", "decompressed size exceeds limit");
      }
      outputName = name.split("/").filter(Boolean).pop();
      if (!outputName || outputNames.has(outputName)) {
        throw new ZipError(
          "zip_entry_rejected",
          "duplicate flattened entry names are not supported"
        );
      }
      outputNames.add(outputName);
    }
    entries.push({
      name,
      ...outputName ? { outputName } : {},
      localOffset,
      dataOffset: localHeaderEnd,
      compression,
      crc,
      compressedBytes,
      declaredBytes,
      inflate
    });
    cursor = next;
  }
  if (cursor !== eocd) throw new ZipError("io_error", "zip central directory is invalid");
  return entries.sort((a, b) => a.localOffset - b.localOffset);
}
function extractZip(zipData, limits = DEFAULT_ZIP_LIMITS, control, additionalHooks) {
  const prepared = prepareZip(zipData, limits);
  const budget = isDecodedBudget(control) ? control : void 0;
  const hooks = budget ? additionalHooks : control;
  const declaredTotal = prepared.reduce(
    (total, entry) => total + (entry.inflate ? entry.declaredBytes : 0),
    0
  );
  if (budget && (!Number.isSafeInteger(budget.remainingBytes) || budget.remainingBytes < 0 || declaredTotal > budget.remainingBytes)) {
    throw new ZipError("zip_limits_exceeded", "decompressed size exceeds shared limit");
  }
  if (budget) budget.remainingBytes -= declaredTotal;
  const entries = [];
  let actualTotal = 0;
  for (const expected of prepared) {
    if (!expected.inflate) continue;
    const remainingTotal = limits.maxTotalBytes - actualTotal;
    const remainingOutput = Math.min(limits.maxEntryBytes, remainingTotal);
    if (remainingOutput <= 0) {
      throw new ZipError("zip_limits_exceeded", "decompressed size exceeds limit");
    }
    hooks?.onEntryStart?.(expected.name);
    const compressed = zipData.subarray(
      expected.dataOffset,
      expected.dataOffset + expected.compressedBytes
    );
    let data;
    if (expected.compression === 0) {
      if (compressed.length > remainingOutput) {
        throw new ZipError("zip_limits_exceeded", "decompressed size exceeds limit");
      }
      data = compressed.slice();
    } else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: remainingOutput });
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "ERR_BUFFER_TOO_LARGE") {
          throw new ZipError("zip_limits_exceeded", "decompressed size exceeds limit");
        }
        throw new ZipError("io_error", "zip could not be read");
      }
    }
    if (data.length !== expected.declaredBytes || crc32(data) !== expected.crc) {
      throw new ZipError("zip_entry_rejected", "entry output does not match its declared size");
    }
    actualTotal += data.length;
    hooks?.onChunk?.(expected.name, data.length);
    entries.push({ name: expected.outputName, data });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
var CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 3988292384 ^ value >>> 1 : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}
function crc32(data) {
  let value = 4294967295;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 255] ^ value >>> 8;
  }
  return (value ^ 4294967295) >>> 0;
}

// packages/importers/src/adapters.ts
var ADAPTER_VERSION = "hae-csv-v4";
var AdapterError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
};
var SUPPORTED_CYCLING_LABELS = /* @__PURE__ */ new Set([
  "heartrate",
  "cyclingcadence",
  "cyclingdistance",
  "activeenergy",
  "route"
]);
var normalizeLabel = (label) => label.toLowerCase().replace(/[^a-z0-9]/g, "");
function expectedKindForLabel(label) {
  const normalized = normalizeLabel(label);
  if (normalized === "heartrate") return "heart_rate";
  if (normalized === "cyclingcadence") return "cadence";
  if (normalized === "cyclingdistance") return "distance";
  if (normalized === "activeenergy") return "energy";
  if (normalized === "route") return "route";
  return null;
}
function classifyImportFileName(name) {
  const trimmed = name.trim();
  if (/\.zip$/i.test(trimmed)) {
    return { kind: "archive", detectedType: "archive:zip" };
  }
  const match = /^(.+?)-(.+?)-(\d{8}_\d{6})\.(csv|gpx)$/i.exec(trimmed);
  if (!match) return { kind: "unsupported", detectedType: null };
  const workoutLabel = match[1].trim().toLowerCase();
  const metricLabel = match[2].trim();
  const format = match[4].toLowerCase();
  const cycling = workoutLabel === "outdoor cycling" ? "outdoor_cycling" : workoutLabel === "indoor cycling" ? "indoor_cycling" : null;
  if (!cycling) {
    return { kind: "non_cycling_workout", detectedType: "skip:non_cycling_workout" };
  }
  if (!SUPPORTED_CYCLING_LABELS.has(normalizeLabel(metricLabel))) {
    return { kind: "unmodelled_metric", detectedType: "skip:unmodelled_metric" };
  }
  if (format === "gpx" && normalizeLabel(metricLabel) !== "route") {
    return { kind: "unsupported", detectedType: "unsupported:gpx_filename" };
  }
  return {
    kind: "supported",
    detectedType: `${cycling}:${normalizeLabel(metricLabel)}:${format}`
  };
}
function parseHaeFilename(name) {
  const m = /^(Outdoor|Indoor) Cycling-(.+?)-(\d{8}_\d{6})\.(csv|gpx)$/i.exec(name.trim());
  if (!m) return null;
  return {
    workoutType: m[1].toLowerCase() === "indoor" ? "indoor_cycling" : "outdoor_cycling",
    label: m[2],
    stampHint: m[3]
  };
}
function parseHaeFilenameTimestamps(name, options = {}) {
  const info = parseHaeFilename(name);
  if (!info?.stampHint) return [];
  const stamp = info.stampHint;
  const isoLike = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(
    9,
    11
  )}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
  const utc = parseInstant(isoLike);
  if (utc == null) {
    throw new AdapterError("timestamps_invalid", "filename timestamp invalid");
  }
  const candidates = [];
  if (options.timeZone) {
    const zoned = parseInstant(isoLike, { defaultTimeZone: options.timeZone });
    if (zoned != null) candidates.push(zoned);
  }
  if (!candidates.includes(utc)) candidates.push(utc);
  return candidates;
}
var norm = (h) => h.toLowerCase().replace(/\s+|\(|\)/g, "");
var CSV_SHAPES = [
  {
    metric: "heart_rate",
    value: ["avgbpm", "avgcount/min", "avg", "heartratebpm", "bpm"],
    min: ["minbpm", "mincount/min", "min"],
    max: ["maxbpm", "maxcount/min", "max"],
    bounds: { minExclusive: 0, max: 300 },
    toCanonical: (v) => v
  },
  {
    metric: "cadence",
    value: ["cadencerpm", "cyclingcadencecount/min", "cadence", "rpm"],
    bounds: { min: 0, max: 300 },
    toCanonical: (v) => v
  },
  {
    metric: "distance",
    value: ["cyclingdistancekm", "distancekm"],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER / 1e3 },
    toCanonical: (v) => v * 1e3
    // km → m
  },
  {
    metric: "distance",
    value: ["cyclingdistancem", "distancem"],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER },
    toCanonical: (v) => v
  },
  {
    metric: "energy",
    value: ["activeenergykj", "energykj"],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER / 1e3 },
    toCanonical: (v) => v * 1e3
    // kJ → J
  },
  {
    metric: "energy",
    value: ["activeenergyj", "energyj"],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER },
    toCanonical: (v) => v
  },
  {
    metric: "energy",
    value: ["activeenergykcal", "energykcal"],
    bounds: { min: 0, max: Number.MAX_SAFE_INTEGER / 4184 },
    toCanonical: (v) => v * 4184
    // thermochemical kcal → J
  }
];
var ROUTE_CSV_HEADERS = ["timestamp", "latitude", "longitude"];
var CSV_PARSE_CHUNK_CHARS = 64 * 1024;
var MAX_HAE_CSV_SAMPLES = DEFAULT_CSV_LIMITS.maxRows - 1;
var CSV_NORMALIZATION_CHUNK_ROWS = 2048;
function* parseHaeCsvSteps(name, text, options = {}) {
  const info = parseHaeFilename(name);
  if (!info) throw new AdapterError("unsupported_file_type", "filename not recognized");
  if (!expectedKindForLabel(info.label)) {
    throw new AdapterError("unsupported_file_type", "filename metric not supported");
  }
  if (text.length === 0) {
    throw new AdapterError("empty_file", "file is empty");
  }
  let spec = null;
  const samples = [];
  const points = [];
  let source = null;
  const parser = new CsvStreamParser((row) => {
    if (!spec) {
      if (row.every((field) => field.trim() === "")) return;
      spec = parseCsvHeader(info, row);
      return;
    }
    if (spec.kind === "metric") {
      if (samples.length >= MAX_HAE_CSV_SAMPLES) {
        throw new AdapterError("csv_limits_exceeded", "CSV sample limit exceeded");
      }
      const sample = parseMetricCsvRow(spec, row, options);
      const context = spec.ctxIdx === -1 ? void 0 : row[spec.ctxIdx];
      if (context) sample.context = context;
      if (spec.srcIdx !== -1 && row[spec.srcIdx]) source = row[spec.srcIdx];
      samples.push(sample);
      return;
    }
    if (points.length >= MAX_HAE_CSV_SAMPLES) {
      throw new AdapterError("csv_limits_exceeded", "CSV sample limit exceeded");
    }
    points.push(parseRouteCsvRow(spec, row, options));
  }, DEFAULT_CSV_LIMITS);
  try {
    for (let offset = 0; offset < text.length; offset += CSV_PARSE_CHUNK_CHARS) {
      parser.push(text.slice(offset, offset + CSV_PARSE_CHUNK_CHARS));
      yield;
    }
    parser.end();
  } catch (err) {
    if (err instanceof CsvError) {
      throw new AdapterError(err.code, "CSV structure or limits invalid");
    }
    throw err;
  }
  const finalSpec = spec;
  if (!finalSpec) throw new AdapterError("empty_file", "file is empty");
  if (samples.length === 0 && points.length === 0) {
    throw new AdapterError("no_valid_samples", "no data rows");
  }
  if (finalSpec.kind === "metric") {
    const sortedSamples = yield* sortInBoundedSteps(samples, (a, b) => a.t - b.t);
    return {
      kind: "metric",
      metric: finalSpec.shape.metric,
      workoutType: info.workoutType,
      source,
      samples: sortedSamples
    };
  }
  const sortedPoints = yield* sortInBoundedSteps(points, (a, b) => (a.t ?? 0) - (b.t ?? 0));
  return {
    kind: "route",
    format: "csv",
    workoutType: info.workoutType,
    segments: yield* splitRouteSegmentsSteps(sortedPoints)
  };
}
function parseCsvHeader(info, rawHeader) {
  const expectedKind = expectedKindForLabel(info.label);
  if (!expectedKind) {
    throw new AdapterError("unsupported_file_type", "filename metric not supported");
  }
  const header = rawHeader.map(norm);
  const idx = (names) => header.findIndex((h) => names.includes(h));
  const tIdx = idx(["date/time", "datetime", "date", "timestamp"]);
  if (tIdx === -1) throw new AdapterError("unrecognized_headers", "no timestamp column");
  if (ROUTE_CSV_HEADERS.every((h) => header.includes(h))) {
    if (expectedKind !== "route") {
      throw new AdapterError("metric_kind_mismatch", "filename and route headers disagree");
    }
    return {
      kind: "route",
      tIdx: header.indexOf("timestamp"),
      latIdx: header.indexOf("latitude"),
      lonIdx: header.indexOf("longitude"),
      altitude: resolveUnitColumn(header, "altitude", {
        altitudem: 1,
        altitudeft: 0.3048
      }),
      speed: resolveUnitColumn(header, "speed", {
        "speedm/s": 1,
        "speedkm/h": 1 / 3.6
      }),
      course: resolveUnitColumn(header, "course", {
        coursedeg: 1
      }),
      horizontalAccuracy: resolveUnitColumn(header, "horizontalaccuracy", {
        horizontalaccuracym: 1,
        horizontalaccuracyft: 0.3048
      }),
      verticalAccuracy: resolveUnitColumn(header, "verticalaccuracy", {
        verticalaccuracym: 1,
        verticalaccuracyft: 0.3048
      })
    };
  }
  const matchingShapes = CSV_SHAPES.filter((shape2) => idx(shape2.value) !== -1);
  const shape = matchingShapes.length === 1 ? matchingShapes[0] : void 0;
  if (!shape) {
    const unitSensitiveHeader = header.some(
      (h) => h === "distance" || h.startsWith("distance") || h === "cyclingdistance" || h.startsWith("cyclingdistance") || h === "energy" || h.startsWith("energy") || h === "activeenergy" || h.startsWith("activeenergy")
    );
    if (unitSensitiveHeader) {
      throw new AdapterError("unit_unsupported", "metric unit unsupported or missing");
    }
    throw new AdapterError("unrecognized_headers", "no known metric column");
  }
  if (expectedKind === "route" || shape.metric !== expectedKind) {
    throw new AdapterError("metric_kind_mismatch", "filename and metric headers disagree");
  }
  return {
    kind: "metric",
    shape,
    tIdx,
    vIdx: idx(shape.value),
    minIdx: shape.min ? idx(shape.min) : -1,
    maxIdx: shape.max ? idx(shape.max) : -1,
    srcIdx: idx(["source"]),
    ctxIdx: idx(["context"])
  };
}
function parseMetricCsvRow(spec, row, options) {
  const t = parseRequiredInstant(row[spec.tIdx], options);
  const v = parseRequiredNumber(row[spec.vIdx], spec.shape.bounds);
  const value = spec.shape.toCanonical(v);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new AdapterError("numeric_value_invalid", "canonical numeric value invalid");
  }
  const sample = { t, value };
  if (spec.minIdx !== -1) {
    const min = parseStrictNumber(row[spec.minIdx], spec.shape.bounds);
    if (min != null) sample.min = spec.shape.toCanonical(min);
  }
  if (spec.maxIdx !== -1) {
    const max = parseStrictNumber(row[spec.maxIdx], spec.shape.bounds);
    if (max != null) sample.max = spec.shape.toCanonical(max);
  }
  return sample;
}
function parseRouteCsvRow(spec, row, options) {
  const t = parseRequiredInstant(row[spec.tIdx], options);
  const lat = parseRequiredNumber(row[spec.latIdx], { min: -90, max: 90 });
  const lon = parseRequiredNumber(row[spec.lonIdx], { min: -180, max: 180 });
  const point = { t, lat, lon };
  parseOptionalRouteField(point, row, spec.altitude, "ele", {
    minExclusive: -500,
    maxExclusive: 1e4
  });
  parseOptionalRouteField(point, row, spec.speed, "speed", { min: 0, maxExclusive: 150 });
  parseOptionalRouteField(point, row, spec.course, "course", { min: 0, maxExclusive: 360 });
  parseOptionalRouteField(point, row, spec.horizontalAccuracy, "hAcc", {
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  parseOptionalRouteField(point, row, spec.verticalAccuracy, "vAcc", {
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  return point;
}
function parseOptionalRouteField(point, row, column, key, bounds) {
  if (!column) return;
  const raw = parseStrictNumber(row[column.index]);
  if (raw == null) return;
  const value = raw * column.toCanonicalFactor;
  if (Number.isFinite(value) && isWithinBounds(value, bounds)) {
    point[key] = value;
  }
}
function* splitRouteSegmentsSteps(points) {
  const segments = [];
  let segment = [];
  let previous = null;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (previous != null && point.t != null && point.t - previous > 6e4 && segment.length) {
      segments.push({ points: segment });
      segment = [];
    }
    segment.push(point);
    if (point.t != null) previous = point.t;
    if ((index + 1) % CSV_NORMALIZATION_CHUNK_ROWS === 0) yield;
  }
  if (segment.length) segments.push({ points: segment });
  return segments;
}
function* sortInBoundedSteps(values, compare) {
  if (values.length < 2) return values;
  for (let start = 0; start < values.length; start += CSV_NORMALIZATION_CHUNK_ROWS) {
    const sorted = values.slice(start, start + CSV_NORMALIZATION_CHUNK_ROWS).sort(compare);
    for (let index = 0; index < sorted.length; index++) {
      values[start + index] = sorted[index];
    }
    yield;
  }
  let source = values;
  let target = new Array(values.length);
  for (let width = CSV_NORMALIZATION_CHUNK_ROWS; width < values.length; width *= 2) {
    let writtenSinceYield = 0;
    for (let left = 0; left < values.length; left += width * 2) {
      const middle = Math.min(left + width, values.length);
      const right = Math.min(left + width * 2, values.length);
      let leftIndex = left;
      let rightIndex = middle;
      for (let output = left; output < right; output++) {
        if (rightIndex >= right || leftIndex < middle && compare(source[leftIndex], source[rightIndex]) <= 0) {
          target[output] = source[leftIndex++];
        } else {
          target[output] = source[rightIndex++];
        }
        writtenSinceYield++;
        if (writtenSinceYield >= CSV_NORMALIZATION_CHUNK_ROWS) {
          writtenSinceYield = 0;
          yield;
        }
      }
    }
    const previousSource = source;
    source = target;
    target = previousSource;
  }
  if (source !== values) {
    for (let start = 0; start < values.length; start += CSV_NORMALIZATION_CHUNK_ROWS) {
      const end = Math.min(start + CSV_NORMALIZATION_CHUNK_ROWS, values.length);
      for (let index = start; index < end; index++) values[index] = source[index];
      yield;
    }
  }
  return values;
}
function resolveUnitColumn(header, family, supported) {
  const candidates = header.map((value, index) => ({ value, index })).filter(({ value }) => value === family || value.startsWith(family));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new AdapterError("unrecognized_headers", `ambiguous ${family} column`);
  }
  const candidate = candidates[0];
  const factor = supported[candidate.value];
  if (factor === void 0) {
    throw new AdapterError("unit_unsupported", `${family} unit unsupported or missing`);
  }
  return { index: candidate.index, toCanonicalFactor: factor };
}
function isWithinBounds(value, bounds) {
  if (bounds.min != null && value < bounds.min) return false;
  if (bounds.max != null && value > bounds.max) return false;
  if (bounds.minExclusive != null && value <= bounds.minExclusive) return false;
  if (bounds.maxExclusive != null && value >= bounds.maxExclusive) return false;
  return true;
}
function parseHaeGpx(name, text) {
  const info = parseHaeFilename(name);
  if (!info || expectedKindForLabel(info.label) !== "route" || classifyImportFileName(name).kind !== "supported" || !/\.gpx$/i.test(name.trim())) {
    throw new AdapterError("unsupported_file_type", "filename not recognized");
  }
  const workoutType = info.workoutType;
  try {
    const { segments } = parseGpx(text);
    if (segments.length === 0) throw new AdapterError("no_valid_samples", "no track points");
    return { kind: "route", format: "gpx", workoutType, segments };
  } catch (err) {
    if (err instanceof GpxError) throw new AdapterError(err.code, err.message);
    throw err;
  }
}
function parseRequiredInstant(raw, options) {
  const parsed = parseInstant(raw ?? "", { defaultTimeZone: options.timeZone ?? null });
  if (parsed == null) {
    throw new AdapterError("timestamps_invalid", "required timestamp invalid");
  }
  return parsed;
}
function parseRequiredNumber(raw, bounds) {
  const parsed = parseStrictNumber(raw, bounds);
  if (parsed == null) {
    throw new AdapterError("numeric_value_invalid", "required numeric value invalid");
  }
  return parsed;
}

// packages/importers/src/association.ts
var DEFAULT_ASSOCIATION_TOLERANCE_MS = 10 * 60 * 1e3;
function sampleTimeRange(file) {
  if (file.kind === "metric") {
    if (file.samples.length === 0) return null;
    return { start: file.samples[0].t, end: file.samples[file.samples.length - 1].t };
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const segment of file.segments) {
    for (const point of segment.points) {
      if (point.t == null) continue;
      if (point.t < start) start = point.t;
      if (point.t > end) end = point.t;
    }
  }
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}
function associateWorkout(candidates, internal, filenameTimestamps, toleranceMs) {
  const corroboratingTimestamps = filenameTimestamps.filter(
    (instant) => instantCorroboratesRange(instant, internal, toleranceMs)
  );
  if (filenameTimestamps.length > 0 && corroboratingTimestamps.length === 0)
    return { status: "conflict" };
  if (candidates.length === 0) return { status: "none" };
  const corroborated = corroboratingTimestamps.length === 0 ? candidates : candidates.filter(
    (candidate) => corroboratingTimestamps.some(
      (instant) => instantCorroboratesRange(
        instant,
        { start: candidate.start_utc, end: candidate.end_utc },
        toleranceMs
      )
    )
  );
  if (corroborated.length === 0) return { status: "conflict" };
  if (corroborated.length > 1) return { status: "ambiguous" };
  return { status: "matched", workout: corroborated[0] };
}
function instantCorroboratesRange(instant, range, toleranceMs) {
  return instant >= range.start - toleranceMs && instant <= range.end + toleranceMs;
}

// packages/importers/src/importer.ts
var IMPORTER_VERSION = "importer-v4";
var IMPORT_DB_CHUNK_ROWS = 2048;
var ImportAbortedError = class extends Error {
  code = "import_cancelled";
  constructor() {
    super("import cancelled");
    this.name = "ImportAbortedError";
  }
};
function throwIfImportAborted(signal) {
  if (signal?.aborted) throw new ImportAbortedError();
}
async function runImportCancellable(db, inputFiles, opts = {}) {
  return runImportGroupsCancellable(db, [() => inputFiles], opts);
}
async function runImportGroupsCancellable(db, inputGroups, opts = {}) {
  throwIfImportAborted(opts.signal);
  db.exec("BEGIN IMMEDIATE");
  try {
    const steps = runImportSteps(db, inputGroups, opts);
    for (; ; ) {
      const step = steps.next();
      if (step.done) {
        db.exec("COMMIT");
        return step.value;
      }
      await new Promise((resolve5) => setTimeout(resolve5, 0));
    }
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
async function preflightImportCancellable(db, inputFiles, opts = {}) {
  return preflightImportGroupsCancellable(db, [() => inputFiles], opts);
}
async function preflightImportGroupsCancellable(db, inputGroups, opts = {}) {
  throwIfImportAborted(opts.signal);
  const records = [];
  const recordByOrigin = /* @__PURE__ */ new WeakMap();
  function* observedGroups() {
    for (const loadGroup of inputGroups) {
      yield () => loadGroup().map((file) => {
        const wrapped = { name: file.name, data: file.data };
        const record = {
          name: wrapped.name,
          sizeBytes: wrapped.data.byteLength,
          outcomes: []
        };
        records.push(record);
        recordByOrigin.set(wrapped, record);
        return wrapped;
      });
    }
  }
  const internalOptions = {
    ...opts,
    onFileOutcome: (outcome) => {
      recordByOrigin.get(outcome.origin)?.outcomes.push(outcome);
    }
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const steps = runImportSteps(db, observedGroups(), internalOptions);
    for (; ; ) {
      const step = steps.next();
      if (step.done) break;
      await new Promise((resolve5) => setTimeout(resolve5, 0));
    }
    db.exec("ROLLBACK");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return records.map(
    (record) => summarizePreflightItem(record.name, record.sizeBytes, record.outcomes)
  );
}
function* importCheckpoint(signal) {
  throwIfImportAborted(signal);
  yield;
  throwIfImportAborted(signal);
}
function* runImportSteps(db, inputGroups, opts) {
  throwIfImportAborted(opts.signal);
  const repo = new Repository(db);
  const now = opts.now ?? Date.now();
  const toleranceMs = opts.toleranceMs ?? DEFAULT_ASSOCIATION_TOLERANCE_MS;
  const zipLimits = opts.zipLimits ?? DEFAULT_ZIP_LIMITS;
  const counts = {
    imported: 0,
    skippedDuplicates: 0,
    skipped: 0,
    skippedByCode: {
      unmodelled_metric: 0,
      non_cycling_workout: 0
    },
    quarantined: 0,
    workoutsCreated: 0,
    workoutsUpdated: 0
  };
  const quarantinedFiles = [];
  yield* importCheckpoint(opts.signal);
  const id = repo.createBatch(IMPORTER_VERSION, now);
  function* processGroup(inputFiles) {
    yield* importCheckpoint(opts.signal);
    const files = [];
    const zipDecodedBudget = createZipDecodedBudget(zipLimits.maxTotalBytes);
    const orderedInputFiles = [...inputFiles].sort(
      (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const f of orderedInputFiles) {
      yield* importCheckpoint(opts.signal);
      if (f.name.toLowerCase().endsWith(".zip")) {
        try {
          const expanded = extractZip(f.data, zipLimits, zipDecodedBudget);
          files.push(...expanded.map((entry) => ({ ...entry, origin: f })));
          if (expanded.length === 0) {
            opts.onFileOutcome?.({
              origin: f,
              classification: "unsupported",
              code: "unsupported_file_type",
              detectedType: "archive:zip"
            });
          }
          yield* importCheckpoint(opts.signal);
        } catch (err) {
          if (err instanceof ImportAbortedError) throw err;
          files.push({
            ...f,
            origin: f,
            expansionError: err instanceof ZipError ? err.code : "io_error"
          });
        }
      } else {
        files.push({ ...f, origin: f });
      }
    }
    files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const file of files) {
      yield* importCheckpoint(opts.signal);
      const candidate = classifyImportFileName(file.name);
      if (candidate.kind === "unmodelled_metric" || candidate.kind === "non_cycling_workout") {
        const code = candidate.kind;
        counts.skipped++;
        counts.skippedByCode[code]++;
        opts.onFileOutcome?.({
          origin: file.origin,
          classification: code,
          code,
          detectedType: candidate.detectedType
        });
        continue;
      }
      const hash = sha256Hex(file.data);
      const existing = repo.findSourceFileByHash(hash);
      const safeName = sanitizeName(file.name);
      const currentParserVersion = parserVersionForFile(file.name);
      if (existing?.parserVersion === currentParserVersion) {
        counts.skippedDuplicates++;
        opts.onFileOutcome?.({
          origin: file.origin,
          classification: "duplicate",
          code: null,
          detectedType: existing.detectedType
        });
        continue;
      }
      const ownedWorkoutIds = existing ? repo.workoutIdsForSourceFile(existing.id) : [];
      const persistSourceFile = (row) => {
        const source = {
          batchId: id,
          originalName: safeName,
          detectedType: row.detectedType,
          parserVersion: row.parserVersion,
          status: row.status,
          sizeBytes: file.data.length,
          ...row.errorCode === void 0 ? {} : { errorCode: row.errorCode }
        };
        if (existing) {
          repo.updateSourceFile(existing.id, source);
          return existing.id;
        }
        return repo.insertSourceFile({ ...source, sha256: hash });
      };
      const quarantine = (code, detectedType2 = "unknown", parserVersion = currentParserVersion) => {
        if (existing) {
          repo.recordSourceFileReprocessingFailure({
            sourceFileId: existing.id,
            batchId: id,
            attemptedParserVersion: parserVersion,
            errorCode: code,
            createdAt: now
          });
        } else {
          persistSourceFile({
            detectedType: detectedType2,
            parserVersion,
            status: "quarantined",
            errorCode: code
          });
        }
        counts.quarantined++;
        quarantinedFiles.push({ name: safeName, code });
        opts.onFileOutcome?.({
          origin: file.origin,
          classification: preflightClassificationForQuarantine(code),
          code,
          detectedType: detectedType2
        });
      };
      if (file.expansionError) {
        quarantine(file.expansionError, "archive:zip", ZIP_PARSER_VERSION);
        continue;
      }
      let parsed;
      let filenameTimestamps;
      try {
        parsed = yield* parseFileSteps(file, opts.timeZone, opts.signal);
        filenameTimestamps = parseHaeFilenameTimestamps(
          file.name,
          opts.timeZone ? { timeZone: opts.timeZone } : {}
        );
      } catch (err) {
        const code = err instanceof AdapterError ? err.code : err instanceof ZipError ? err.code : "io_error";
        quarantine(code);
        continue;
      }
      const range = sampleTimeRange(parsed);
      if (!range) {
        quarantine("timestamps_invalid");
        continue;
      }
      const detectedType = parsed.kind === "metric" ? `metric:${parsed.metric}` : `route:${parsed.format}`;
      let matchedWorkoutId;
      if (existing && ownedWorkoutIds.length > 1) {
        quarantine("association_ambiguous", detectedType);
        continue;
      }
      if (existing && ownedWorkoutIds.length === 1) {
        const fileEvidence = associateWorkout([], range, filenameTimestamps, toleranceMs);
        const ownedWorkout = repo.getWorkout(ownedWorkoutIds[0]);
        if (fileEvidence.status === "conflict" || !ownedWorkout || ownedWorkout.type !== parsed.workoutType) {
          quarantine("association_conflict", detectedType);
          continue;
        }
        matchedWorkoutId = ownedWorkout.id;
      } else {
        const candidates = repo.findCandidateWorkouts(
          parsed.workoutType,
          range.start,
          range.end,
          toleranceMs
        );
        const association = associateWorkout(candidates, range, filenameTimestamps, toleranceMs);
        if (association.status === "ambiguous") {
          quarantine("association_ambiguous", detectedType);
          continue;
        }
        if (association.status === "conflict") {
          quarantine("association_conflict", detectedType);
          continue;
        }
        if (association.status === "matched") matchedWorkoutId = association.workout.id;
      }
      const detachedWorkoutIds = existing ? repo.detachSourceFileData(existing.id) : [];
      const sourceFileId = persistSourceFile({
        detectedType,
        parserVersion: currentParserVersion,
        status: "imported"
      });
      let workoutId;
      if (matchedWorkoutId !== void 0) {
        workoutId = matchedWorkoutId;
        repo.invalidateWorkoutDerivedOutputs(workoutId);
        repo.extendWorkoutSpan(workoutId, range.start, range.end);
        counts.workoutsUpdated++;
      } else {
        workoutId = repo.createWorkout(parsed.workoutType, range.start, range.end, "import");
        counts.workoutsCreated++;
      }
      repo.linkSourceFileToWorkout(workoutId, sourceFileId);
      if (parsed.kind === "metric") {
        yield* insertMetricSeriesSteps(
          repo,
          {
            workoutId,
            sourceFileId,
            metric: parsed.metric,
            unit: CANONICAL_UNITS[parsed.metric],
            source: parsed.source,
            samples: parsed.samples
          },
          opts.signal
        );
      } else {
        const existingFormat = repo.workoutRouteFormat(workoutId);
        if (existingFormat === void 0) {
          yield* insertRouteSteps(
            repo,
            {
              workoutId,
              sourceFileId,
              format: parsed.format,
              segments: parsed.segments,
              distanceM: null
            },
            opts.signal
          );
        } else if (existingFormat === "csv" && parsed.format === "gpx") {
          repo.deleteRoutesForWorkout(workoutId);
          yield* insertRouteSteps(
            repo,
            {
              workoutId,
              sourceFileId,
              format: "gpx",
              segments: parsed.segments,
              distanceM: null
            },
            opts.signal
          );
        }
      }
      if (existing) repo.finalizeSourceFileReprocessing(detachedWorkoutIds);
      counts.imported++;
      opts.onFileOutcome?.({
        origin: file.origin,
        classification: "recognized",
        code: null,
        detectedType
      });
      yield* importCheckpoint(opts.signal);
    }
  }
  for (const loadGroup of inputGroups) {
    yield* importCheckpoint(opts.signal);
    const group = loadGroup();
    yield* importCheckpoint(opts.signal);
    yield* processGroup(group);
  }
  yield* importCheckpoint(opts.signal);
  repo.finishBatch(id, "committed", counts);
  yield* importCheckpoint(opts.signal);
  return { batchId: id, ...counts, quarantinedFiles };
}
function preflightClassificationForQuarantine(code) {
  if (code === "association_ambiguous") return "ambiguous";
  if (code === "unsupported_file_type") return "unsupported";
  return "invalid";
}
function summarizePreflightItem(name, sizeBytes, observed) {
  const outcomes = /* @__PURE__ */ new Map();
  for (const item of observed) {
    const key = `${item.classification}\0${item.code ?? ""}\0${item.detectedType ?? ""}`;
    const existing = outcomes.get(key);
    if (existing) {
      existing.count++;
    } else {
      outcomes.set(key, {
        classification: item.classification,
        code: item.code,
        detectedType: item.detectedType,
        count: 1
      });
    }
  }
  if (outcomes.size === 0) {
    outcomes.set("unsupported\0unsupported_file_type\0", {
      classification: "unsupported",
      code: "unsupported_file_type",
      detectedType: null,
      count: 1
    });
  }
  const summarized = [...outcomes.values()];
  const classifications = new Set(summarized.map((outcome) => outcome.classification));
  const detectedTypes = new Set(
    summarized.map((outcome) => outcome.detectedType).filter((value) => value !== null)
  );
  return {
    name,
    sizeBytes,
    classification: classifications.size === 1 ? summarized[0].classification : "mixed",
    detectedType: detectedTypes.size === 1 ? [...detectedTypes][0] : null,
    outcomes: summarized
  };
}
function* parseFileSteps(file, timeZone, signal) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".gpx")) {
    let text;
    try {
      assertGpxByteLength(file.data.byteLength);
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
    } catch (err) {
      if (err instanceof GpxError) throw new AdapterError(err.code, err.message);
      throw new AdapterError("malformed_xml", "GPX is not valid UTF-8");
    }
    return parseHaeGpx(file.name, text);
  }
  if (lower.endsWith(".csv")) {
    if (!parseHaeFilename(file.name)) {
      throw new AdapterError("unsupported_file_type", "filename not recognized");
    }
    let text;
    try {
      assertCsvByteLength(file.data.byteLength);
      text = new TextDecoder("utf-8", { fatal: false }).decode(file.data);
    } catch (err) {
      if (err instanceof CsvError) throw new AdapterError(err.code, err.message);
      throw err;
    }
    const parseSteps = parseHaeCsvSteps(file.name, text, timeZone ? { timeZone } : {});
    for (; ; ) {
      throwIfImportAborted(signal);
      const step = parseSteps.next();
      if (step.done) return step.value;
      yield* importCheckpoint(signal);
    }
  }
  throw new AdapterError("unsupported_file_type", "extension not supported");
}
function* insertMetricSeriesSteps(repo, row, signal) {
  const first = row.samples[0];
  const last = row.samples[row.samples.length - 1];
  const seriesId = repo.createMetricSeries({
    workoutId: row.workoutId,
    sourceFileId: row.sourceFileId,
    metric: row.metric,
    unit: row.unit,
    source: row.source,
    startUtc: first.t,
    endUtc: last.t,
    sampleCount: row.samples.length
  });
  for (let start = 0; start < row.samples.length; start += IMPORT_DB_CHUNK_ROWS) {
    repo.insertMetricSampleChunk(seriesId, row.samples.slice(start, start + IMPORT_DB_CHUNK_ROWS));
    yield* importCheckpoint(signal);
  }
  return seriesId;
}
function* insertRouteSteps(repo, row, signal) {
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
      if (pointCount % IMPORT_DB_CHUNK_ROWS === 0) yield* importCheckpoint(signal);
    }
  }
  if (pointCount === 0) throw new Error("route_has_no_points");
  const routeId = repo.createRoute({
    workoutId: row.workoutId,
    sourceFileId: row.sourceFileId,
    format: row.format,
    pointCount,
    distanceM: row.distanceM,
    bounds: { latMin, latMax, lonMin, lonMax }
  });
  for (let segmentIndex = 0; segmentIndex < row.segments.length; segmentIndex++) {
    const points = row.segments[segmentIndex].points;
    for (let start = 0; start < points.length; start += IMPORT_DB_CHUNK_ROWS) {
      repo.insertRoutePointChunk(
        routeId,
        segmentIndex,
        start,
        points.slice(start, start + IMPORT_DB_CHUNK_ROWS)
      );
      yield* importCheckpoint(signal);
    }
  }
  return routeId;
}
function parserVersionForFile(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".gpx")) return GPX_PARSER_VERSION;
  if (lower.endsWith(".zip")) return ZIP_PARSER_VERSION;
  return ADAPTER_VERSION;
}
function sanitizeName(name) {
  return name.split(/[\\/]/).filter(Boolean).pop() ?? "unnamed";
}

// packages/importers/src/folder.ts
import {
  closeSync as closeSync2,
  fstatSync as fstatSync2,
  lstatSync as lstatSync3,
  openSync as openSync2,
  opendirSync,
  readSync,
  realpathSync as realpathSync3,
  statSync as statSync2
} from "node:fs";
import { join as join5, relative, resolve as resolve3, sep } from "node:path";
var DEFAULT_MAX_FILES = 5e3;
var DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
var DEFAULT_MAX_GROUP_BYTES = 64 * 1024 * 1024;
var DEFAULT_MAX_VISITED_ENTRIES = 2e4;
var DEFAULT_MAX_DIRECTORIES = 2e3;
var DEFAULT_MAX_DEPTH = 32;
var IMPORTABLE_EXTENSION = /\.(csv|gpx|zip)$/i;
var PLANNED_ENTRY_CHANGE_CODES = /* @__PURE__ */ new Set(["EISDIR", "ELOOP", "ENOENT", "ENOTDIR", "ESTALE"]);
var COOPERATIVE_WALK_BATCH_ENTRIES = 32;
var FolderImportError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "FolderImportError";
    this.code = code;
  }
};
var toPosix = (path) => path.split(sep).join("/");
function identityOf(stats) {
  return {
    device: stats.dev,
    inode: stats.ino,
    sizeBytes: stats.size,
    modifiedMs: stats.mtimeMs,
    changedMs: stats.ctimeMs
  };
}
function sameIdentity(expected, actual, includeContentMetadata = true) {
  return expected.device === actual.device && expected.inode === actual.inode && (!includeContentMetadata || expected.sizeBytes === actual.sizeBytes && expected.modifiedMs === actual.modifiedMs && expected.changedMs === actual.changedMs);
}
function checkNotInsideCheckout(dir) {
  try {
    guardAgainstCheckout(dir);
  } catch (err) {
    throw new FolderImportError(
      "inside_checkout",
      err instanceof Error ? err.message : "path resolves inside a git checkout"
    );
  }
}
function insideCanonicalRoot(canonicalRoot, candidate) {
  return candidate === canonicalRoot || candidate.startsWith(canonicalRoot + sep);
}
function isPlannedEntryChange(error) {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && PLANNED_ENTRY_CHANGE_CODES.has(error.code);
}
function* walkImportFolderSteps(rootPath, opts = {}, testHooks = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxVisitedEntries = opts.maxVisitedEntries ?? DEFAULT_MAX_VISITED_ENTRIES;
  const maxDirectories = opts.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const root = resolve3(rootPath);
  checkNotInsideCheckout(root);
  let rootStats;
  try {
    rootStats = statSync2(root);
  } catch {
    throw new FolderImportError("path_not_found", "path does not exist");
  }
  if (!rootStats.isDirectory()) {
    throw new FolderImportError("not_a_directory", "path is not a directory");
  }
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync3(root);
  } catch {
    throw new FolderImportError("path_not_found", "path does not exist");
  }
  checkNotInsideCheckout(canonicalRoot);
  const rootIdentity = identityOf(rootStats);
  const rootExpectation = {
    canonicalPath: canonicalRoot,
    identity: rootIdentity,
    followSymbolicPath: true
  };
  const manifestEntries = [];
  const files = [];
  const skipped = [];
  let visitedEntries = 0;
  let visitedDirectories = 0;
  let totalBytes = 0;
  let truncated = false;
  let traversalStopped = false;
  const relativeToRoot = (path) => toPosix(relative(root, path)) || ".";
  const directoryChanged = () => new FolderImportError("path_changed", "folder changed during traversal");
  function readDirectoryState(dirPath, followSymbolicPath) {
    try {
      const canonicalBefore = realpathSync3(dirPath);
      const stats = followSymbolicPath ? statSync2(dirPath) : lstatSync3(dirPath);
      const canonicalAfter = realpathSync3(dirPath);
      if (canonicalBefore !== canonicalAfter || !stats.isDirectory() || !insideCanonicalRoot(canonicalRoot, canonicalAfter)) {
        throw directoryChanged();
      }
      return {
        canonicalPath: canonicalAfter,
        identity: identityOf(stats),
        followSymbolicPath
      };
    } catch (err) {
      if (err instanceof FolderImportError) throw err;
      throw directoryChanged();
    }
  }
  function revalidateDirectory(dirPath, expected) {
    const actual = readDirectoryState(dirPath, expected.followSymbolicPath);
    if (actual.canonicalPath !== expected.canonicalPath || !sameIdentity(expected.identity, actual.identity, false)) {
      throw directoryChanged();
    }
  }
  function captureNestedDirectory(dirPath, entryStats) {
    const captured = readDirectoryState(dirPath, false);
    if (!sameIdentity(identityOf(entryStats), captured.identity, false)) {
      throw directoryChanged();
    }
    return captured;
  }
  function addManifestEntry(fullPath, kind, stats, target) {
    manifestEntries.push({
      relativePath: relativeToRoot(fullPath),
      kind,
      ...identityOf(stats),
      ...target ? {
        canonicalTarget: target.canonicalPath,
        targetIdentity: identityOf(target.stats)
      } : {}
    });
  }
  function addFile(fullPath, symbolicLink, target) {
    let canonicalPath;
    let targetStats;
    try {
      canonicalPath = target?.canonicalPath ?? realpathSync3(fullPath);
      targetStats = target?.stats ?? statSync2(fullPath);
    } catch {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: "unreadable" });
      return;
    }
    if (!insideCanonicalRoot(canonicalRoot, canonicalPath)) {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: "symlink_outside_tree" });
      return;
    }
    if (!targetStats.isFile()) {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: "not_a_regular_file" });
      return;
    }
    if (files.length >= maxFiles) {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: "max_files_exceeded" });
      truncated = true;
      return;
    }
    if (totalBytes + targetStats.size > maxTotalBytes) {
      skipped.push({ relativePath: relativeToRoot(fullPath), reason: "max_total_bytes_exceeded" });
      truncated = true;
      return;
    }
    totalBytes += targetStats.size;
    files.push({
      relativePath: relativeToRoot(fullPath),
      absolutePath: fullPath,
      canonicalPath,
      symbolicLink,
      ...identityOf(targetStats)
    });
  }
  function stopForEntryLimit(fullPath) {
    skipped.push({ relativePath: relativeToRoot(fullPath), reason: "max_entries_exceeded" });
    truncated = true;
    traversalStopped = true;
  }
  function* walk(dirPath, depth, expected) {
    if (traversalStopped) return;
    if (depth > maxDepth) {
      skipped.push({ relativePath: relativeToRoot(dirPath), reason: "max_depth_exceeded" });
      truncated = true;
      return;
    }
    if (visitedDirectories >= maxDirectories) {
      skipped.push({
        relativePath: relativeToRoot(dirPath),
        reason: "max_directories_exceeded"
      });
      truncated = true;
      return;
    }
    revalidateDirectory(dirPath, expected);
    testHooks.beforeDirectoryOpen?.(relativeToRoot(dirPath));
    revalidateDirectory(dirPath, expected);
    let dir;
    try {
      dir = opendirSync(dirPath);
      visitedDirectories++;
    } catch (err) {
      if (isPlannedEntryChange(err)) throw directoryChanged();
      skipped.push({ relativePath: relativeToRoot(dirPath), reason: "unreadable" });
      return;
    }
    try {
      for (; ; ) {
        const entry = dir.readSync();
        if (!entry) break;
        const fullPath = join5(dirPath, entry.name);
        if (visitedEntries >= maxVisitedEntries) {
          stopForEntryLimit(fullPath);
          return;
        }
        visitedEntries++;
        yield;
        let entryStats;
        try {
          entryStats = lstatSync3(fullPath);
        } catch {
          skipped.push({ relativePath: relativeToRoot(fullPath), reason: "unreadable" });
          continue;
        }
        if (entryStats.isSymbolicLink()) {
          let targetStats;
          let canonicalTarget;
          try {
            canonicalTarget = realpathSync3(fullPath);
            targetStats = statSync2(fullPath);
            addManifestEntry(fullPath, "symlink", entryStats, {
              canonicalPath: canonicalTarget,
              stats: targetStats
            });
          } catch {
            addManifestEntry(fullPath, "symlink", entryStats);
            skipped.push({ relativePath: relativeToRoot(fullPath), reason: "unreadable" });
            continue;
          }
          if (!insideCanonicalRoot(canonicalRoot, canonicalTarget)) {
            skipped.push({
              relativePath: relativeToRoot(fullPath),
              reason: "symlink_outside_tree"
            });
            continue;
          }
          if (targetStats.isDirectory()) {
            skipped.push({
              relativePath: relativeToRoot(fullPath),
              reason: "symlink_directory_skipped"
            });
            continue;
          }
          if (!targetStats.isFile()) {
            skipped.push({ relativePath: relativeToRoot(fullPath), reason: "not_a_regular_file" });
            continue;
          }
          if (!IMPORTABLE_EXTENSION.test(entry.name)) {
            skipped.push({
              relativePath: relativeToRoot(fullPath),
              reason: "unsupported_file_type"
            });
            continue;
          }
          addFile(fullPath, true, { canonicalPath: canonicalTarget, stats: targetStats });
          continue;
        }
        if (entryStats.isDirectory()) {
          const childExpectation = captureNestedDirectory(fullPath, entryStats);
          addManifestEntry(fullPath, "directory", entryStats);
          yield* walk(fullPath, depth + 1, childExpectation);
          if (traversalStopped) return;
          continue;
        }
        if (entryStats.isFile()) {
          addManifestEntry(fullPath, "file", entryStats);
          if (IMPORTABLE_EXTENSION.test(entry.name)) {
            addFile(fullPath, false);
          } else {
            skipped.push({
              relativePath: relativeToRoot(fullPath),
              reason: "unsupported_file_type"
            });
          }
          continue;
        }
        addManifestEntry(fullPath, "other", entryStats);
        skipped.push({ relativePath: relativeToRoot(fullPath), reason: "not_a_regular_file" });
      }
    } finally {
      try {
        dir.closeSync();
      } catch {
      }
      revalidateDirectory(dirPath, expected);
    }
  }
  yield* walk(root, 0, rootExpectation);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  manifestEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  skipped.sort(
    (a, b) => a.relativePath.localeCompare(b.relativePath) || a.reason.localeCompare(b.reason)
  );
  return {
    root,
    canonicalRoot,
    rootDevice: rootIdentity.device,
    rootInode: rootIdentity.inode,
    manifestEntries,
    files,
    skipped,
    visitedEntries,
    visitedDirectories,
    totalBytes,
    truncated
  };
}
function yieldToFolderRequestEvents() {
  return new Promise((resolve5) => setImmediate(resolve5));
}
async function walkImportFolderCancellable(rootPath, opts = {}, signal, testHooks = {}) {
  throwIfImportAborted(signal);
  const steps = walkImportFolderSteps(rootPath, opts, testHooks);
  let checkpoints = 0;
  try {
    for (; ; ) {
      throwIfImportAborted(signal);
      const step = steps.next();
      if (step.done) return step.value;
      checkpoints++;
      if (checkpoints === 1 || checkpoints % COOPERATIVE_WALK_BATCH_ENTRIES === 0) {
        await yieldToFolderRequestEvents();
        throwIfImportAborted(signal);
      }
    }
  } catch (err) {
    try {
      steps.throw(err);
    } catch {
    }
    throw err;
  }
}
function fileName(file) {
  return file.relativePath.split("/").pop() ?? file.relativePath;
}
function groupFor(file) {
  const name = fileName(file);
  if (/\.zip$/i.test(name)) {
    return {
      groupKey: `zip:${file.relativePath}`,
      kind: "zip_archive"
    };
  }
  const info = parseHaeFilename(name);
  if (!info) {
    return {
      groupKey: `unrecognized:${file.relativePath}`,
      kind: "unrecognized_filename"
    };
  }
  const stampHint = info.stampHint ?? "";
  return {
    groupKey: `ride:${info.workoutType}:${stampHint}`,
    kind: "ride",
    workoutType: info.workoutType,
    stampHint
  };
}
function compareGroups(a, b) {
  const rank = (group) => group.kind === "ride" ? 0 : group.kind === "zip_archive" ? 1 : 2;
  const rankDifference = rank(a) - rank(b);
  if (rankDifference !== 0) return rankDifference;
  if (a.kind === "ride" && b.kind === "ride") {
    const stampDifference = (a.stampHint ?? "").localeCompare(b.stampHint ?? "");
    if (stampDifference !== 0) return stampDifference;
    const typeDifference = (a.workoutType ?? "").localeCompare(b.workoutType ?? "");
    if (typeDifference !== 0) return typeDifference;
  }
  return a.groupKey.localeCompare(b.groupKey);
}
function buildFolderImportPlan(walk, opts) {
  const maxGroupBytes = opts.maxGroupBytes ?? DEFAULT_MAX_GROUP_BYTES;
  const limits = {
    maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
    maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxGroupBytes,
    maxVisitedEntries: opts.maxVisitedEntries ?? DEFAULT_MAX_VISITED_ENTRIES,
    maxDirectories: opts.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH
  };
  const byKey = /* @__PURE__ */ new Map();
  for (const file of walk.files) {
    const identity = groupFor(file);
    const group = byKey.get(identity.groupKey) ?? {
      ...identity,
      files: [],
      totalBytes: 0
    };
    group.files.push(file);
    group.totalBytes += file.sizeBytes;
    byKey.set(group.groupKey, group);
  }
  const skipped = [...walk.skipped];
  const groups = [];
  let truncated = walk.truncated;
  for (const group of byKey.values()) {
    group.files.sort((a, b) => {
      const nameDifference = fileName(a).localeCompare(fileName(b));
      return nameDifference || a.relativePath.localeCompare(b.relativePath);
    });
    if (group.totalBytes > maxGroupBytes) {
      truncated = true;
      for (const file of group.files) {
        skipped.push({
          relativePath: file.relativePath,
          reason: "max_group_bytes_exceeded"
        });
      }
      continue;
    }
    groups.push(group);
  }
  groups.sort(compareGroups);
  return {
    root: walk.root,
    canonicalRoot: walk.canonicalRoot,
    rootDevice: walk.rootDevice,
    rootInode: walk.rootInode,
    manifestEntries: walk.manifestEntries,
    groups,
    skipped,
    visitedEntries: walk.visitedEntries,
    visitedDirectories: walk.visitedDirectories,
    totalFiles: groups.reduce((sum, group) => sum + group.files.length, 0),
    totalBytes: groups.reduce((sum, group) => sum + group.totalBytes, 0),
    truncated,
    limits
  };
}
async function planFolderImportCancellable(rootPath, opts = {}, signal, testHooks = {}) {
  const walk = await walkImportFolderCancellable(rootPath, opts, signal, testHooks);
  throwIfImportAborted(signal);
  const plan = buildFolderImportPlan(walk, opts);
  throwIfImportAborted(signal);
  return plan;
}
function planConfirmationToken(plan) {
  return sha256Hex(
    stableStringify({
      version: 1,
      root: {
        requested: plan.root,
        canonical: plan.canonicalRoot,
        device: plan.rootDevice,
        inode: plan.rootInode
      },
      manifestEntries: plan.manifestEntries,
      groups: plan.groups,
      skipped: plan.skipped,
      visitedEntries: plan.visitedEntries,
      visitedDirectories: plan.visitedDirectories,
      totalFiles: plan.totalFiles,
      totalBytes: plan.totalBytes,
      truncated: plan.truncated,
      limits: plan.limits
    })
  );
}
function confirmFolderImportPlan(plan, token) {
  if (!/^[a-f0-9]{64}$/.test(token) || token !== planConfirmationToken(plan)) {
    throw new FolderImportError("path_changed", "folder changed after preview");
  }
  if (plan.truncated) {
    throw new FolderImportError(
      "folder_limits_exceeded",
      "folder preview exceeded safe traversal limits"
    );
  }
}
function previewFolderImportPlan(plan, preflight = [], preflightComplete = false) {
  const rides = [];
  const ungrouped = [];
  const orderedFiles = plan.groups.flatMap((group) => group.files);
  if (preflight.length > orderedFiles.length || preflightComplete && preflight.length !== orderedFiles.length) {
    throw new Error("folder_preflight_plan_mismatch");
  }
  for (const group of plan.groups) {
    if (group.kind === "ride") {
      rides.push({
        rideKey: `${group.workoutType ?? ""}:${group.stampHint ?? ""}`,
        workoutType: group.workoutType ?? "",
        stampHint: group.stampHint ?? "",
        files: group.files.map((file) => {
          const name = fileName(file);
          const info = parseHaeFilename(name);
          return {
            relativePath: file.relativePath,
            name,
            sizeBytes: file.sizeBytes,
            label: info.label,
            format: name.toLowerCase().endsWith(".gpx") ? "gpx" : "csv"
          };
        })
      });
      continue;
    }
    for (const file of group.files) {
      ungrouped.push({
        relativePath: file.relativePath,
        name: fileName(file),
        sizeBytes: file.sizeBytes,
        classification: group.kind
      });
    }
  }
  return {
    rides,
    ungrouped,
    skipped: plan.skipped,
    visitedEntries: plan.visitedEntries,
    visitedDirectories: plan.visitedDirectories,
    totalFiles: plan.totalFiles,
    totalBytes: plan.totalBytes,
    truncated: plan.truncated,
    confirmationToken: planConfirmationToken(plan),
    preflightComplete,
    preflight: preflight.map((item, index) => ({
      ...item,
      relativePath: orderedFiles[index].relativePath
    }))
  };
}
function revalidateRoot(plan) {
  try {
    const canonicalRoot = realpathSync3(plan.root);
    const stats = statSync2(plan.root);
    if (canonicalRoot !== plan.canonicalRoot || !stats.isDirectory() || stats.dev !== plan.rootDevice || stats.ino !== plan.rootInode) {
      throw new FolderImportError("path_changed", "folder changed after traversal");
    }
    checkNotInsideCheckout(canonicalRoot);
  } catch (err) {
    if (err instanceof FolderImportError) throw err;
    throw new FolderImportError("path_changed", "folder changed after traversal");
  }
}
function readExact(fd, sizeBytes) {
  const data = Buffer.allocUnsafe(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const count = readSync(fd, data, offset, sizeBytes - offset, offset);
    if (count === 0) {
      throw new FolderImportError("file_changed", "file changed during import");
    }
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  if (readSync(fd, extra, 0, 1, sizeBytes) !== 0) {
    throw new FolderImportError("file_changed", "file changed during import");
  }
  return data;
}
function readPlannedFile(plan, file) {
  revalidateRoot(plan);
  let fd;
  try {
    const linkStats = lstatSync3(file.absolutePath);
    if (file.symbolicLink && !linkStats.isSymbolicLink() || !file.symbolicLink && !linkStats.isFile()) {
      throw new FolderImportError("file_changed", "file changed after traversal");
    }
    const canonicalPath = realpathSync3(file.absolutePath);
    if (canonicalPath !== file.canonicalPath || !insideCanonicalRoot(plan.canonicalRoot, canonicalPath)) {
      throw new FolderImportError("file_changed", "file changed after traversal");
    }
    fd = openSync2(file.absolutePath, "r");
    const before = fstatSync2(fd);
    const beforeIdentity = identityOf(before);
    if (!before.isFile() || !sameIdentity(file, beforeIdentity)) {
      throw new FolderImportError("file_changed", "file changed after traversal");
    }
    const data = readExact(fd, file.sizeBytes);
    const after = fstatSync2(fd);
    if (!after.isFile() || !sameIdentity(beforeIdentity, identityOf(after))) {
      throw new FolderImportError("file_changed", "file changed during import");
    }
    revalidateRoot(plan);
    return { name: fileName(file), data };
  } catch (err) {
    if (err instanceof FolderImportError) throw err;
    if (isPlannedEntryChange(err)) {
      throw new FolderImportError("file_changed", "file changed after traversal");
    }
    throw new FolderImportError("file_unreadable", "file could not be read safely");
  } finally {
    if (fd !== void 0) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
  }
}
function* readFolderFileGroups(plan) {
  for (const group of plan.groups) {
    yield () => {
      revalidateRoot(plan);
      const files = [];
      for (const file of group.files) {
        files.push(readPlannedFile(plan, file));
      }
      return files;
    };
  }
}

// packages/analytics/src/settings.ts
var DEFAULT_ANALYTICS_SETTINGS = {
  hrZoneBounds: null,
  movingSpeedThresholdMs: 1,
  minCoverageForEfficiency: 0.7,
  elevationHysteresisM: 1
};
var ANALYTICS_SETTING_KEYS = [
  "hrZoneBounds",
  "movingSpeedThresholdMs",
  "minCoverageForEfficiency",
  "elevationHysteresisM"
];
var InvalidAnalyticsSettingsError = class extends Error {
  code = "invalid_analytics_settings";
  constructor() {
    super("invalid_analytics_settings");
    this.name = "InvalidAnalyticsSettingsError";
  }
};
function failSettings() {
  throw new InvalidAnalyticsSettingsError();
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteNumberInRange(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return failSettings();
  }
  return value;
}
function parseAnalyticsSettings(value) {
  if (!isRecord(value)) return failSettings();
  const keys = Object.keys(value);
  if (keys.length !== ANALYTICS_SETTING_KEYS.length || keys.some((key) => !ANALYTICS_SETTING_KEYS.includes(key))) {
    return failSettings();
  }
  const rawBounds = value["hrZoneBounds"];
  let hrZoneBounds;
  if (rawBounds === null) {
    hrZoneBounds = null;
  } else {
    if (!Array.isArray(rawBounds) || rawBounds.length !== 5 || rawBounds.some(
      (bound) => typeof bound !== "number" || !Number.isFinite(bound) || !Number.isInteger(bound) || bound < 40 || bound > 230
    ) || rawBounds.some((bound, index) => index > 0 && bound <= rawBounds[index - 1])) {
      return failSettings();
    }
    hrZoneBounds = [...rawBounds];
  }
  const minCoverageForEfficiency = finiteNumberInRange(value["minCoverageForEfficiency"], 0, 1);
  if (minCoverageForEfficiency <= 0) return failSettings();
  return {
    hrZoneBounds,
    movingSpeedThresholdMs: finiteNumberInRange(value["movingSpeedThresholdMs"], 0, 30),
    minCoverageForEfficiency,
    elevationHysteresisM: finiteNumberInRange(value["elevationHysteresisM"], 0, 100)
  };
}
var ZONE_LABELS = [
  "Z1 Recovery",
  "Z2 Endurance",
  "Z3 Tempo",
  "Z4 Threshold",
  "Z5 VO2 Max",
  "Z6 Anaerobic"
];

// packages/analytics/src/engine.ts
var FORMULA_VERSION = "analytics-v2";
var COVERAGE_GAP_CAP_MS = 9e4;
var SINGLE_SAMPLE_COVERAGE_MS = 6e4;
var MIN_DECOUPLING_BASELINE = 0.01;
var MAX_ABS_DECOUPLING_PCT = 100;
var round3 = (v) => Math.round(v * 1e3) / 1e3;
var round1 = (v) => Math.round(v * 10) / 10;
function computeRideAnalytics(input, settings) {
  const { startUtc, endUtc } = input.workout;
  const durationS = Math.max(0, Math.round((endUtc - startUtc) / 1e3));
  const unavailable = {};
  const hrSamples = input.metrics.heart_rate ?? [];
  const cadSamples = input.metrics.cadence ?? [];
  const distSamples = input.metrics.distance ?? [];
  const energySamples = input.metrics.energy ?? [];
  const heartRateWindow = metricStat(hrSamples, startUtc, endUtc);
  const heartRate = heartRateWindow.stat;
  const cadence = metricStat(cadSamples, startUtc, endUtc).stat;
  const distanceM = distSamples.length ? round3(distSamples.reduce((acc, s) => acc + s.value, 0)) : null;
  if (distanceM == null) unavailable["distance"] = "no_distance_samples";
  const energyKj = energySamples.length ? round3(energySamples.reduce((acc, s) => acc + s.value, 0) / 1e3) : null;
  if (energyKj == null) unavailable["energy"] = "no_energy_samples";
  const routeSpeeds = collectRouteSpeeds(input.route);
  const routeTiming = routeWindowStats(
    input.route,
    settings.movingSpeedThresholdMs,
    startUtc,
    endUtc
  );
  const movingTimeS = routeTiming.coveredMs > 0 ? round3(routeTiming.movingMs / 1e3) : null;
  if (movingTimeS == null) unavailable["moving_time"] = "no_route_timing";
  const avgSpeedMs = distanceM != null && movingTimeS != null && movingTimeS > 0 ? round3(distanceM / movingTimeS) : distanceM != null && durationS > 0 ? round3(distanceM / durationS) : null;
  if (avgSpeedMs == null) unavailable["avg_speed"] = "no_distance_or_duration";
  const maxSpeedMs = routeSpeeds.length ? round3(routeSpeeds.reduce((maximum, speed) => Math.max(maximum, speed), -Infinity)) : null;
  if (maxSpeedMs == null) unavailable["max_speed"] = "no_route_speeds";
  const elevation = elevationProfile(input.route, settings.elevationHysteresisM);
  if (elevation.gainM == null) unavailable["elevation"] = "no_elevation_data";
  const zones = settings.hrZoneBounds ? zoneTimes(hrSamples, settings.hrZoneBounds, startUtc, endUtc) : null;
  if (!settings.hrZoneBounds) unavailable["zones"] = "zones_not_configured";
  const efficiency = efficiencyRatio(
    avgSpeedMs,
    heartRateWindow,
    settings.minCoverageForEfficiency
  );
  if (efficiency == null) unavailable["efficiency"] = "insufficient_coverage_or_inputs";
  const decouplingResult = decoupling(input, settings);
  const decouplingPct = decouplingResult.value;
  if (decouplingPct == null) {
    unavailable["decoupling"] = decouplingResult.reason ?? "insufficient_half_data";
  }
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
function metricStat(samples, from, to) {
  if (samples.length === 0) {
    return {
      stat: { avg: null, max: null, min: null, coverage: null, sampleCount: 0 },
      rawCoverage: null
    };
  }
  const weights = intervalWeights(samples, from, to);
  let wSum = 0;
  let vSum = 0;
  let max = -Infinity;
  let min = Infinity;
  samples.forEach((s, i) => {
    const w = weights[i];
    if (w <= 0) return;
    wSum += w;
    vSum += s.value * w;
    const hi = s.max ?? s.value;
    const lo = s.min ?? s.value;
    if (hi > max) max = hi;
    if (lo < min) min = lo;
  });
  const windowMs = Math.max(0, to - from);
  const rawCoverage = windowMs > 0 ? Math.min(1, wSum / windowMs) : null;
  return {
    stat: {
      avg: wSum > 0 ? round3(vSum / wSum) : null,
      max: max === -Infinity ? null : round3(max),
      min: min === Infinity ? null : round3(min),
      coverage: rawCoverage != null ? round3(rawCoverage) : null,
      sampleCount: samples.length
    },
    rawCoverage
  };
}
function intervalWeights(samples, from, to) {
  const n = samples.length;
  const gaps = [];
  for (let i = 0; i < n - 1; i++) {
    const gap = samples[i + 1].t - samples[i].t;
    if (gap > 0) gaps.push(Math.min(gap, COVERAGE_GAP_CAP_MS));
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const middle = Math.floor(sortedGaps.length / 2);
  const median = sortedGaps.length === 0 ? SINGLE_SAMPLE_COVERAGE_MS : sortedGaps.length % 2 === 1 ? sortedGaps[middle] : (sortedGaps[middle - 1] + sortedGaps[middle]) / 2;
  return samples.map((sample, index) => {
    const next = samples[index + 1];
    const forwardMs = next ? Math.min(Math.max(0, next.t - sample.t), COVERAGE_GAP_CAP_MS) : median;
    const coveredFrom = Math.max(from, sample.t);
    const coveredTo = Math.min(to, sample.t + forwardMs);
    return Math.max(0, coveredTo - coveredFrom);
  });
}
function collectRouteSpeeds(route2) {
  const speeds = [];
  for (const seg of route2) {
    for (const p of seg.points) {
      if (p.speed != null && Number.isFinite(p.speed)) speeds.push(p.speed);
    }
  }
  if (speeds.length > 0) return speeds;
  for (const seg of route2) {
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
function unionDuration(intervals) {
  if (intervals.length === 0) return 0;
  const ordered = [...intervals].sort((a, b) => a.from - b.from || a.to - b.to);
  let total = 0;
  let from = ordered[0].from;
  let to = ordered[0].to;
  for (let index = 1; index < ordered.length; index++) {
    const interval = ordered[index];
    if (interval.from > to) {
      total += to - from;
      from = interval.from;
      to = interval.to;
    } else if (interval.to > to) {
      to = interval.to;
    }
  }
  return total + (to - from);
}
function routeWindowStats(route2, thresholdMs, from, to) {
  const covered = [];
  const moving = [];
  for (const seg of route2) {
    for (let i = 0; i < seg.points.length - 1; i++) {
      const a = seg.points[i];
      const b = seg.points[i + 1];
      if (a.t == null || b.t == null || b.t <= a.t) continue;
      const interval = {
        from: Math.max(from, a.t),
        to: Math.min(to, a.t + Math.min(b.t - a.t, COVERAGE_GAP_CAP_MS))
      };
      if (interval.to <= interval.from) continue;
      covered.push(interval);
      const speed = a.speed ?? haversineM(a.lat, a.lon, b.lat, b.lon) / ((b.t - a.t) / 1e3);
      if (Number.isFinite(speed) && speed >= thresholdMs) moving.push(interval);
    }
  }
  return { coveredMs: unionDuration(covered), movingMs: unionDuration(moving) };
}
function elevationProfile(route2, hysteresisM) {
  const eles = [];
  let gain = 0;
  let loss = 0;
  for (const seg of route2) {
    const segmentEles = [];
    for (const p of seg.points) {
      if (p.ele != null) {
        eles.push(p.ele);
        segmentEles.push(p.ele);
      }
    }
    if (segmentEles.length < 2) continue;
    let anchor = segmentEles[0];
    for (const elevation of segmentEles.slice(1)) {
      const delta = elevation - anchor;
      if (delta >= hysteresisM) {
        gain += delta;
        anchor = elevation;
      } else if (delta <= -hysteresisM) {
        loss += -delta;
        anchor = elevation;
      }
    }
  }
  if (eles.length < 2) return { gainM: null, lossM: null, minM: null, maxM: null };
  return {
    gainM: round1(gain),
    lossM: round1(loss),
    minM: round1(eles.reduce((minimum, elevation) => Math.min(minimum, elevation), Infinity)),
    maxM: round1(eles.reduce((maximum, elevation) => Math.max(maximum, elevation), -Infinity))
  };
}
function zoneTimes(samples, bounds, from, to) {
  const zoneCount = bounds.length + 1;
  const ms = new Array(zoneCount).fill(0);
  if (samples.length > 0) {
    const weights = intervalWeights(samples, from, to);
    samples.forEach((s, i) => {
      if (weights[i] <= 0) return;
      let z = 0;
      while (z < bounds.length && s.value >= bounds[z]) z++;
      ms[z] += weights[i];
    });
  }
  const windowMs = Math.max(0, to - from);
  const totalMs = ms.reduce((a, b) => a + b, 0);
  const targetSeconds = Math.min(Math.floor(windowMs / 1e3), Math.round(totalMs / 1e3));
  const seconds = ms.map((value) => Math.floor(value / 1e3));
  let remaining = Math.max(0, targetSeconds - seconds.reduce((sum, value) => sum + value, 0));
  const remainderOrder = ms.map((value, index) => ({ index, remainder: value / 1e3 - Math.floor(value / 1e3) })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of remainderOrder) {
    if (remaining === 0) break;
    seconds[entry.index] += 1;
    remaining--;
  }
  return ms.map((m, i) => ({
    zone: i + 1,
    label: ZONE_LABELS[i] ?? `Z${i + 1}`,
    seconds: seconds[i],
    share: windowMs > 0 ? round3(m / windowMs) : 0
  }));
}
function efficiencyRatio(avgSpeedMs, hr, minCoverage) {
  if (avgSpeedMs == null || hr.stat.avg == null || hr.rawCoverage == null) return null;
  if (hr.rawCoverage < minCoverage || hr.stat.avg <= 0) return null;
  return round3(avgSpeedMs * 3.6 / hr.stat.avg);
}
function distanceIntervals(samples, workoutStart) {
  const intervals = [];
  let previous = workoutStart;
  for (const sample of samples) {
    intervals.push({ from: previous, to: sample.t, meters: sample.value });
    if (sample.t > previous) previous = sample.t;
  }
  return intervals;
}
function distanceInWindow(intervals, from, to) {
  const windowMs = Math.max(0, to - from);
  if (windowMs === 0) return { meters: 0, coverage: 0 };
  let meters = 0;
  const coverageIntervals = [];
  for (const interval of intervals) {
    const duration = interval.to - interval.from;
    if (duration <= 0 || !Number.isFinite(interval.meters)) continue;
    const overlapFrom = Math.max(from, interval.from);
    const overlapTo = Math.min(to, interval.to);
    if (overlapTo > overlapFrom) {
      meters += interval.meters * ((overlapTo - overlapFrom) / duration);
    }
    const covered = {
      from: Math.max(from, interval.from, interval.to - COVERAGE_GAP_CAP_MS),
      to: Math.min(to, interval.to)
    };
    if (covered.to > covered.from) coverageIntervals.push(covered);
  }
  return {
    meters,
    coverage: Math.min(1, unionDuration(coverageIntervals) / windowMs)
  };
}
function decoupling(input, settings) {
  const hr = input.metrics.heart_rate ?? [];
  const dist = input.metrics.distance ?? [];
  if (hr.length === 0 || dist.length === 0) {
    return { value: null, reason: "insufficient_half_samples" };
  }
  const mid = input.workout.startUtc + (input.workout.endUtc - input.workout.startUtc) / 2;
  const distance = distanceIntervals(dist, input.workout.startUtc);
  const halfEff = (from, to) => {
    const stat = metricStat(hr, from, to);
    if (stat.stat.avg == null || stat.stat.avg <= 0 || stat.rawCoverage == null || stat.rawCoverage < settings.minCoverageForEfficiency) {
      return { value: null, reason: "insufficient_half_hr_coverage" };
    }
    const distanceHalf = distanceInWindow(distance, from, to);
    if (distanceHalf.coverage < settings.minCoverageForEfficiency) {
      return { value: null, reason: "insufficient_half_distance_coverage" };
    }
    const routeHalf = routeWindowStats(input.route, settings.movingSpeedThresholdMs, from, to);
    const routeCoverage = routeHalf.coveredMs / Math.max(1, to - from);
    if (routeCoverage < settings.minCoverageForEfficiency) {
      return { value: null, reason: "insufficient_half_route_coverage" };
    }
    if (routeHalf.movingMs <= 0 || distanceHalf.meters <= 0) {
      return { value: null, reason: "no_half_moving_time_or_distance" };
    }
    const speedKmh = distanceHalf.meters / (routeHalf.movingMs / 1e3) * 3.6;
    const value2 = speedKmh / stat.stat.avg;
    return Number.isFinite(value2) ? { value: value2 } : { value: null, reason: "unstable_half_efficiency" };
  };
  const first = halfEff(input.workout.startUtc, mid);
  const second = halfEff(mid, input.workout.endUtc);
  if (first.value == null) {
    return { value: null, reason: first.reason ?? "insufficient_first_half_data" };
  }
  if (second.value == null) {
    return { value: null, reason: second.reason ?? "insufficient_second_half_data" };
  }
  if (first.value < MIN_DECOUPLING_BASELINE) {
    return { value: null, reason: "unstable_first_half_efficiency" };
  }
  const value = (first.value - second.value) / first.value * 100;
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_DECOUPLING_PCT) {
    return { value: null, reason: "implausible_decoupling" };
  }
  return { value: round3(value) };
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
  const distance = distanceIntervals(dist, start);
  let cum = 0;
  let thresholdM = 1e3;
  let previousCrossingT = start;
  let splitHasCompleteTiming = true;
  for (const interval of distance) {
    const increment = Number.isFinite(interval.meters) ? Math.max(0, interval.meters) : 0;
    const before = cum;
    cum += increment;
    if (increment > 0 && interval.to <= interval.from) splitHasCompleteTiming = false;
    while (thresholdM <= cum && increment > 0) {
      const fraction = (thresholdM - before) / increment;
      const crossingT = interval.to > interval.from && fraction >= 0 && fraction <= 1 ? interval.from + fraction * (interval.to - interval.from) : null;
      const index = thresholdM / 1e3;
      if (splitHasCompleteTiming && crossingT != null && previousCrossingT != null && crossingT > previousCrossingT) {
        const durationMs = crossingT - previousCrossingT;
        splits.push({
          index,
          kind: "km",
          startOffsetS: round3((previousCrossingT - start) / 1e3),
          durationS: round3(durationMs / 1e3),
          distanceM: 1e3,
          avgSpeedMs: round3(1e6 / durationMs),
          avgHr: avgInWindow(hr, previousCrossingT, crossingT)
        });
      }
      previousCrossingT = crossingT;
      splitHasCompleteTiming = crossingT != null;
      thresholdM += 1e3;
    }
  }
  const windowMs = 5 * 60 * 1e3;
  let idx = 0;
  for (let t = start; t < input.workout.endUtc; t += windowMs) {
    idx++;
    const to = Math.min(t + windowMs, input.workout.endUtc);
    const meters = distanceInWindow(distance, t, to).meters;
    const durationS = round3((to - t) / 1e3);
    splits.push({
      index: idx,
      kind: "time",
      startOffsetS: round3((t - start) / 1e3),
      durationS,
      distanceM: meters > 0 ? round3(meters) : null,
      avgSpeedMs: meters > 0 && durationS > 0 ? round3(meters / durationS) : null,
      avgHr: avgInWindow(hr, t, to)
    });
  }
  return splits;
}
function avgInWindow(samples, from, to) {
  return metricStat(samples, from, to).stat.avg;
}

// apps/api/src/analytics-service.ts
var SETTINGS_KEY = "analytics";
var APP_SETTING_KEYS = [
  "hrZoneBounds",
  "movingSpeedThresholdMs",
  "minCoverageForEfficiency",
  "elevationHysteresisM",
  "timeZone",
  "displayUnits"
];
var InvalidAppSettingsError = class extends Error {
  code = "invalid_settings";
  constructor() {
    super("invalid_settings");
    this.name = "InvalidAppSettingsError";
  }
};
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function failAppSettings() {
  throw new InvalidAppSettingsError();
}
function parseAppSettings(value) {
  if (!isRecord2(value)) return failAppSettings();
  const keys = Object.keys(value);
  if (keys.length !== APP_SETTING_KEYS.length || keys.some((key) => !APP_SETTING_KEYS.includes(key))) {
    return failAppSettings();
  }
  let analytics;
  try {
    analytics = parseAnalyticsSettings({
      hrZoneBounds: value["hrZoneBounds"],
      movingSpeedThresholdMs: value["movingSpeedThresholdMs"],
      minCoverageForEfficiency: value["minCoverageForEfficiency"],
      elevationHysteresisM: value["elevationHysteresisM"]
    });
  } catch (error) {
    if (error instanceof InvalidAnalyticsSettingsError) return failAppSettings();
    throw error;
  }
  const timeZone = value["timeZone"];
  if (typeof timeZone !== "string" || !isValidTimeZone(timeZone)) return failAppSettings();
  const displayUnits = value["displayUnits"];
  if (displayUnits !== "metric" && displayUnits !== "imperial") return failAppSettings();
  return { ...analytics, timeZone, displayUnits };
}
function mergeAppSettings(current, patch) {
  if (!isRecord2(patch)) return failAppSettings();
  if (Object.keys(patch).some((key) => !APP_SETTING_KEYS.includes(key))) {
    return failAppSettings();
  }
  return parseAppSettings({ ...current, ...patch });
}
function loadSettings(db) {
  const stored = new Repository(db).getSetting(SETTINGS_KEY);
  const defaults = {
    ...DEFAULT_ANALYTICS_SETTINGS,
    timeZone: systemTimeZone(),
    displayUnits: "metric"
  };
  if (stored === void 0) return parseAppSettings(defaults);
  if (!isRecord2(stored)) return failAppSettings();
  return parseAppSettings({ ...defaults, ...stored });
}
function saveSettings(db, settings) {
  const parsed = parseAppSettings(settings);
  new Repository(db).setSetting(SETTINGS_KEY, parsed);
  return parsed;
}
function getOrComputeAnalytics(db, workoutId, now) {
  const input = loadWorkoutData(db, workoutId);
  if (!input) return null;
  const settings = loadSettings(db);
  const settingsHash = sha256Hex(stableStringify(settings));
  const inputHash = sha256Hex(stableStringify(input));
  const cached = getAnalyticsSnapshot(db, workoutId, FORMULA_VERSION, settingsHash, inputHash);
  if (cached) return JSON.parse(cached);
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
}
function repairWorkout(db, workoutId, now) {
  const repo = new Repository(db);
  return repo.transaction(() => {
    if (!repo.getWorkout(workoutId)) return null;
    repo.recomputeWorkoutSpan(workoutId);
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

// apps/api/src/basemap.ts
import { existsSync as existsSync3, lstatSync as lstatSync4, realpathSync as realpathSync4, statSync as statSync3 } from "node:fs";
import { isAbsolute as isAbsolute2, resolve as resolve4 } from "node:path";
import DatabaseConstructor3 from "better-sqlite3";
var MAX_ZOOM = 22;
var MAX_METADATA_ROWS = 256;
var MAX_METADATA_NAME_BYTES = 128;
var MAX_METADATA_VALUE_BYTES = 4 * 1024;
var MAX_TILE_BYTES = 2 * 1024 * 1024;
var EXPECTED_TILE_SIZE = 256;
var DEFAULT_CACHE_ENTRIES = 128;
var DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
var TileCache = class {
  #entries = /* @__PURE__ */ new Map();
  #maxEntries;
  #maxBytes;
  #bytes = 0;
  constructor(maxEntries, maxBytes) {
    this.#maxEntries = Math.max(0, Math.floor(maxEntries));
    this.#maxBytes = Math.max(0, Math.floor(maxBytes));
  }
  get(key) {
    const value = this.#entries.get(key);
    if (!value) return void 0;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.#maxEntries === 0 || value.data.byteLength > this.#maxBytes || value.data.byteLength > MAX_TILE_BYTES) {
      return;
    }
    const existing = this.#entries.get(key);
    if (existing) {
      this.#bytes -= existing.data.byteLength;
      this.#entries.delete(key);
    }
    this.#entries.set(key, value);
    this.#bytes += value.data.byteLength;
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === void 0) break;
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      if (oldest) this.#bytes -= oldest.data.byteLength;
    }
  }
  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }
};
var BasemapService = class _BasemapService {
  #manifest;
  #ready;
  #cache;
  constructor(manifest, ready, options) {
    this.#manifest = manifest;
    this.#ready = ready;
    this.#cache = new TileCache(
      options.cacheEntries ?? DEFAULT_CACHE_ENTRIES,
      options.cacheBytes ?? DEFAULT_CACHE_BYTES
    );
  }
  static open(options = {}) {
    if (!options.path) {
      return new _BasemapService({ state: "not_configured" }, void 0, options);
    }
    const required = options.required ?? false;
    if (!isAbsolute2(options.path)) {
      return new _BasemapService({ state: "invalid" }, void 0, options);
    }
    if (!existsSync3(options.path)) {
      return new _BasemapService(
        required ? { state: "invalid" } : { state: "not_configured" },
        void 0,
        options
      );
    }
    let database;
    try {
      const inputPath = resolve4(options.path);
      const inputStat = lstatSync4(inputPath);
      if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.nlink !== 1) {
        throw new Error("invalid_basemap");
      }
      const canonicalPath = realpathSync4(inputPath);
      if (canonicalPath !== inputPath) throw new Error("invalid_basemap");
      if (guardAgainstCheckout(canonicalPath) !== canonicalPath) throw new Error("invalid_basemap");
      database = new DatabaseConstructor3(canonicalPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 1e3
      });
      database.pragma("trusted_schema = OFF");
      database.pragma("query_only = ON");
      const openedPathStat = statSync3(canonicalPath);
      if (!openedPathStat.isFile() || openedPathStat.nlink !== 1 || openedPathStat.dev !== inputStat.dev || openedPathStat.ino !== inputStat.ino) {
        throw new Error("invalid_basemap");
      }
      const validated = validateDatabase(database);
      const ready = {
        database,
        manifest: validated.manifest,
        format: validated.format,
        readTile: createTileReader(database)
      };
      return new _BasemapService(ready.manifest, ready, options);
    } catch {
      try {
        database?.close();
      } catch {
      }
      return new _BasemapService({ state: "invalid" }, void 0, options);
    }
  }
  getManifest() {
    return this.#manifest;
  }
  getTile(z, x, y) {
    const ready = this.#ready;
    if (!ready) return { state: "unavailable" };
    if (!validCoordinates(z, x, y)) return { state: "invalid" };
    if (z < ready.manifest.minZoom || z > ready.manifest.maxZoom) {
      return { state: "invalid" };
    }
    const key = `${z}/${x}/${y}`;
    const cached = this.#cache.get(key);
    if (cached) return { state: "ok", data: cached.data, contentType: cached.contentType };
    const tmsRow = 2 ** z - 1 - y;
    try {
      const bounded = ready.readTile(z, x, tmsRow);
      if (bounded.state !== "ok") return bounded;
      const data = bounded.data;
      if (!validRasterDimensions(data, ready.format)) return { state: "invalid" };
      const value = { data, contentType: contentTypeFor(ready.format) };
      this.#cache.set(key, value);
      return { state: "ok", ...value };
    } catch {
      return { state: "invalid" };
    }
  }
  close() {
    this.#cache.clear();
    const ready = this.#ready;
    this.#ready = void 0;
    if (!ready) return;
    try {
      ready.database.close();
    } catch {
    }
  }
};
function validateDatabase(database) {
  const validate = database.transaction(() => validateDatabaseSnapshot(database));
  return validate.deferred();
}
function validateDatabaseSnapshot(database) {
  const objectType = database.prepare(
    "SELECT type, rootpage, sql FROM sqlite_schema WHERE name = ? COLLATE BINARY LIMIT 1"
  );
  const metadataObject = objectType.get("metadata");
  const tilesObject = objectType.get("tiles");
  if (!isOrdinaryStoredTable(metadataObject) || !isOrdinaryStoredTable(tilesObject)) {
    throw new Error("invalid_basemap");
  }
  requireStandardColumns(database, "metadata", ["name", "value"]);
  requireStandardColumns(database, "tiles", ["zoom_level", "tile_column", "tile_row", "tile_data"]);
  requireTileLookupIndex(database);
  const metadataDescriptors = database.prepare(
    `SELECT
         rowid AS row_id,
         typeof(name) AS name_type,
         CASE WHEN typeof(name) = 'text' THEN octet_length(name) END AS name_bytes,
         typeof(value) AS value_type,
         CASE WHEN typeof(value) = 'text' THEN octet_length(value) END AS value_bytes
       FROM metadata
       ORDER BY rowid
       LIMIT ?`
  ).all(MAX_METADATA_ROWS + 1);
  if (metadataDescriptors.length > MAX_METADATA_ROWS) throw new Error("invalid_basemap");
  const boundedMetadata = metadataDescriptors.map((row) => {
    if (row.name_type !== "text" || row.value_type !== "text") {
      throw new Error("invalid_basemap");
    }
    return {
      rowId: safeInteger(row.row_id),
      nameBytes: boundedLength(row.name_bytes, MAX_METADATA_NAME_BYTES),
      valueBytes: boundedLength(row.value_bytes, MAX_METADATA_VALUE_BYTES)
    };
  });
  const metadataByRowId = database.prepare(
    `SELECT name, value
     FROM metadata
     WHERE rowid = ? AND typeof(name) = 'text' AND typeof(value) = 'text'
     LIMIT 1`
  );
  const metadata = /* @__PURE__ */ new Map();
  for (const descriptor of boundedMetadata) {
    const row = metadataByRowId.get(descriptor.rowId);
    if (!row || typeof row.name !== "string" || typeof row.value !== "string") {
      throw new Error("invalid_basemap");
    }
    if (Buffer.byteLength(row.name, "utf8") !== descriptor.nameBytes || Buffer.byteLength(row.value, "utf8") !== descriptor.valueBytes) {
      throw new Error("invalid_basemap");
    }
    const name2 = row.name;
    const value = row.value;
    const key = name2.trim().toLowerCase();
    if (key === "" || metadata.has(key)) throw new Error("invalid_basemap");
    metadata.set(key, value);
  }
  const format = parseFormat(metadata.get("format"));
  const scheme = metadata.get("scheme")?.trim().toLowerCase();
  if (scheme !== void 0 && scheme !== "tms") throw new Error("invalid_basemap");
  const declaredMinZoom = parseZoom(metadata.get("minzoom"));
  const declaredMaxZoom = parseZoom(metadata.get("maxzoom"));
  if (declaredMinZoom === void 0 || declaredMaxZoom === void 0) {
    throw new Error("invalid_basemap");
  }
  const minZoom = declaredMinZoom;
  const maxZoom = declaredMaxZoom;
  if (minZoom > maxZoom) throw new Error("invalid_basemap");
  const tileSizeValues = [metadata.get("tile_size"), metadata.get("tilesize")].filter(
    (value) => value !== void 0
  );
  if (tileSizeValues.some((value) => value.trim() !== "256") || new Set(tileSizeValues.map((value) => value.trim())).size > 1) {
    throw new Error("invalid_basemap");
  }
  const sampleDescriptors = database.prepare(
    `SELECT
         rowid AS row_id,
         typeof(zoom_level) AS zoom_type,
         CASE WHEN typeof(zoom_level) = 'integer' THEN zoom_level END AS zoom_level,
         typeof(tile_column) AS column_type,
         CASE WHEN typeof(tile_column) = 'integer' THEN tile_column END AS tile_column,
         typeof(tile_row) AS row_type,
         CASE WHEN typeof(tile_row) = 'integer' THEN tile_row END AS tile_row,
         typeof(tile_data) AS tile_type,
         CASE WHEN typeof(tile_data) = 'blob' THEN length(tile_data) END AS byte_length
       FROM tiles
       ORDER BY rowid
       LIMIT 8`
  ).all();
  if (sampleDescriptors.length === 0) throw new Error("invalid_basemap");
  const boundedSamples = sampleDescriptors.map((tile) => {
    if (tile.zoom_type !== "integer" || tile.column_type !== "integer" || tile.row_type !== "integer" || tile.tile_type !== "blob") {
      throw new Error("invalid_basemap");
    }
    const zoom = safeInteger(tile.zoom_level);
    const column = safeInteger(tile.tile_column);
    const row = safeInteger(tile.tile_row);
    if (!validTmsCoordinates(zoom, column, row) || zoom < minZoom || zoom > maxZoom) {
      throw new Error("invalid_basemap");
    }
    return {
      rowId: safeInteger(tile.row_id),
      zoom,
      column,
      row,
      byteLength: boundedLength(tile.byte_length, MAX_TILE_BYTES)
    };
  });
  const tileByRowId = database.prepare(
    `SELECT tile_data
     FROM tiles
     WHERE rowid = ?
       AND zoom_level = ?
       AND tile_column = ?
       AND tile_row = ?
       AND typeof(tile_data) = 'blob'
     LIMIT 1`
  );
  for (const sample of boundedSamples) {
    const row = tileByRowId.get(sample.rowId, sample.zoom, sample.column, sample.row);
    if (!row || !Buffer.isBuffer(row.tile_data) || row.tile_data.byteLength !== sample.byteLength || !validRasterDimensions(row.tile_data, format)) {
      throw new Error("invalid_basemap");
    }
  }
  const name = toPlainText(metadata.get("name") ?? "", 160);
  if (name === "") throw new Error("invalid_basemap");
  const attribution = toPlainText(metadata.get("attribution") ?? "", 1e3);
  const bounds = parseBounds(metadata.get("bounds"));
  const manifest = {
    state: "ready",
    format: "raster-mbtiles",
    name,
    attribution,
    minZoom,
    maxZoom,
    ...bounds ? { bounds } : {}
  };
  return { manifest, format };
}
function requireStandardColumns(database, table, required) {
  const rows = database.prepare("SELECT name, hidden FROM pragma_table_xinfo(?)").all(table);
  const reservedRowIds = /* @__PURE__ */ new Set(["rowid", "_rowid_", "oid"]);
  if (rows.some(
    (row) => typeof row.name !== "string" || reservedRowIds.has(row.name.trim().toLowerCase())
  )) {
    throw new Error("invalid_basemap");
  }
  for (const column of required) {
    const match = rows.find((row) => row.name === column);
    if (!match || match.hidden !== 0) throw new Error("invalid_basemap");
  }
  const rowIdProbe = table === "metadata" ? database.prepare("SELECT rowid FROM metadata LIMIT 0") : database.prepare("SELECT rowid FROM tiles LIMIT 0");
  rowIdProbe.all();
}
function isOrdinaryStoredTable(value) {
  return value?.type === "table" && typeof value.rootpage === "number" && Number.isSafeInteger(value.rootpage) && value.rootpage > 0 && typeof value.sql === "string" && /^\s*CREATE\s+TABLE\b/i.test(value.sql);
}
function requireTileLookupIndex(database) {
  const index = database.prepare(
    `SELECT 1 AS present
       FROM pragma_index_list('tiles') AS indexes
       WHERE indexes."unique" = 1
         AND indexes.partial = 0
         AND (
           SELECT COUNT(*)
           FROM pragma_index_info(indexes.name)
         ) = 3
         AND (
           SELECT COUNT(*)
           FROM pragma_index_info(indexes.name)
           WHERE name IN ('zoom_level', 'tile_column', 'tile_row')
         ) = 3
       LIMIT 1`
  ).get();
  if (index?.present !== 1) throw new Error("invalid_basemap");
}
function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("invalid_basemap");
  return number;
}
function boundedLength(value, max) {
  const length = safeInteger(value);
  if (length < 0 || length > max) throw new Error("invalid_basemap");
  return length;
}
function createTileReader(database) {
  const descriptorQuery = database.prepare(
    `SELECT
       rowid AS row_id,
       typeof(tile_data) AS tile_type,
       CASE WHEN typeof(tile_data) = 'blob' THEN length(tile_data) END AS byte_length
     FROM tiles
     WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?
     ORDER BY rowid
     LIMIT 2`
  );
  const dataByRowId = database.prepare(
    `SELECT tile_data
     FROM tiles
     WHERE rowid = ?
       AND zoom_level = ?
       AND tile_column = ?
       AND tile_row = ?
       AND typeof(tile_data) = 'blob'
     LIMIT 1`
  );
  const read = database.transaction((z, x, tmsRow) => {
    const descriptors = descriptorQuery.all(z, x, tmsRow);
    if (descriptors.length === 0) return { state: "not_found" };
    if (descriptors.length !== 1) return { state: "invalid" };
    const descriptor = descriptors[0];
    if (descriptor.tile_type !== "blob") return { state: "invalid" };
    const byteLength = safeInteger(descriptor.byte_length);
    if (byteLength < 0) return { state: "invalid" };
    if (byteLength > MAX_TILE_BYTES) return { state: "too_large" };
    const rowId = safeInteger(descriptor.row_id);
    const row = dataByRowId.get(rowId, z, x, tmsRow);
    if (!row || !Buffer.isBuffer(row.tile_data) || row.tile_data.byteLength !== byteLength) {
      return { state: "invalid" };
    }
    return { state: "ok", data: row.tile_data };
  });
  return (z, x, tmsRow) => read.deferred(z, x, tmsRow);
}
function parseFormat(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "png") return "png";
  if (normalized === "jpg" || normalized === "jpeg") return "jpeg";
  if (normalized === "webp") return "webp";
  throw new Error("invalid_basemap");
}
function parseZoom(value) {
  if (value === void 0) return void 0;
  if (!/^(?:0|[1-9]\d?)$/.test(value.trim())) throw new Error("invalid_basemap");
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_ZOOM) {
    throw new Error("invalid_basemap");
  }
  return parsed;
}
function parseBounds(value) {
  if (value === void 0 || value.trim() === "") return void 0;
  const rawParts = value.split(",");
  if (rawParts.some((part) => part.trim() === "")) throw new Error("invalid_basemap");
  const parts = rawParts.map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[0] < -180 || parts[0] > 180 || parts[2] < -180 || parts[2] > 180 || parts[1] < -85.051129 || parts[1] > 85.051129 || parts[3] < -85.051129 || parts[3] > 85.051129 || parts[0] >= parts[2] || parts[1] >= parts[3]) {
    throw new Error("invalid_basemap");
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}
function toPlainText(value, maxLength) {
  const withoutTags = value.replace(/<[^>]*>/g, " ");
  const decoded = withoutTags.replace(
    /&(amp|lt|gt|quot|apos|#39);/gi,
    (entity, name) => ({
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      "#39": "'"
    })[name.toLowerCase()] ?? entity
  );
  return decoded.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
function validCoordinates(z, x, y) {
  if (!Number.isSafeInteger(z) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || z < 0 || z > MAX_ZOOM || x < 0 || y < 0) {
    return false;
  }
  const width = 2 ** z;
  return x < width && y < width;
}
function validTmsCoordinates(z, x, row) {
  return validCoordinates(z, x, row);
}
function validRasterDimensions(data, format) {
  const dimensions = format === "png" ? pngDimensions(data) : format === "jpeg" ? jpegDimensions(data) : webpDimensions(data);
  return dimensions?.width === EXPECTED_TILE_SIZE && dimensions.height === EXPECTED_TILE_SIZE;
}
function pngDimensions(data) {
  if (data.byteLength < 33 || data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71 || data[4] !== 13 || data[5] !== 10 || data[6] !== 26 || data[7] !== 10 || data.readUInt32BE(8) !== 13 || data.subarray(12, 16).toString("ascii") !== "IHDR") {
    return void 0;
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : void 0;
}
var JPEG_START_OF_FRAME = /* @__PURE__ */ new Set([
  192,
  193,
  194,
  195,
  197,
  198,
  199,
  201,
  202,
  203,
  205,
  206,
  207
]);
function jpegDimensions(data) {
  if (data.byteLength < 4 || data[0] !== 255 || data[1] !== 216 || data[data.byteLength - 2] !== 255 || data[data.byteLength - 1] !== 217) {
    return void 0;
  }
  let offset = 2;
  while (offset < data.byteLength - 2) {
    if (data[offset] !== 255) return void 0;
    while (offset < data.byteLength && data[offset] === 255) offset += 1;
    if (offset >= data.byteLength) return void 0;
    const marker = data[offset];
    offset += 1;
    if (marker === 217) break;
    if (marker === 0) return void 0;
    if (marker === 1 || marker >= 208 && marker <= 216) continue;
    if (offset + 2 > data.byteLength) return void 0;
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.byteLength) return void 0;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 8) return void 0;
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : void 0;
    }
    if (marker === 218) return void 0;
    offset += segmentLength;
  }
  return void 0;
}
function webpDimensions(data) {
  if (data.byteLength < 20 || data.subarray(0, 4).toString("ascii") !== "RIFF" || data.subarray(8, 12).toString("ascii") !== "WEBP" || data.readUInt32LE(4) + 8 !== data.byteLength) {
    return void 0;
  }
  let offset = 12;
  let canvas;
  let image;
  while (offset + 8 <= data.byteLength) {
    const chunkType = data.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = data.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    const paddedEnd = dataEnd + (chunkSize & 1);
    if (dataEnd > data.byteLength || paddedEnd > data.byteLength) return void 0;
    if (chunkType === "VP8X") {
      if (chunkSize !== 10 || canvas) return void 0;
      if ((data[dataStart] & 2) !== 0) return void 0;
      canvas = {
        width: readUInt24LE(data, dataStart + 4) + 1,
        height: readUInt24LE(data, dataStart + 7) + 1
      };
    } else if (chunkType === "VP8L") {
      if (chunkSize < 5 || image || data[dataStart] !== 47) return void 0;
      const packed = data.readUInt32LE(dataStart + 1);
      image = {
        width: (packed & 16383) + 1,
        height: (packed >>> 14 & 16383) + 1
      };
    } else if (chunkType === "VP8 ") {
      if (chunkSize < 10 || image || data[dataStart + 3] !== 157 || data[dataStart + 4] !== 1 || data[dataStart + 5] !== 42) {
        return void 0;
      }
      image = {
        width: data.readUInt16LE(dataStart + 6) & 16383,
        height: data.readUInt16LE(dataStart + 8) & 16383
      };
    }
    offset = paddedEnd;
  }
  if (offset !== data.byteLength || !image || image.width === 0 || image.height === 0) {
    return void 0;
  }
  if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) {
    return void 0;
  }
  return image;
}
function readUInt24LE(data, offset) {
  return data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16;
}
function contentTypeFor(format) {
  if (format === "png") return "image/png";
  if (format === "jpeg") return "image/jpeg";
  return "image/webp";
}

// apps/api/src/server.ts
var API_VERSION = APP_VERSION;
var MAX_PATH_BODY_BYTES = 8 * 1024;
var PATH_IMPORT_ZIP_LIMITS = {
  ...DEFAULT_ZIP_LIMITS,
  maxEntryBytes: DEFAULT_MAX_GROUP_BYTES,
  maxTotalBytes: DEFAULT_MAX_GROUP_BYTES
};
var LOGGABLE_HTTP_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);
function requestLogMethod(method) {
  return method !== void 0 && LOGGABLE_HTTP_METHODS.has(method) ? method : "UNKNOWN";
}
function notifyRequestWaiters(state) {
  if (state.activeRequests <= 1) {
    for (const resolve5 of state.exclusiveWaiters) resolve5();
    state.exclusiveWaiters.clear();
  }
  if (state.activeRequests === 0) {
    for (const resolve5 of state.idleWaiters) resolve5();
    state.idleWaiters.clear();
  }
}
function waitForExclusiveRequest(state) {
  if (state.activeRequests <= 1) return Promise.resolve();
  return new Promise((resolve5) => state.exclusiveWaiters.add(resolve5));
}
function waitForRequests(state) {
  if (state.activeRequests === 0) return Promise.resolve();
  return new Promise((resolve5) => state.idleWaiters.add(resolve5));
}
function createApiServer(opts) {
  const now = opts.now ?? Date.now;
  const state = {
    deleteAllInProgress: false,
    importInProgress: false,
    activeRequests: 0,
    databaseAvailable: true,
    restoreInProgress: false,
    exclusiveWaiters: /* @__PURE__ */ new Set(),
    idleWaiters: /* @__PURE__ */ new Set()
  };
  const basemap = BasemapService.open({
    ...opts.basemapPath ? { path: opts.basemapPath } : {},
    ...opts.basemapPathRequired === void 0 ? {} : { required: opts.basemapPathRequired }
  });
  let server;
  try {
    server = createServer((req, res) => {
      state.activeRequests += 1;
      let finished = false;
      let operationPending = false;
      let requestLogged = false;
      const logRequest = () => {
        if (requestLogged || !opts.log) return;
        requestLogged = true;
        try {
          opts.log({
            event: "http_request",
            method: requestLogMethod(req.method),
            route: requestLogRoute(req.url),
            status: res.writableEnded ? res.statusCode : 499
          });
        } catch {
        }
      };
      const finishRequest = () => {
        if (finished) return;
        finished = true;
        state.activeRequests -= 1;
        notifyRequestWaiters(state);
      };
      const finishResponse = () => {
        if (!operationPending) finishRequest();
      };
      res.once("finish", () => {
        logRequest();
        finishResponse();
      });
      res.once("close", () => {
        logRequest();
        finishResponse();
      });
      try {
        const operation = handle(req, res, opts, now, server, state, basemap);
        if (operation) {
          operationPending = true;
          void operation.catch(
            (error) => send(res, 500, {
              error: error instanceof AnalyticsSnapshotConflictError ? "analytics_snapshot_conflict" : "internal_error"
            })
          ).finally(() => {
            operationPending = false;
            finishRequest();
          });
        }
      } catch (error) {
        send(res, 500, {
          error: error instanceof AnalyticsSnapshotConflictError ? "analytics_snapshot_conflict" : "internal_error"
        });
      }
    });
  } catch (error) {
    basemap.close();
    throw error;
  }
  const closeBasemap = () => basemap.close();
  server.once("close", closeBasemap);
  return Object.assign(server, {
    getDatabase: () => opts.db,
    isRestoreInProgress: () => state.restoreInProgress,
    waitForRequests: () => waitForRequests(state),
    closeBasemap
  });
}
function requestLogRoute(rawUrl) {
  const path = (rawUrl ?? "").split("?", 1)[0] ?? "";
  const exact = /* @__PURE__ */ new Set([
    "/api/health",
    "/api/basemap",
    "/api/workouts",
    "/api/trends",
    "/api/settings",
    "/api/data",
    "/api/import",
    "/api/import/inventory",
    "/api/import/path",
    "/api/import/path/inventory",
    "/api/backup",
    "/api/restore"
  ]);
  if (exact.has(path)) return path;
  if (/^\/api\/workouts\/\d+$/.test(path)) return "/api/workouts/:workoutId";
  if (/^\/api\/workouts\/\d+\/repair$/.test(path)) {
    return "/api/workouts/:workoutId/repair";
  }
  if (/^\/api\/basemap\/tiles\/\d+\/\d+\/\d+$/.test(path)) {
    return "/api/basemap/tiles/:z/:x/:y";
  }
  return path.startsWith("/api/") ? "/api/unknown" : "/web-asset";
}
function expectedPort(server) {
  const addr = server.address();
  return addr && typeof addr === "object" ? addr.port : null;
}
function hostAllowed(header, port) {
  if (!header) return false;
  const h = header.trim().toLowerCase();
  let name;
  let p = null;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(h);
  if (v6) {
    name = `[${v6[1]}]`;
    p = v6[2] ? Number(v6[2]) : null;
  } else {
    const idx = h.lastIndexOf(":");
    if (idx !== -1 && /^\d+$/.test(h.slice(idx + 1))) {
      name = h.slice(0, idx);
      p = Number(h.slice(idx + 1));
    } else {
      name = h;
    }
  }
  const loopback = name === "127.0.0.1" || name === "localhost" || name === "[::1]";
  return loopback && (port == null || p === port || p == null && (port === 80 || port === 443));
}
function originAllowed(origin, port) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    const p = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return loopback && (port == null || p === port);
  } catch {
    return false;
  }
}
function securityHeaders(res) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}
function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  securityHeaders(res);
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}
function handle(req, res, opts, now, server, state, basemap) {
  const port = expectedPort(server);
  if (!hostAllowed(req.headers.host, port)) {
    send(res, 403, { error: "host_not_allowed" });
    return;
  }
  if (!originAllowed(req.headers.origin, port)) {
    send(res, 403, { error: "origin_not_allowed" });
    return;
  }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port ?? 0}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (path.startsWith("/api/") && !fetchSiteAllowed(req.headers["sec-fetch-site"])) {
    send(res, 403, { error: "cross_site_request" });
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    if (req.headers["x-velograph-request"] !== "1") {
      send(res, 403, { error: "missing_csrf_header" });
      return;
    }
  }
  if (!state.databaseAvailable) {
    send(res, 503, { error: "database_unavailable" });
    return;
  }
  if (state.restoreInProgress && path !== "/api/health") {
    send(res, 503, { error: "restore_in_progress" });
    return;
  }
  if (state.deleteAllInProgress && path !== "/api/health") {
    send(res, 503, { error: "delete_all_in_progress" });
    return;
  }
  if (path.startsWith("/api/")) {
    return route(req, res, opts, url, method, now, state, basemap);
  }
  serveStatic(res, opts.staticDir, path);
}
function route(req, res, opts, url, method, now, state, basemap) {
  const db = opts.db;
  const path = url.pathname;
  if (method === "GET" && path === "/api/health") {
    send(res, 200, { ok: true, version: API_VERSION });
    return;
  }
  if (method === "GET" && path === "/api/basemap") {
    send(res, 200, basemap.getManifest());
    return;
  }
  const basemapTile = /^\/api\/basemap\/tiles\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
  if (method === "GET" && basemapTile) {
    const tile = basemap.getTile(
      Number(basemapTile[1]),
      Number(basemapTile[2]),
      Number(basemapTile[3])
    );
    sendBasemapTile(res, tile);
    return;
  }
  if (state.importInProgress) {
    send(res, 503, { error: "import_in_progress" });
    return;
  }
  if (method === "GET" && path === "/api/workouts") {
    const repo = new Repository(db);
    const list = repo.listWorkouts().map((w) => {
      const a = getOrComputeAnalytics(db, w.id, now());
      return {
        id: w.id,
        type: w.type,
        startUtc: w.start_utc,
        endUtc: w.end_utc,
        durationS: w.duration_s,
        qualityState: w.quality_state,
        distanceM: a?.distanceM ?? null,
        avgSpeedMs: a?.avgSpeedMs ?? null,
        avgHr: a?.heartRate.avg ?? null,
        elevationGainM: a?.elevation.gainM ?? null,
        hasRoute: new Repository(db).workoutRouteFormat(w.id) !== void 0
      };
    });
    send(res, 200, { workouts: list });
    return;
  }
  const detail = /^\/api\/workouts\/(\d+)$/.exec(path);
  if (method === "GET" && detail) {
    const id = Number(detail[1]);
    const data = loadWorkoutData(db, id);
    if (!data) {
      send(res, 404, { error: "not_found" });
      return;
    }
    const analytics = getOrComputeAnalytics(db, id, now());
    send(res, 200, { workout: data.workout, metrics: data.metrics, route: data.route, analytics });
    return;
  }
  if (method === "DELETE" && detail) {
    const id = Number(detail[1]);
    const repo = new Repository(db);
    const result = repo.deleteWorkout(id);
    if (!result) {
      send(res, 404, { error: "not_found" });
      return;
    }
    send(res, 200, {
      deleted: true,
      workoutId: id,
      removedSourceFiles: result.removedSourceFileIds.length
    });
    return;
  }
  const repairMatch = /^\/api\/workouts\/(\d+)\/repair$/.exec(path);
  if (method === "POST" && repairMatch) {
    const id = Number(repairMatch[1]);
    const analytics = repairWorkout(db, id, now());
    if (!analytics) {
      send(res, 404, { error: "not_found" });
      return;
    }
    send(res, 200, { repaired: true, analytics });
    return;
  }
  if (method === "GET" && path === "/api/trends") {
    send(res, 200, buildTrends(db, now));
    return;
  }
  if (method === "GET" && path === "/api/settings") {
    send(res, 200, { settings: loadSettings(db) });
    return;
  }
  if (method === "PUT" && path === "/api/settings") {
    return readJsonBody(req, 1024 * 1024).then((body) => {
      try {
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "settings")) {
          throw new InvalidAppSettingsError();
        }
        const patch = body.settings;
        const merged = mergeAppSettings(loadSettings(db), patch);
        const settings = saveSettings(db, merged);
        send(res, 200, { settings });
      } catch (error) {
        if (error instanceof InvalidAppSettingsError) {
          send(res, 400, { error: "invalid_settings" });
          return;
        }
        send(res, 500, { error: "internal_error" });
      }
    }).catch(() => {
      if (!res.headersSent) send(res, 400, { error: "invalid_body" });
    });
    return;
  }
  if (method === "DELETE" && path === "/api/data") {
    state.deleteAllInProgress = true;
    return readJsonBody(req, 1024).then(async (body) => {
      if (!isRecord3(body) || !hasExactKeys(body, ["confirmed"]) || body["confirmed"] !== true) {
        send(res, 409, { error: "delete_all_confirmation_required" });
        return;
      }
      await waitForExclusiveRequest(state);
      try {
        new Repository(db).deleteAllData();
        send(res, 200, { deleted: true });
      } catch {
        send(res, 500, { error: "delete_all_failed" });
      }
    }).catch(() => {
      if (!res.headersSent) send(res, 400, { error: "invalid_body" });
    }).finally(() => {
      state.deleteAllInProgress = false;
    });
  }
  if (method === "POST" && path === "/api/import/inventory") {
    const limits = opts.importUploadLimits ?? DEFAULT_IMPORT_UPLOAD_LIMITS;
    const cancellation = createRequestCancellation(req, res);
    return readJsonBody(req, limits.maxBodyBytes, cancellation.signal).then(async (body) => {
      await yieldToRequestEvents();
      throwIfImportAborted(cancellation.signal);
      const uploads = decodeUploadFiles(body, limits);
      await yieldToRequestEvents();
      throwIfImportAborted(cancellation.signal);
      if (!beginImport(state, res)) return;
      try {
        const inventory = await preflightImportCancellable(
          db,
          uploads.map((upload) => upload.file),
          {
            now: now(),
            timeZone: loadSettings(db).timeZone,
            signal: cancellation.signal,
            zipLimits: {
              maxEntries: limits.maxFiles,
              maxEntryBytes: limits.maxFileBytes,
              maxTotalBytes: limits.maxTotalDecodedBytes
            }
          }
        );
        send(res, 200, {
          inventory: inventory.map((item, index) => ({
            id: uploads[index].id,
            ...item
          }))
        });
      } finally {
        state.importInProgress = false;
      }
    }).catch((err) => sendImportRequestError(res, err)).finally(cancellation.dispose);
  }
  if (method === "POST" && path === "/api/import") {
    const limits = opts.importUploadLimits ?? DEFAULT_IMPORT_UPLOAD_LIMITS;
    const cancellation = createRequestCancellation(req, res);
    return readJsonBody(req, limits.maxBodyBytes, cancellation.signal).then(async (body) => {
      await yieldToRequestEvents();
      throwIfImportAborted(cancellation.signal);
      const files = decodeUploadFiles(body, limits).map((upload) => upload.file);
      await yieldToRequestEvents();
      throwIfImportAborted(cancellation.signal);
      if (!beginImport(state, res)) return;
      try {
        const result = await runImportCancellable(db, files, {
          now: now(),
          timeZone: loadSettings(db).timeZone,
          signal: cancellation.signal,
          zipLimits: {
            maxEntries: limits.maxFiles,
            maxEntryBytes: limits.maxFileBytes,
            maxTotalBytes: limits.maxTotalDecodedBytes
          }
        });
        send(res, 200, { result });
      } finally {
        state.importInProgress = false;
      }
    }).catch((err) => sendImportRequestError(res, err)).finally(cancellation.dispose);
  }
  if (method === "POST" && path === "/api/import/path/inventory") {
    const cancellation = createRequestCancellation(req, res);
    return readJsonBody(req, MAX_PATH_BODY_BYTES, cancellation.signal).then(async (body) => {
      await yieldToRequestEvents();
      throwIfImportAborted(cancellation.signal);
      const p = readPathField(body);
      if (!p) {
        send(res, 400, { error: "invalid_path" });
        return;
      }
      try {
        const plan = await planFolderImportCancellable(p, {}, cancellation.signal);
        await yieldToRequestEvents();
        throwIfImportAborted(cancellation.signal);
        let preflight = [];
        let preflightComplete = false;
        if (!plan.truncated) {
          if (!beginImport(state, res)) return;
          try {
            preflight = await preflightImportGroupsCancellable(db, readFolderFileGroups(plan), {
              now: now(),
              timeZone: loadSettings(db).timeZone,
              zipLimits: PATH_IMPORT_ZIP_LIMITS,
              signal: cancellation.signal
            });
            preflightComplete = true;
          } finally {
            state.importInProgress = false;
          }
        }
        const preview = previewFolderImportPlan(plan, preflight, preflightComplete);
        send(res, 200, { preview });
      } catch (err) {
        sendFolderImportError(res, err);
      }
    }).catch((err) => sendFolderRequestError(res, err)).finally(cancellation.dispose);
  }
  if (method === "POST" && path === "/api/import/path") {
    const cancellation = createRequestCancellation(req, res);
    return readJsonBody(req, MAX_PATH_BODY_BYTES, cancellation.signal).then(async (body) => {
      await yieldToRequestEvents();
      throwIfImportAborted(cancellation.signal);
      const p = readPathField(body);
      const confirmationToken = readConfirmationToken(body);
      if (!p) {
        send(res, 400, { error: "invalid_path" });
        return;
      }
      if (!confirmationToken) {
        send(res, 400, { error: "preview_required" });
        return;
      }
      try {
        const plan = await planFolderImportForConfirmation(p, cancellation.signal);
        confirmFolderImportPlan(plan, confirmationToken);
        if (plan.totalFiles === 0) {
          send(res, 400, {
            error: "no_files",
            skipped: plan.skipped,
            truncated: plan.truncated
          });
          return;
        }
        await yieldToRequestEvents();
        throwIfImportAborted(cancellation.signal);
        if (!beginImport(state, res)) return;
        try {
          const result = await runImportGroupsCancellable(db, readFolderFileGroups(plan), {
            now: now(),
            timeZone: loadSettings(db).timeZone,
            zipLimits: PATH_IMPORT_ZIP_LIMITS,
            signal: cancellation.signal
          });
          send(res, 200, {
            result,
            skipped: plan.skipped,
            truncated: plan.truncated
          });
        } finally {
          state.importInProgress = false;
        }
      } catch (err) {
        sendFolderImportError(res, err);
      }
    }).catch((err) => sendFolderRequestError(res, err)).finally(cancellation.dispose);
  }
  if (method === "POST" && path === "/api/backup") {
    return readJsonBody(req, MAX_PATH_BODY_BYTES).then(async (body) => {
      const dest = readPathField(body);
      if (!dest) {
        send(res, 400, { error: "invalid_path" });
        return;
      }
      try {
        const result = await backupDatabase(db, dest);
        send(res, 200, {
          ok: true,
          totalPages: result.totalPages,
          manifest: {
            formatVersion: result.manifest.formatVersion,
            appVersion: result.manifest.appVersion,
            schemaVersion: result.manifest.schemaVersion,
            includedCategories: result.manifest.includedCategories
          }
        });
      } catch (err) {
        if (err instanceof BackupValidationError) {
          send(res, 400, { error: err.code });
          return;
        }
        send(res, 500, { error: "backup_failed" });
      }
    }).catch(() => send(res, 400, { error: "invalid_body" }));
    return;
  }
  if (method === "POST" && path === "/api/restore") {
    if (!opts.dbPath) {
      send(res, 400, { error: "restore_unsupported" });
      return;
    }
    return readJsonBody(req, MAX_PATH_BODY_BYTES).then(async (body) => {
      const source = readPathField(body);
      if (!source) {
        send(res, 400, { error: "invalid_path" });
        return;
      }
      if (body.confirmed !== true) {
        send(res, 409, { error: "restore_confirmation_required" });
        return;
      }
      if (state.restoreInProgress) {
        send(res, 409, { error: "restore_in_progress" });
        return;
      }
      if (state.deleteAllInProgress) {
        send(res, 503, { error: "delete_all_in_progress" });
        return;
      }
      state.restoreInProgress = true;
      try {
        await waitForExclusiveRequest(state);
        const restored = await (opts.restoreDatabaseFn ?? restoreDatabaseWithReport)(
          opts.db,
          opts.dbPath,
          source
        );
        opts.db = restored.database;
        send(res, 200, { ok: true, report: restored.report });
      } catch (error) {
        let status = 400;
        let code = "restore_failed";
        if (error instanceof RestoreValidationError) {
          code = error.code;
        } else if (error instanceof RestoreDatabaseError) {
          status = 500;
          code = error.code;
          if (error.recoveredDatabase) {
            opts.db = error.recoveredDatabase;
          } else {
            state.databaseAvailable = false;
            code = "database_unavailable";
          }
        }
        if (!opts.db.open) {
          state.databaseAvailable = false;
          status = 500;
          code = "database_unavailable";
        }
        send(res, status, { error: code });
      } finally {
        state.restoreInProgress = false;
      }
    }).catch(() => send(res, 400, { error: "invalid_body" }));
    return;
  }
  send(res, 404, { error: "not_found" });
}
function sendBasemapTile(res, tile) {
  if (tile.state !== "ok") {
    const statuses = {
      unavailable: 404,
      not_found: 404,
      too_large: 413,
      invalid: 400
    };
    const errors = {
      unavailable: "basemap_unavailable",
      not_found: "tile_not_found",
      too_large: "tile_too_large",
      invalid: "invalid_tile"
    };
    send(res, statuses[tile.state], { error: errors[tile.state] });
    return;
  }
  securityHeaders(res);
  res.writeHead(200, {
    "Content-Type": tile.contentType,
    "Content-Length": tile.data.byteLength
  });
  res.end(tile.data);
}
function fetchSiteAllowed(value) {
  if (value === void 0) return true;
  if (Array.isArray(value)) return false;
  return ["same-origin", "same-site", "none"].includes(value.trim().toLowerCase());
}
function readPathField(body) {
  const p = body?.path;
  return typeof p === "string" && p.trim() !== "" ? p : void 0;
}
function readConfirmationToken(body) {
  const token = body?.confirmationToken;
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? token : void 0;
}
async function planFolderImportForConfirmation(path, signal) {
  try {
    return await planFolderImportCancellable(path, {}, signal);
  } catch (err) {
    if (err instanceof FolderImportError && (err.code === "path_not_found" || err.code === "not_a_directory")) {
      throw new FolderImportError("path_changed", "folder changed after preview");
    }
    throw err;
  }
}
function folderErrorCode(err) {
  if (err instanceof FolderImportError) {
    return err.code === "inside_checkout" ? "path_inside_checkout" : err.code;
  }
  return "folder_import_failed";
}
function folderErrorStatus(err) {
  if (!(err instanceof FolderImportError)) return 500;
  return err.code === "path_changed" ? 409 : 400;
}
function sendFolderImportError(res, err) {
  if (err instanceof ImportAbortedError) {
    send(res, 499, { error: err.code });
    return;
  }
  send(res, folderErrorStatus(err), { error: folderErrorCode(err) });
}
function sendFolderRequestError(res, err) {
  if (err instanceof ImportAbortedError) {
    send(res, 499, { error: err.code });
    return;
  }
  if (err instanceof ImportRequestError && err.code === "invalid_json") {
    send(res, 400, { error: "invalid_body" });
    return;
  }
  send(res, 400, { error: "invalid_body" });
}
var ImportRequestError = class extends Error {
  status;
  code;
  constructor(status, code) {
    super(code);
    this.name = "ImportRequestError";
    this.status = status;
    this.code = code;
  }
};
function beginImport(runtime, res) {
  if (runtime.importInProgress) {
    send(res, 503, { error: "import_in_progress" });
    return false;
  }
  runtime.importInProgress = true;
  return true;
}
function createRequestCancellation(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIncompleteRequest = () => {
    if (!req.complete) abort();
  };
  const abortIncompleteResponse = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  req.once("close", abortIncompleteRequest);
  res.once("close", abortIncompleteResponse);
  return {
    signal: controller.signal,
    dispose: () => {
      req.off("aborted", abort);
      req.off("close", abortIncompleteRequest);
      res.off("close", abortIncompleteResponse);
    }
  };
}
function yieldToRequestEvents() {
  return new Promise((resolve5) => setTimeout(resolve5, 0));
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function decodedBase64Length(value) {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==") && (alphabet.indexOf(value.at(-3) ?? "") & 15) !== 0) {
    return null;
  }
  if (!value.endsWith("==") && value.endsWith("=") && (alphabet.indexOf(value.at(-2) ?? "") & 3) !== 0) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}
function decodeUploadFiles(body, limits) {
  if (!isRecord3(body) || !hasExactKeys(body, ["files"]) || !Array.isArray(body.files)) {
    throw new ImportRequestError(400, "invalid_import_payload");
  }
  if (body.files.length === 0) throw new ImportRequestError(400, "no_files");
  if (body.files.length > limits.maxFiles) {
    throw new ImportRequestError(413, "import_file_count_exceeded");
  }
  const descriptors = [];
  const ids = /* @__PURE__ */ new Set();
  let totalDecodedBytes = 0;
  for (const value of body.files) {
    if (!isRecord3(value) || !hasExactKeys(value, ["id", "name", "dataBase64"])) {
      throw new ImportRequestError(400, "invalid_import_payload");
    }
    const { id, name, dataBase64 } = value;
    if (typeof id !== "string" || id.length === 0 || id.length > limits.maxIdLength || !/^[A-Za-z0-9_-]+$/.test(id) || typeof name !== "string" || name.length === 0 || name.length > limits.maxNameLength || Buffer.byteLength(name, "utf8") > limits.maxNameLength || /[\/\\\0]/.test(name) || typeof dataBase64 !== "string") {
      throw new ImportRequestError(400, "invalid_import_payload");
    }
    if (ids.has(id)) throw new ImportRequestError(400, "duplicate_file_id");
    ids.add(id);
    const decodedBytes = decodedBase64Length(dataBase64);
    if (decodedBytes === null) throw new ImportRequestError(400, "invalid_base64");
    if (decodedBytes > limits.maxFileBytes) {
      throw new ImportRequestError(413, "import_file_too_large");
    }
    totalDecodedBytes += decodedBytes;
    if (!Number.isSafeInteger(totalDecodedBytes) || totalDecodedBytes > limits.maxTotalDecodedBytes) {
      throw new ImportRequestError(413, "import_total_size_exceeded");
    }
    descriptors.push({ id, name, dataBase64, decodedBytes });
  }
  return descriptors.map(({ id, name, dataBase64, decodedBytes }) => {
    const data = Buffer.from(dataBase64, "base64");
    if (data.length !== decodedBytes || data.toString("base64") !== dataBase64) {
      throw new ImportRequestError(400, "invalid_base64");
    }
    return { id, file: { name, data } };
  });
}
function sendImportRequestError(res, err) {
  if (err instanceof ImportAbortedError) {
    send(res, 499, { error: err.code });
    return;
  }
  if (err instanceof ImportRequestError) {
    send(res, err.status, { error: err.code });
    return;
  }
  send(res, 500, { error: "import_failed" });
}
function buildTrends(db, now) {
  const repo = new Repository(db);
  const workouts = repo.listWorkouts();
  const rides = workouts.map((w) => {
    const a = getOrComputeAnalytics(db, w.id, now());
    return {
      id: w.id,
      startUtc: w.start_utc,
      durationS: w.duration_s,
      distanceM: a?.distanceM ?? null,
      avgHr: a?.heartRate.avg ?? null,
      avgSpeedMs: a?.avgSpeedMs ?? null,
      efficiency: a?.efficiency ?? null,
      zones: a?.zones ?? null,
      elevationGainM: a?.elevation.gainM ?? null
    };
  });
  const weeks = /* @__PURE__ */ new Map();
  for (const r of rides) {
    const d = new Date(r.startUtc);
    const day = (d.getUTCDay() + 6) % 7;
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    const key = new Date(monday).toISOString().slice(0, 10);
    const bucket = weeks.get(key) ?? {
      weekStartUtc: monday,
      rideCount: 0,
      distanceM: 0,
      durationS: 0
    };
    bucket.rideCount++;
    bucket.distanceM += r.distanceM ?? 0;
    bucket.durationS += r.durationS;
    weeks.set(key, bucket);
  }
  return {
    rides,
    weekly: [...weeks.values()].sort((a, b) => a.weekStartUtc - b.weekStartUtc)
  };
}
function readJsonBody(req, maxBytes, signal) {
  return new Promise((resolve5, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", rejectAborted);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("close", onClose);
      req.off("error", onError);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const rejectAborted = () => rejectOnce(new ImportAbortedError());
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        req.resume();
        rejectOnce(new ImportRequestError(413, "import_body_too_large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        settled = true;
        cleanup();
        resolve5(body);
      } catch {
        rejectOnce(new ImportRequestError(400, "invalid_json"));
      }
    };
    const onAborted = () => rejectOnce(new Error("request_aborted"));
    const onClose = () => {
      if (!req.complete) rejectOnce(new Error("request_closed"));
    };
    const onError = (error) => rejectOnce(error);
    if (signal?.aborted) {
      rejectAborted();
      return;
    }
    signal?.addEventListener("abort", rejectAborted, { once: true });
    const declared = req.headers["content-length"];
    if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      req.resume();
      rejectOnce(new ImportRequestError(413, "import_body_too_large"));
      return;
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("close", onClose);
    req.on("error", onError);
  });
}
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json; charset=utf-8"
};
function serveStatic(res, staticDir, path) {
  securityHeaders(res);
  if (!staticDir) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Velograph API. Web client not built.");
    return;
  }
  const rel = normalize(path).replace(/^([/\\])+/, "");
  let file = join6(staticDir, rel);
  if (!file.startsWith(normalize(staticDir))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  if (!existsSync4(file) || statSync4(file).isDirectory()) {
    file = join6(staticDir, "index.html");
    if (!existsSync4(file)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync2(file));
}

// apps/api/src/main.ts
import { existsSync as existsSync5 } from "node:fs";
import { dirname as dirname4, join as join7 } from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL } from "node:url";

// apps/api/src/shutdown-coordinator.ts
function createShutdownCoordinator(options) {
  let shuttingDown = false;
  let finished = false;
  return (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.log(`Velograph: ${reason}; draining local requests before shutdown.`);
    const deadline = { handle: void 0 };
    const finish = (code, errorMessage) => {
      if (finished) return;
      finished = true;
      if (deadline.handle !== void 0) options.cancel(deadline.handle);
      if (errorMessage) options.error(errorMessage);
      options.exit(code);
    };
    deadline.handle = options.schedule(() => {
      finish(1, `Velograph: graceful shutdown exceeded ${options.timeoutMs}ms; forcing exit.`);
    }, options.timeoutMs);
    void options.shutdown().then(
      () => finish(0),
      () => finish(1, "Velograph: graceful shutdown failed; forcing exit.")
    );
  };
}

// apps/api/src/shutdown.ts
function closeHttpServer(server) {
  return new Promise((resolve5, reject) => {
    const wasListening = server.listening;
    server.close((error) => {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") {
        resolve5();
      } else if (error) {
        reject(error);
      } else {
        resolve5();
      }
    });
    if (wasListening) {
      server.closeIdleConnections?.();
    }
  });
}
async function shutdownApiServer(server) {
  let firstError;
  const capture = (error) => {
    firstError ??= error;
  };
  try {
    await closeHttpServer(server);
  } catch (error) {
    capture(error);
  }
  try {
    await server.waitForRequests();
  } catch (error) {
    capture(error);
  }
  const db = server.getDatabase();
  if (db.open) {
    try {
      checkpointDatabase(db);
    } catch (error) {
      capture(error);
    } finally {
      try {
        db.close();
      } catch (error) {
        capture(error);
      }
    }
  }
  server.closeBasemap();
  if (firstError !== void 0) throw firstError;
}

// apps/api/src/main.ts
var DEFAULT_HOST = "127.0.0.1";
var DEFAULT_PORT = 5123;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
var SHUTDOWN_TIMEOUT_MS = 1e4;
var ApiConfigurationError = class extends Error {
  field;
  constructor(field) {
    super(`invalid_${field}`);
    this.name = "ApiConfigurationError";
    this.field = field;
  }
};
function readApiRuntimeConfig(env = process.env) {
  const host = env["VELO_HOST"] ?? DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(host)) throw new ApiConfigurationError("host");
  const rawPort = env["VELO_PORT"] ?? String(DEFAULT_PORT);
  if (!/^(?:0|[1-9]\d{0,4})$/.test(rawPort)) throw new ApiConfigurationError("port");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ApiConfigurationError("port");
  }
  return { host, port };
}
function configuredParentPid(env) {
  const raw = env["VELO_EXIT_WITH_PARENT_PID"];
  if (!raw || !/^[1-9]\d*$/.test(raw)) return void 0;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) ? pid : void 0;
}
function resolveWebDist(moduleUrl = import.meta.url) {
  const runtimeDirectory = dirname4(fileURLToPath2(moduleUrl));
  const candidates = [
    join7(runtimeDirectory, "web"),
    join7(runtimeDirectory, "..", "..", "web", "dist")
  ];
  return candidates.find((candidate) => existsSync5(join7(candidate, "index.html")));
}
function closeDatabaseWithoutThrow(db) {
  if (!db?.open) return;
  try {
    db.close();
  } catch {
  }
}
function listen(server, config) {
  return new Promise((resolve5, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("listen_address_unavailable"));
        return;
      }
      resolve5(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}
async function main(env = process.env) {
  let config;
  try {
    config = readApiRuntimeConfig(env);
  } catch (error) {
    if (error instanceof ApiConfigurationError && error.field === "host") {
      console.error("Refusing non-loopback bind: authentication is not implemented yet.");
    } else {
      console.error("Refusing invalid port.");
    }
    return 1;
  }
  let db;
  let server;
  try {
    const dataDir = resolveDataDir(env);
    const dbPath = databasePath(dataDir);
    db = openDatabase(dbPath);
    const basemapOverride = env["VELO_BASEMAP_PATH"]?.trim();
    const basemapPath = basemapOverride || join7(dataDir, "basemap.mbtiles");
    const staticDir = resolveWebDist();
    server = createApiServer({
      db,
      dbPath,
      basemapPath,
      basemapPathRequired: Boolean(basemapOverride),
      log: (record) => console.log(JSON.stringify(record)),
      ...staticDir ? { staticDir } : {}
    });
  } catch (error) {
    closeDatabaseWithoutThrow(db);
    throw error;
  }
  let boundPort;
  try {
    boundPort = await listen(server, config);
  } catch (error) {
    try {
      await shutdownApiServer(server);
    } catch {
    }
    throw error;
  }
  const shutdown = createShutdownCoordinator({
    shutdown: () => shutdownApiServer(server),
    exit: (code) => process.exit(code),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle2) => clearTimeout(handle2),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    timeoutMs: SHUTDOWN_TIMEOUT_MS
  });
  process.on("SIGINT", () => shutdown("received SIGINT"));
  process.on("SIGTERM", () => shutdown("received SIGTERM"));
  server.on("error", () => shutdown("server error"));
  const watchParentPid = configuredParentPid(env);
  if (watchParentPid !== void 0) {
    const watchdog = setInterval(() => {
      try {
        process.kill(watchParentPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          clearInterval(watchdog);
          shutdown("parent process exited");
        }
      }
    }, 1e3);
    watchdog.unref();
  }
  console.log(
    `Velograph listening on http://${config.host}:${boundPort} (data dir configured via VELO_DATA_DIR)`
  );
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error("Server failed: unexpected_error");
      process.exitCode = 1;
    }
  );
}
export {
  API_VERSION,
  InvalidAppSettingsError,
  SETTINGS_KEY,
  createApiServer,
  getOrComputeAnalytics,
  loadSettings,
  main,
  mergeAppSettings,
  parseAppSettings,
  readApiRuntimeConfig,
  repairWorkout,
  requestLogMethod,
  requestLogRoute,
  resolveWebDist,
  saveSettings
};
