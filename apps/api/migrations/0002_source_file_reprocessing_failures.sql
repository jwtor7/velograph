-- Failed parser-upgrade attempts are append-only audit facts. They intentionally
-- do not mutate the canonical source_files row or its last-known-good data.
CREATE TABLE source_file_reprocessing_failures (
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  attempted_parser_version TEXT NOT NULL,
  error_code TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_source_file_reprocessing_failures_source
  ON source_file_reprocessing_failures(source_file_id, id);
