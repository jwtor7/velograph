# Issues #43 and #55: crash-safe restore and shutdown design

## Requirements

- While a file-backed Velograph database is serving requests, when a restore is requested, the
  system shall stop admitting database work and wait for accepted work to drain before cutover.
- While an incoming backup is untrusted, when restore stages it, the system shall verify SQLite
  integrity, foreign keys, an ordered known migration prefix, successful compatible migrations,
  and exact current schema parity before closing the live handle.
- While restore is staging or validating, when any copy, migration, schema, integrity, metadata,
  or checkpoint operation fails, the system shall keep the original handle and database usable.
- While the live handle has been closed, when any cutover, durability, or replacement-open
  operation fails, the system shall reinstall and reopen the pre-cutover database snapshot.
- While a database contains private health and location data, when stage and rollback artifacts
  are created, the system shall place them in a verified mode-`0700` operation directory, create
  them with mode `0600`, and preserve the live database's ownership and mode for the installed
  file.
- While a backup destination is new or already exists with permissive permissions, when backup is
  requested, the system shall populate and validate a unique `0600` operation-directory stage,
  fsync it, atomically rename it over the destination, and fsync the parent directory without
  writing the destination in place.
- While an older backup exists, when creating its replacement fails before or after install, the
  system shall preserve the older backup and clean the incomplete stage.
- While backup requests in one or more processes target the same filesystem entry through
  identical or case-only alias paths, when they overlap, the system shall serialize them through
  cleanup so a failed earlier request cannot delete or restore over a later success.
- While the live database is open, when a backup destination names or aliases its main file,
  `-wal`, `-shm`, or `-journal` sidecar, the system shall reject it before creating a stage.
- While asynchronous backup staging is in progress, when the verified destination parent is
  renamed or replaced with a symlink, the system shall reject the operation before final install
  and shall not follow the replacement path during rollback or cleanup.
- While restore is staging, cutting over, reopening, or recovering, when the canonical live parent
  or expected database inode changes, the system shall fail closed, shall not write through the
  replacement path, and shall not create or adopt an empty database.
- While an error crosses the database/API/CLI boundary, when it is reported, the system shall
  expose only a stable value-free code and shall not expose paths, SQL, or stored values.
- While `app:stop` escalates to `SIGKILL`, when the process exits between the final identity check
  and the signal, the command shall treat `ESRCH` as successful termination.

## Architecture

### Frontend

- No UI contract changes. Settings continues to submit a local backup path through the existing
  confirmation flow.
- Existing loading and error handling consumes the API's stable error code without receiving a
  filesystem path or database content.

### Backend and database

1. Bind the canonical live path, live-file identity, and parent device/inode; open the selected
   source once, read-only, and reject invalid SQLite/integrity/migration history.
2. Create and verify a mode-`0700` operation directory inside that parent. Pre-create a `0600`
   stage inside it, populate it using SQLite's online backup API, then validate its source migration
   prefix.
3. Apply only bundled forward migrations to the stage. Compare its complete `sqlite_schema`,
   migration list, integrity result, and foreign-key result with a freshly migrated canonical
   database.
4. Checkpoint the live handle, then create and validate a separate `0600` rollback snapshot inside
   the operation directory through SQLite's backup API while the live handle remains open.
5. Copy the live database's mode and ownership onto the incoming stage, retain the rollback
   artifact with private mode `0600` and the live file's ownership, fsync both, revalidate the
   original parent and inode, close the live handle, and atomically rename the stage over the live
   path.
6. Reopen the replacement with `fileMustExist`, the expected installed inode, canonical path, and
   canonical-schema validation. On every failure after close, atomically reinstall the rollback
   snapshot from an independently validated SQLite-backup copy (or safely reopen the still-original
   expected inode when cutover did not commit) and return that handle in a structured recovery
   error.
7. Revalidate the live parent and expected inode around every asynchronous boundary. Remove the
   operation directory and sidecars after a proven outcome. Retain the protected rollback if
   recovery itself cannot be proven.

### Backup replacement

1. Canonicalize the destination, capture its parent-directory device/inode identity, reject
   live-database/sidecar conflicts, and acquire both the in-process operation turn and a
   cross-process SQLite lock inside the reserved `.velograph-backup.lock` directory in that
   canonical parent. This shared-filesystem lock is independent of process `TMPDIR` and
   conservatively serializes case-only aliases on case-insensitive filesystems.
2. Create and verify a mode-`0700` operation directory in the destination parent.
3. If a destination already exists, copy it to a `0600`, fsynced prior-snapshot file inside that
   operation directory. Create a different `0600` stage there; SQLite's backup API writes only to
   that stage.
4. Open the stage read-only, require canonical schema/integrity/migrations/foreign keys, close it,
   remove sidecars, and fsync it.
5. Revalidate the canonical parent identity and live-database conflicts immediately before and
   after atomically renaming the validated stage over the destination, then fsync the parent
   directory.
6. If any post-install step fails, copy the independent prior snapshot into a second file inside
   the protected operation directory and atomically install that copy. Do not consume the original
   prior snapshot until the rollback rename and parent-directory fsync are proven. If reinstall
   cannot be proven, retain the `0700` operation directory and private prior snapshot; never delete
   the only known-good older backup.

### Security

- The source path is opened once to avoid a validation/use substitution window.
- Schema identity comes from a fresh database built by the checked-in migrations, not from a
  hand-maintained allow-list.
- Migration rows must be an exact ordered prefix of bundled migration filenames; unknown, future,
  missing-middle, or reordered histories fail closed.
- Stage and rollback files are pre-created as `0600` inside a verified random mode-`0700`
  operation directory. If the parent is substituted, that child path is absent from the
  replacement, so SQLite cannot fall back to creating a process-default `0644` database there.
- Existing permissive backup destinations cannot transfer their mode to new snapshots; every
  installed backup comes from a `0600` stage.
- Live database and sidecar identities are not valid backup destinations.
- Same-process requests in one verified parent use an in-memory turn. Separate processes
  additionally hold an exclusive transaction in `lock.sqlite3` inside the persistent
  `.velograph-backup.lock` directory on the shared canonical parent filesystem. The directory is
  accepted only as a current-user-owned, non-symlink mode-`0700` directory and the file only as a
  current-user-owned, non-symlink, single-link mode-`0600` regular file. No-follow descriptors pin
  both inodes; descriptor/path identities are revalidated around the separate SQLite open and lock
  acquisition, then a second zero-timeout SQLite connection must contend on the pinned path to
  prove that the primary connection locked the validated inode. The directory, lock, and SQLite
  sidecar names are reserved backup destinations. SQLite releases the transaction when a process
  exits or crashes, and the lock contains no path, health data, or location data.
- The hidden lock directory remains after a completed operation. Automatic removal would allow a
  new process to lock replacement directory/file inodes while another process still holds or waits
  on the old inode. It may be removed manually only while no Velograph process can back up into
  that parent; the next backup recreates it.
- Backup staging rechecks the originally captured parent directory identity after every
  asynchronous boundary and immediately around final install. Node/macOS does not expose
  `renameat(2)` through the standard filesystem API, so the synchronous pre/post checks close
  observable directory/symlink substitutions without adding a native dependency. Cleanup refuses
  to follow a parent whose identity changed.
- Restore binds the canonical live parent and original file identity before staging, then checks
  both around stage copy, rollback copy, pre-swap hooks, post-close hooks, post-install hooks, and
  recovery copy. Replacement and recovery opens use `fileMustExist` and must match the expected
  inode, canonical path, and canonical Velograph schema; an absent path can never be silently
  created, migrated, and adopted.
- An installed-inode check remains defense in depth against a non-cooperating writer replacing the
  destination after install.
- API and CLI surfaces map all failures to stable codes; native filesystem and SQLite messages do
  not cross the boundary, including data-directory resolution, live-database open, and close
  failures.
- Restore remains protected by the loopback Host/Origin/CSRF controls and exclusive request barrier.

## Failure model

| Phase                                             | Live path                            | Required outcome                                             |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| Source open / stage copy / validation / migration | Original, open                       | Reject; original handle stays usable                         |
| Live checkpoint / rollback snapshot               | Original, open                       | Reject; original handle stays usable                         |
| After live close, before stage rename             | Original, closed                     | Reopen original; fall back to rollback install               |
| After stage rename, before replacement open       | Replacement, closed                  | Reinstall rollback snapshot and reopen original              |
| Replacement open fails                            | Replacement, closed                  | Reinstall rollback snapshot and reopen original              |
| Parent/inode changes after close                  | Untrusted or absent path             | Fail closed; retain the protected operation directory        |
| Recovery cannot be proven                         | Original copy at live path, unproven | Fail closed and retain the separate `0600` rollback artifact |

## Deterministic test plan

- Round-trip restore and current-schema parity.
- Incomplete/forged-current schema, corrupt file, foreign-key violation, future history, and pure
  out-of-order prefix checks.
- Injected stage-copy failure and an actual conflicting migration failure before live close.
- Injected failures immediately after live close, after replacement install, and on replacement
  reopen; each must prove original data, integrity, handle usability, mode, and artifact cleanup.
- `0600` stage/rollback population plus final live mode preservation.
- New and existing backup destinations, including an existing `0644` file, install only from a
  validated `0600` stage.
- Injected backup-copy and post-install failures preserve the older backup and clean the stage.
- Concurrent same-destination failure/success leaves the later success installed.
- A separate-process failure/success barrier with distinct `TMPDIR` values waits for an observed
  SQLite contention callback and proves the second writer does not begin staging until the first
  writer has completed rollback and cleanup; no negative timing window is used.
- A separate-process case-only alias barrier proves the parent-identity lock also serializes
  spellings that resolve to one entry on default macOS filesystems.
- The persistent lock directory and main/sidecar names are reserved as backup destinations.
  Directory, symlink, and ABA lock-entry substitutions at the SQLite-open boundary are rejected
  without following or accepting a different inode.
- Live database, sidecars, and hard-link aliases are rejected without disrupting the live handle.
- Replacing the verified destination parent with a symlink during staging rejects before install
  and leaves later live-handle writes present after reopen.
- Replacing the live parent during incoming-stage or rollback population leaves the substitute
  empty and retains private artifacts only beneath the moved mode-`0700` operation directory.
- Replacing the live parent after close returns `restore_recovery_failed`, creates no database in
  the substitute, and preserves the original data plus rollback beneath the moved parent.
- Failed rollback directory fsync leaves an independent private prior snapshot available.
- A spawned CLI process facing a corrupt current database returns exactly a stable value-free code
  without a native exception, stack, SQL, or path.
- Failed original reopen leaves a separate canonical `0600` recovery snapshot and returns only
  `restore_recovery_failed`.
- `SIGKILL` `ESRCH` race returns success without an uncaught error.

## Implementation plan

- [x] Centralize ordered migration file discovery and close failed database opens.
- [x] Add strict compatibility and canonical-schema validation.
- [x] Add `0600` stage/rollback snapshots, metadata preservation, and rollback recovery.
- [x] Bind restore to the canonical live parent/inode and require existing canonical reopens.
- [x] Protect temporary databases in verified mode-`0700` operation directories.
- [x] Serialize backup case aliases conservatively by verified parent identity.
- [x] Return stable restore codes through API and CLI.
- [x] Handle the final `SIGKILL` `ESRCH` race.
- [x] Add deterministic tests, data-management documentation, and changelog coverage.
- [x] Run focused tests and all repository gates.
