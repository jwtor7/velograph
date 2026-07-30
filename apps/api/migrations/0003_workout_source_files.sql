-- Preserve source ownership independently of normalized metric/route rows.
-- This keeps superseded and fallback-only route sources attached to the
-- workout whose import they contributed to.
CREATE TABLE workout_source_files (
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  source_file_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  PRIMARY KEY (workout_id, source_file_id)
);

CREATE INDEX idx_workout_source_files_source
  ON workout_source_files(source_file_id, workout_id);

-- Backfill ownership that is still recoverable from canonical normalized rows.
INSERT OR IGNORE INTO workout_source_files (workout_id, source_file_id)
SELECT workout_id, source_file_id FROM metric_series
UNION
SELECT workout_id, source_file_id FROM routes;

-- Older importers kept successful source hashes even when no normalized row
-- referenced them (for example, a route CSV superseded by GPX). Their workout
-- cannot be recovered safely from the hash-only inventory. Forget only these
-- unowned successful hashes so a later import can rebuild provenance. Keep
-- quarantined rows as the durable failure inventory.
DELETE FROM source_files
WHERE status = 'imported'
  AND NOT EXISTS (
    SELECT 1
    FROM workout_source_files ownership
    WHERE ownership.source_file_id = source_files.id
  );
