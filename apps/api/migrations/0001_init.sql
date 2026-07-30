-- Velograph schema v1 (PRD §10). Instants are epoch milliseconds UTC.
-- Canonical SI units only; conversion happens at render.

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'failed')),
  importer_version TEXT NOT NULL,
  counts_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE source_files (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  sha256 TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  detected_type TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  retention_state TEXT NOT NULL DEFAULT 'hash_only'
    CHECK (retention_state IN ('hash_only', 'retained')),
  status TEXT NOT NULL CHECK (status IN ('imported', 'skipped_duplicate', 'quarantined')),
  error_code TEXT,
  size_bytes INTEGER NOT NULL
);

CREATE TABLE workouts (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  start_utc INTEGER NOT NULL,
  end_utc INTEGER NOT NULL,
  timezone TEXT,
  duration_s INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  quality_state TEXT NOT NULL DEFAULT 'ok'
);

CREATE INDEX idx_workouts_type_start ON workouts(type, start_utc);

CREATE TABLE metric_series (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id),
  metric_type TEXT NOT NULL,
  unit TEXT NOT NULL,
  source TEXT,
  start_utc INTEGER NOT NULL,
  end_utc INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  coverage REAL
);

CREATE INDEX idx_metric_series_workout ON metric_series(workout_id, metric_type);

CREATE TABLE metric_samples (
  id INTEGER PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE,
  t_utc INTEGER NOT NULL,
  value REAL NOT NULL,
  value_min REAL,
  value_max REAL,
  context TEXT,
  valid INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_metric_samples_series_t ON metric_samples(series_id, t_utc);

CREATE TABLE routes (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id),
  source_format TEXT NOT NULL CHECK (source_format IN ('gpx', 'csv')),
  point_count INTEGER NOT NULL,
  distance_m REAL,
  bounds_json TEXT NOT NULL,
  quality_state TEXT NOT NULL DEFAULT 'ok'
);

CREATE INDEX idx_routes_workout ON routes(workout_id);

CREATE TABLE route_points (
  id INTEGER PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  segment INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  t_utc INTEGER,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  ele_m REAL,
  speed_ms REAL,
  course_deg REAL,
  hacc_m REAL,
  vacc_m REAL
);

CREATE INDEX idx_route_points_route ON route_points(route_id, segment, seq);

CREATE TABLE analytics_snapshots (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER REFERENCES workouts(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'workout',
  formula_version TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workout_id, scope, formula_version, settings_hash, input_hash)
);

CREATE TABLE insight_runs (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER REFERENCES workouts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_id TEXT,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  output_json TEXT,
  validation_status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE user_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE notes_tags (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'tag')),
  content TEXT NOT NULL,
  ai_inclusion INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
