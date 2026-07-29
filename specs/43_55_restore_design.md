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
  are created, the system shall create them with mode `0600` and preserve the live database's
  ownership and mode for the installed file.
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

1. Open the selected source once, read-only, and reject invalid SQLite/integrity/migration history.
2. Pre-create a sibling stage file as `0600`, populate it using SQLite's online backup API, then
   validate its source migration prefix.
3. Apply only bundled forward migrations to the stage. Compare its complete `sqlite_schema`,
   migration list, integrity result, and foreign-key result with a freshly migrated canonical
   database.
4. Checkpoint the live handle, then create and validate a separate `0600` rollback snapshot through
   SQLite's backup API while the live handle remains open.
5. Copy the live database's mode and ownership onto both complete artifacts, fsync them, close the
   live handle, and atomically rename the stage over the live path.
6. Reopen the replacement. On every failure after close, atomically reinstall the rollback
   snapshot (or reopen the still-original path when cutover did not commit) and return that handle
   in a structured recovery error.
7. Remove temporary files and sidecars after a proven outcome. Retain the rollback snapshot if
   recovery itself cannot be proven.

### Security

- The source path is opened once to avoid a validation/use substitution window.
- Schema identity comes from a fresh database built by the checked-in migrations, not from a
  hand-maintained allow-list.
- Migration rows must be an exact ordered prefix of bundled migration filenames; unknown, future,
  missing-middle, or reordered histories fail closed.
- Stage and rollback files are never populated with process-default public permissions.
- API and CLI surfaces map all failures to stable codes; native filesystem and SQLite messages do
  not cross the boundary.
- Restore remains protected by the loopback Host/Origin/CSRF controls and exclusive request barrier.

## Failure model

| Phase                                             | Live path           | Required outcome                                    |
| ------------------------------------------------- | ------------------- | --------------------------------------------------- |
| Source open / stage copy / validation / migration | Original, open      | Reject; original handle stays usable                |
| Live checkpoint / rollback snapshot               | Original, open      | Reject; original handle stays usable                |
| After live close, before stage rename             | Original, closed    | Reopen original; fall back to rollback install      |
| After stage rename, before replacement open       | Replacement, closed | Reinstall rollback snapshot and reopen original     |
| Replacement open fails                            | Replacement, closed | Reinstall rollback snapshot and reopen original     |
| Recovery cannot be proven                         | Unknown             | Fail closed and retain the `0600` rollback artifact |

## Deterministic test plan

- Round-trip restore and current-schema parity.
- Incomplete/forged-current schema, corrupt file, foreign-key violation, future history, and pure
  out-of-order prefix checks.
- Injected stage-copy failure and an actual conflicting migration failure before live close.
- Injected failures immediately after live close, after replacement install, and on replacement
  reopen; each must prove original data, integrity, handle usability, mode, and artifact cleanup.
- `0600` stage/rollback population plus final live mode preservation.
- `SIGKILL` `ESRCH` race returns success without an uncaught error.

## Implementation plan

- [x] Centralize ordered migration file discovery and close failed database opens.
- [x] Add strict compatibility and canonical-schema validation.
- [x] Add `0600` stage/rollback snapshots, metadata preservation, and rollback recovery.
- [x] Return stable restore codes through API and CLI.
- [x] Handle the final `SIGKILL` `ESRCH` race.
- [x] Add deterministic tests, data-management documentation, and changelog coverage.
- [x] Run focused tests and all repository gates.
