-- Portable, self-contained backup metadata. The live database keeps this
-- table empty; backup creation writes exactly one manifest row into the
-- private SQLite snapshot before it is atomically installed.
CREATE TABLE backup_manifests (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format_version INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  included_categories_json TEXT NOT NULL,
  checksums_json TEXT NOT NULL,
  manifest_checksum TEXT NOT NULL
);
