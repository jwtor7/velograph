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

- `backupDatabase(db, destPath)` canonicalizes each destination, captures the verified parent
  directory's device/inode identity, calls `guardAgainstCheckout` before writing anything, and
  rejects the live database, its SQLite sidecars, and filesystem aliases as destinations. An
  in-process turn and an exclusive SQLite transaction in a private OS-temp lock registry serialize
  the canonical destination across API/CLI processes; the `0600` lock is keyed by a SHA-256 and
  stores no path or ride data. It creates a unique sibling with mode `0600`, writes that stage
  through `better-sqlite3`'s
  `Database.prototype.backup()` (SQLite's `sqlite3_backup_init`/`step`/`finish`), then verifies
  canonical schema, migration history, integrity, and foreign keys. The stage is closed, sidecars
  removed, and file fsynced. Backup revalidates the original parent identity and live-database
  conflicts after asynchronous staging and immediately before and after the same-directory atomic
  rename; if the parent changes, rollback and cleanup refuse to follow the replacement path. The
  parent directory is fsynced after install. The destination is never populated in place, including
  when an existing destination is `0644`; the installed backup is always the private staged inode.
- When replacing an existing backup, the old file is first preserved in a separate unique `0600`,
  fsynced sibling. The cross-process destination lock remains held through rollback and cleanup, so
  one failed request cannot restore over a later successful request. A copy or validation failure
  leaves the original destination untouched. A post-install failure copies the preserved file to a
  separate recovery stage, installs that copy atomically, and retains the original private snapshot
  until the parent directory fsync succeeds. If reinstall cannot be proven, Velograph keeps the
  independent prior snapshot rather than deleting the only known-good backup. Completed operations
  and failures with a proven outcome clean their incomplete stages.
- `restoreDatabase(liveDb, dbPath, backupPath)` opens the selected source once, read-only, then
  backs it into a uniquely named sibling stage through SQLite's backup API. Before touching the
  live handle, restore verifies SQLite integrity and requires the recorded migration names to be
  an exact ordered prefix of the migrations bundled with the running version. It migrates only
  the private stage, then compares the stage's complete `sqlite_schema` and migration list with a
  freshly migrated canonical database and requires an empty `foreign_key_check`. A database that
  merely contains a `workouts` table, claims a migration it does not structurally implement, has
  an unknown/future/missing-middle/reordered migration, or contains broken references fails
  closed.
- Stage and rollback files are pre-created with mode `0600` before private bytes are populated.
  Once complete, they receive the live database's ownership and permission mode, are closed and
  fsynced, and only then become eligible for cutover. This prevents the process umask from making
  a temporary health/location database broader than the live file and preserves restrictive
  permissions across inode replacement.
- The live handle is checkpointed, but remains open while restore creates and validates a second
  rollback snapshot through SQLite's backup API. The rollback remains `0600`; it is never renamed
  away during recovery. Only then is the handle closed. A same-directory `rename` installs the
  complete incoming stage atomically. If any operation after close fails—including install
  durability or reopening the replacement—restore uses SQLite's backup API to make another
  independent, validated recovery-install stage from the rollback, atomically installs that copy,
  and attempts to reopen it. Recovery success removes the rollback. If reopening still cannot be
  proven, the API returns only `restore_recovery_failed`, fails closed, and retains the separate
  canonical `0600` rollback sibling without exposing its path. Old `-wal`/`-shm`/`-journal`
  sidecars are removed only around a proven atomic outcome.
- Backup and restore failures cross API/CLI boundaries only as stable value-free codes such as
  `destination_inside_checkout`, `destination_conflicts_with_live_database`,
  `invalid_backup_destination`,
  `invalid_backup_schema`, `invalid_backup_migrations`, `invalid_backup_foreign_keys`,
  `restore_cutover_failed`, `restore_reopen_failed`, or `restore_recovery_failed`; native
  SQLite/filesystem messages, paths, SQL, stored values, and stacks are not returned. The CLI's
  final command boundary also covers data-directory resolution plus live-database open and close
  failures.
- The API places restore behind an exclusive request barrier. New non-health requests receive a
  privacy-safe `restore_in_progress` response while every earlier request drains. Async operations
  remain leased after a client disconnects, so SIGINT/SIGTERM stop new connections and wait for
  that work to settle before checkpointing the current WAL and closing the current (possibly
  replaced) handle. A busy/incomplete WAL checkpoint fails closed. `pnpm app:stop` waits for the
  verified process to exit—not merely for its listening socket to close—then reports any SIGKILL
  escalation after the 12-second grace period. If the process exits in the final identity-check
  to `SIGKILL` race, `ESRCH` is treated as a completed stop rather than an unhandled command
  failure.
- Velograph currently supports one database-owning process at a time. Stop the API with
  `pnpm app:stop` before running `velograph restore`; do not run API and CLI restore concurrently
  against the same data directory.

Both directions are exercised end to end (round trip, checkout rejection, and live-database
destination rejection), along with forged/incomplete/current/future migration histories, corrupt
input, foreign-key failure, copy and migration failure, serialized atomic replacement of an
existing permissive backup, failed-backup preservation/cleanup, independent prior-snapshot
retention until directory durability, cross-process failure/success ordering, destination-parent
symlink substitution, private artifact modes, original-mode preservation, failures before and after
replacement install, replacement-open rollback, separate recovery retention when reopen cannot be
proven, spawned-CLI corrupt-database handling, graceful WAL checkpoint/close, privacy-safe surface
codes, and stop escalation/`ESRCH`, in
`packages/db/src/backup.test.ts`, `packages/db/src/migrate.test.ts`,
`apps/api/src/shutdown.test.ts`, `apps/api/src/shutdown-coordinator.test.ts`,
`apps/api/src/data-management.test.ts`, `scripts/app.test.mjs`, and
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
