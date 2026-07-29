# Data management — delete, backup, restore, repair (issue #38)

PRD Phase 1 ("Backup, restore, delete, and repair") and §12.2 (repository leak prevention —
backups carry real health data and must never enter the checkout). This document covers the four
operations, and in particular the delete/idempotency decision the issue calls out as the subtle
part.

## Delete

`Repository.deleteWorkout(workoutId)` (`packages/db/src/repository.ts`) removes a workout and
every row that belongs to it in a single `better-sqlite3` transaction:

- `metric_series` → `metric_samples`, `routes` → `route_points`, `analytics_snapshots`,
  `insight_runs`, and `notes_tags` all declare `ON DELETE CASCADE` on `workout_id` in the schema
  (`packages/db/migrations/0001_init.sql`), so deleting the `workouts` row cascades them
  automatically — no manual fan-out, no orphan rows.
- `source_files` rows are **not** covered by that cascade (a file can, in principle, be shared —
  see below), so `deleteWorkout` handles them explicitly: before deleting the workout it collects
  the distinct `source_file_id`s its `metric_series`/`routes` rows reference, deletes the
  workout, then removes each collected `source_files` row only if no remaining `metric_series` or
  `routes` row (belonging to any other workout) still references it.
- A source file still referenced by another workout survives untouched. The current importer
  (`packages/importers/src/importer.ts`) always gives each imported file its own `source_files`
  row — one file is never split across two workouts — so this case doesn't arise from normal
  import today. The ownership check is still correct defensively (the schema does not forbid two
  rows from pointing at the same `source_file_id`), and `packages/db/src/repository.test.ts`
  constructs the shared case directly against the repository to prove it.

## The idempotency decision: forget the hash, don't tombstone it

Imports are idempotent by content hash: `source_files.sha256` is `UNIQUE`, and
`Repository.findSourceFileByHash` skips any file whose hash is already present, regardless of
that row's `status`. If delete left the `source_files` row behind, a later re-import of the exact
same bytes would be skipped as a "duplicate" — silently produce zero workouts — even though the
ride the user is trying to bring back no longer exists anywhere in the database. That is a
data-loss-shaped bug hiding behind a feature (idempotency) that exists specifically to prevent
data loss.

Two designs were considered:

1. **Forget the hash (chosen).** When a `source_files` row becomes unreferenced by every
   workout as part of a delete, delete the row outright. The unique hash is free again, so a
   later import of the identical file is treated as new — full ride import, not a skip.
2. **Tombstone.** Keep the `source_files` row but flip it to a new `status` (e.g. `'deleted'`),
   and teach the importer's duplicate check to treat a tombstoned hash as "not a duplicate" —
   either by reusing/updating that row on re-import, or by relaxing the `UNIQUE` constraint to
   allow a second row for the same hash.

Forgetting the hash was chosen because:

- **It is the only option that keeps the importer untouched.** `runImport`'s duplicate check
  stays a single `findSourceFileByHash` lookup with no "but only if not tombstoned" branching,
  and the `sha256 UNIQUE` constraint keeps meaning exactly what it says: at most one _live_
  record per content hash. A tombstone design would need either a second status value threaded
  through every place that reads `source_files.status`, or a schema change dropping the
  uniqueness guarantee — both larger surface for a Phase 1 feature to carry.
- **It matches the acceptance criterion exactly.** The issue requires "re-importing a previously
  deleted file should import cleanly, not be skipped as a duplicate" — forgetting the hash makes
  that true by construction, with no special-casing anywhere else in the system.
- **A tombstone would not actually buy back an undo.** Deleting a workout already destroys its
  derived data (samples, route points, analytics) irreversibly via the cascade; the UI and CLI
  both say so before the action fires (see below). Keeping a dead `source_files` row around adds
  bookkeeping (when a hash was first seen, when it was deleted) that nothing else in the product
  reads or surfaces — Velograph has no import-history or audit-log view. If that changes, this
  decision should be revisited alongside a real audit trail; a backup taken before deleting is
  the supported way to keep a longer record today.

`packages/db/src/repository.test.ts` (`'a deleted file re-imports cleanly instead of being
skipped as a duplicate'`) and `apps/cli/src/index.test.ts` (`'imports, deletes, and repairs a
workout end to end'`) both exercise the full round trip: import → delete → re-import the
identical bytes → the ride comes back.

## Backup / restore

`packages/db/src/backup.ts`:

- `backupDatabase(db, destPath)` calls `guardAgainstCheckout(dirname(destPath))` — the same guard
  `resolveDataDir` uses for `VELO_DATA_DIR` — before writing anything, then uses
  `better-sqlite3`'s `Database.prototype.backup()`, which wraps SQLite's own online backup API
  (`sqlite3_backup_init`/`step`/`finish`). This is a safe, consistent snapshot of a live
  WAL-mode database; it is never a raw `fs.copyFile` of the `.sqlite3`/`-wal`/`-shm` files, which
  could copy a torn, mid-write state.
- `restoreDatabase(liveDb, dbPath, backupPath)` validates the source file first
  (`isVelographBackup`: openable read-only and has a `workouts` table), then checkpoints and
  closes `liveDb` (`PRAGMA wal_checkpoint(TRUNCATE)` so nothing is left un-flushed), clears any
  leftover `-wal`/`-shm` sidecars next to `dbPath` (so a stale WAL can never be replayed against
  freshly-restored pages), backs the validated source into `dbPath` via the same SQLite backup
  API, and reopens `dbPath` — which also brings a backup taken by an older Velograph version
  forward through any pending migrations. It returns the fresh `Database` handle; callers own
  swapping out their old reference (`apps/api/src/server.ts` reassigns `opts.db`).

Both directions are exercised end to end (round trip, and rejecting a backup path inside a git
checkout) in `packages/db/src/backup.test.ts`, `apps/api/src/data-management.test.ts`, and
`apps/cli/src/index.test.ts`.

## Repair

`repairWorkout(db, workoutId, now)` (`apps/api/src/analytics-service.ts`) re-derives a workout's
span from the normalized data it already owns — `MIN`/`MAX` over its `metric_series` and
`route_points` rows via `Repository.recomputeWorkoutSpan` — rather than re-parsing raw source
bytes: those bytes are not generally available (`source_files.retention_state` defaults to
`hash_only`, per PRD retention defaults), so "re-run association" at repair time means
re-deriving bounds from what's already stored, not re-running the file-association algorithm
from scratch. It then deletes any `analytics_snapshots` rows left over from a previous
`FORMULA_VERSION` (`Repository.deleteStaleAnalyticsSnapshots`) and computes + persists a fresh
snapshot under the current formula version, so upgrading the analytics engine and then repairing
a ride actually rebuilds its stored numbers instead of leaving stale ones cached alongside the
new ones.

## Surfaces

- **API** (`apps/api/src/server.ts`): `DELETE /api/workouts/:id`,
  `POST /api/workouts/:id/repair`, `POST /api/backup` (`{ path }`), and
  `POST /api/restore` (`{ path }`) — all mutating, so all require the existing loopback/CSRF
  hardening (`x-velograph-request` header, Host/Origin checks) already applied to every
  non-`GET`/`HEAD` route.
- **UI**: a "Delete" action on each ride list row (`apps/web/src/pages/Library.tsx`) and a
  "Delete ride" / "Repair ride" pair on the ride detail page
  (`apps/web/src/pages/RideDetail.tsx`), both routed through a shared `ConfirmDialog`
  (`apps/web/src/components/ui.tsx`) that names exactly what will be removed (metric samples,
  route, analytics) and states plainly that it is irreversible without a backup. Backup/restore
  live in Settings (`apps/web/src/pages/Settings.tsx`) as path-based fields — this is a
  local-first app talking to a loopback API on the same machine, so "the user's chosen path" is a
  filesystem path on that machine, not an upload; restore is behind the same confirmation
  pattern, since it discards everything since the backup.
- **CLI** (`apps/cli/src/index.ts`): `delete <workoutId>`, `backup <destPath>`,
  `restore <backupPath>`, and `repair <workoutId>`, alongside the existing `import`, each
  accepting `--data-dir`.
