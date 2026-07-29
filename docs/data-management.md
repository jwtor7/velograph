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
- `workout_source_files` records every successfully associated source independently from the
  normalized rows currently selected for display. A route CSV therefore remains owned after GPX
  replaces its geometry, and a route CSV imported after GPX remains attributable even though it
  is fallback-only. Before deleting a workout, `deleteWorkout` collects all of these source IDs
  (plus direct metric/route references as a defensive legacy fallback), deletes the workout, then
  removes each `source_files` row only when no remaining workout ownership, metric series, or route
  references it.
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

Migration `0003_workout_source_files.sql` backfills every ownership relationship that can be
recovered from existing metric and route rows. Older successful source rows with no remaining
normalized reference cannot be attributed safely after the fact, so the migration forgets only
those hashes; re-importing them rebuilds explicit ownership. Quarantined inventory rows remain
untouched. Importer coverage also exercises route CSV → GPX replacement → workout delete → route
CSV re-import so the superseded-hash path cannot regress.

## Parser-version reprocessing

An identical content hash is skipped only while its stored parser version is current. When a
parser version changes, the importer first parses, validates, and resolves ownership without
changing the canonical `source_files` row or any normalized data:

- A source that owns normalized rows in exactly one workout replaces only those parser-owned
  rows and keeps the same workout ID. Notes/tags and other user-authored workout children are
  never parser-owned and remain attached.
- A source that appears to own more than one workout is ambiguous and fails closed without
  detaching anything. The current importer does not create this shape, but the schema permits it,
  so the guard is defensive.
- A failed replacement parse or association leaves the prior source metadata and
  last-known-good metrics/routes untouched. The additive
  `source_file_reprocessing_failures` table records only the source ID, import batch ID,
  attempted parser version, stable value-free error code, and timestamp. It stores no filename,
  sample value, route coordinate, raw input, or exception text.

The replacement and its cache invalidation still occur inside the confirmed import transaction;
an unexpected storage error rolls every mutation back. Initial imports remain different: a new
malformed source has no last-known-good state, so its canonical `source_files` row is created with
`status = 'quarantined'` as before.

## Import skip versus store policy

The importer classifies a value-free filename before hashing, parsing, or persistence:

- A supported cycling metric or route continues through parsing, association, and storage.
- A well-formed Health Auto Export filename for an unmodelled cycling metric is a normal
  `unmodelled_metric` skip.
- A well-formed Health Auto Export filename for Running or another non-cycling workout is a
  normal `non_cycling_workout` skip. A GPX route never defaults to cycling when the filename does
  not explicitly identify Indoor or Outdoor Cycling.
- An unrelated, malformed, or supported-but-invalid file continues through the in-scope error
  path and is quarantined with a stable, value-free code.

Normal skips are returned only as aggregate counts. They do not create `source_files` rows,
quarantine entries, warnings, or filename-bearing result items. In particular, the content hash
is not stored: adding support for that metric or workout later allows the exact same file to be
imported rather than being suppressed as a duplicate. Quarantine remains the durable record for a
file Velograph was expected to understand but could not parse safely.

## Canonical input-unit contract

`hae-csv-v3` matches explicit, normalized headers and converts accepted values before persistence:

| Input family                       | Accepted header units | Stored unit |
| ---------------------------------- | --------------------- | ----------- |
| Heart rate                         | `bpm`, `count/min`    | `bpm`       |
| Cycling cadence                    | `rpm`, `count/min`    | `rpm`       |
| Cycling distance                   | `km`, `m`             | `m`         |
| Active energy                      | `kJ`, `J`, `kcal`     | `J`         |
| Route altitude                     | `m`, `ft`             | `m`         |
| Route horizontal/vertical accuracy | `m`, `ft`             | `m`         |
| Route speed                        | `m/s`, `km/h`         | `m/s`       |
| Route course                       | `deg`                 | `deg`       |

The kilometre, kilojoule, thermochemical kilocalorie, foot, and kilometre-per-hour conversions
are deterministic code. Unit-bearing families never inherit a default: a generic header such as
`Distance`, `Energy`, `Altitude`, or `Speed`, an unsupported unit, or two competing columns fails
closed before samples are stored. Missing or unsupported units use the stable, value-free
`unit_unsupported` quarantine code. Changing this interpretation requires another adapter version,
which makes existing content hashes eligible for safe parser-version reprocessing.

## Import cancellation and rollback

Browser file encoding is sequential and receives the same `AbortSignal` as its subsequent
loopback request. The Import page exposes Cancel controls while reviewing files, scanning a path,
or importing either source. On the server, an aborted request, an incomplete request close, or a
response close before completion aborts one request-scoped controller. That signal is passed
through `runImport`/`runImportGroups`.

The SQLite transaction checks cancellation before loading each lazy group, while expanding and
processing files, and immediately before it marks the batch committed. API imports yield to the
event loop at those bounded checkpoints while keeping other database requests out of the open
transaction. An observed abort throws `ImportAbortedError`, so SQLite rolls back the batch row,
sources, normalized data, and workouts together. Folder imports remain bounded to one association
group at a time, making those checkpoints practical without retaining the full export. Contract
tests cover cancellation before work, after an earlier group has written inside the
still-uncommitted transaction, and after a loopback client disconnects.

## Backup / restore

`packages/db/src/backup.ts`:

- `backupDatabase(db, destPath)` canonicalizes each destination, captures the verified parent
  directory's device/inode identity, calls `guardAgainstCheckout` before writing anything, and
  rejects the live database, its SQLite sidecars, and filesystem aliases as destinations. The
  guard resolves the nearest existing ancestor and validates each missing component, so an
  outside-looking symlink cannot redirect a backup into a checkout; the destination is checked
  again after directory creation. An
  in-process turn and an exclusive SQLite transaction inside `.velograph-backup.lock` in that
  verified canonical parent conservatively serialize every backup there across API/CLI processes,
  even when those processes have different `TMPDIR` values. Locking by parent device/inode
  in-process and by one shared directory on the canonical parent filesystem means case-only aliases
  on a default case-insensitive macOS filesystem cannot acquire separate locks. The hidden
  directory is a current-user-owned, non-symlink mode-`0700` directory; its `lock.sqlite3` is a
  current-user-owned, non-symlink, single-link mode-`0600` regular file. Both are opened without
  following symlinks, pinned by descriptors, and checked by descriptor and pathname identity around
  the separate SQLite open and lock acquisition. After acquisition, a second zero-timeout SQLite
  connection to the pinned path must observe contention, proving that the primary connection
  actually locked the validated inode. The lock stores no path or ride data. The directory, lock,
  and SQLite `-wal`, `-shm`, and `-journal` sidecar names are reserved and cannot be backup
  destinations. Backup creates a verified mode-`0700` operation directory and a `0600` stage inside
  it, then writes that stage through `better-sqlite3`'s
  `Database.prototype.backup()` (SQLite's `sqlite3_backup_init`/`step`/`finish`), then verifies
  canonical schema, migration history, integrity, and foreign keys. The stage is closed, sidecars
  removed, and file fsynced. Backup revalidates the original parent identity and live-database
  conflicts after asynchronous staging and immediately before and after the same-filesystem atomic
  rename; if the parent changes, the private operation directory becomes unreachable through the
  replacement and rollback/cleanup refuse to follow it. The parent directory is fsynced after
  install. The destination is never populated in place, including when an existing destination is
  `0644`; the installed backup is always the validated staged inode.
- When replacing an existing backup, the old file is first preserved in a separate unique `0600`,
  fsynced file inside the operation directory. The cross-process parent lock remains held through
  rollback and cleanup, so one failed request cannot restore over a later successful request. A
  copy or validation failure leaves the original destination untouched. A post-install failure
  copies the preserved file to a separate recovery stage, installs that copy atomically, and
  retains the original private snapshot until the parent directory fsync succeeds. If reinstall
  cannot be proven, Velograph keeps the independent prior snapshot in its `0700` operation
  directory rather than deleting the only known-good backup. Completed operations and failures
  with a proven outcome remove their operation directories.
- The hidden `.velograph-backup.lock` directory intentionally remains after backup completion.
  Removing it automatically could let a new process create and lock a different directory/file
  inode while another process still holds or waits on the old inode, breaking serialization. An
  operator may remove the directory only while no Velograph process can be backing up into that
  parent; the next backup recreates the private lock.
- `restoreDatabase(liveDb, dbPath, backupPath)` opens the selected source once, read-only, then
  binds the canonical live path, its file identity, and its parent device/inode before creating a
  verified mode-`0700` operation directory. Restore backs the source into that directory through
  SQLite's backup API and revalidates the original path and parent around every asynchronous
  staging, rollback, hook, cutover, and recovery boundary. Before touching the live handle, restore
  verifies SQLite integrity and requires the recorded migration names to be an exact ordered prefix
  of the migrations bundled with the running version. It migrates only the protected stage, then
  compares the stage's complete `sqlite_schema` and migration list with a freshly migrated
  canonical database and requires an empty `foreign_key_check`. A database that merely contains a
  `workouts` table, claims a migration it does not structurally implement, has an
  unknown/future/missing-middle/reordered migration, or contains broken references fails closed.
- Stage and rollback files are pre-created with mode `0600` inside the verified `0700` operation
  directory before private bytes are populated. Once complete, the incoming stage receives the
  live database's ownership and permission mode, while the rollback stays `0600`; both are closed
  and fsynced before cutover. If the live parent is substituted, the random protected directory is
  absent from the replacement path, so SQLite fails before it can create a process-default `0644`
  health/location database there.
- The live handle is checkpointed, but remains open while restore creates and validates a second
  rollback snapshot through SQLite's backup API. The rollback remains `0600`; it is never renamed
  away during recovery. Only then is the handle closed. A same-filesystem `rename` installs the
  complete incoming stage atomically. If any operation after close fails—including install
  durability or reopening the replacement—restore uses SQLite's backup API to make another
  independent, validated recovery-install stage from the rollback, atomically installs that copy,
  and attempts to reopen it. Recovery success removes the rollback. If reopening still cannot be
  proven, the API returns only `restore_recovery_failed`, fails closed, and retains the separate
  canonical `0600` rollback inside its `0700` operation directory without exposing its path.
  Replacement and recovery opens always require an existing file, the expected device/inode,
  canonical live path, and canonical Velograph schema; they cannot create or adopt a new empty
  database. Old `-wal`/`-shm`/`-journal` sidecars are removed only around a proven atomic outcome.
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
- New backups are self-contained SQLite files with one `backup_manifests` row. The manifest records
  the backup format, app version, latest schema migration, explicit included/excluded categories,
  and SHA-256 checksums for every non-manifest table. Raw source files and credentials are never
  included. Restore verifies those checksums before staging and returns an integrity report covering
  manifest, checksums, SQLite integrity, foreign keys, and applied compatibility migrations.
- `schema_migrations` records the SHA-256 digest of each migration as well as its ordered filename.
  The filename-only `0001_init.sql` history released in v0.1.0 is adopted only when the bundled
  migration still matches its immutable published digest. Missing checksums for any other migration
  fail closed, as do duplicate sequence numbers, skipped/reordered history, and changed applied
  migration contents. After the compatibility upgrade, every migration is cryptographically pinned.

Both directions are exercised end to end (round trip, checkout rejection, and live-database
destination rejection), along with forged/incomplete/current/future migration histories, corrupt
input, foreign-key failure, copy and migration failure, serialized atomic replacement of an
existing permissive backup, failed-backup preservation/cleanup, independent prior-snapshot
retention until directory durability, identical-path cross-process ordering across distinct
`TMPDIR` values, case-alias cross-process ordering, reserved/tampered lock-artifact rejection,
lock-entry ABA rejection across SQLite open, backup/restore/rollback parent substitution without
writes into the replacement path, private operation-directory and artifact modes, original-mode
preservation, failures before and after replacement install, expected-inode replacement-open
rollback, no-create recovery after a post-close parent swap, separate recovery retention when
reopen cannot be proven, spawned-CLI corrupt-database handling, graceful WAL checkpoint/close,
privacy-safe surface codes, and stop escalation/`ESRCH`, in
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
from scratch. It then computes and persists a snapshot under the current `FORMULA_VERSION`.
Snapshots from earlier formula versions remain immutable provenance records beside the current
result: the formula version is part of the snapshot key, so an upgrade recomputes the ride without
overwriting or deleting its prior analytical evidence.

## Surfaces

- **API** (`apps/api/src/server.ts`): `DELETE /api/workouts/:id`,
  `POST /api/workouts/:id/repair`, `POST /api/backup` (`{ path }`), and
  `POST /api/restore` (`{ path, confirmed: true }`) — all mutating, so all require the existing loopback/CSRF
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
  `restore <backupPath> --confirm-replace`, and `repair <workoutId>`, alongside the existing `import`, each
  accepting `--data-dir`.
