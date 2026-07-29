# Issues #43 and #55 restore security checkpoint

## Access controls

- [x] Restore remains a mutating loopback API action protected by existing Host, Origin, and custom
      CSRF-header checks.
- [x] The API exclusive barrier prevents concurrent application reads/writes during final cutover.
- [x] CLI documentation requires the API to be stopped before CLI restore.

## Input and compatibility validation

- [x] SQLite integrity is verified before live-state mutation.
- [x] Migration history is an ordered prefix of bundled migrations.
- [x] Staged migrations succeed and the result exactly matches a fresh canonical schema.
- [x] Foreign-key violations fail closed.
- [x] Unknown/future/out-of-order migrations and forged-current schemas fail closed.

## Private-data protection

- [x] Stage and rollback files are created as `0600` before private bytes are written.
- [x] Every backup destination is atomically replaced from a unique validated and fsynced `0600`
      sibling, even when the existing destination is permissive.
- [x] Failed backup creation preserves the prior backup and removes incomplete stages.
- [x] Installed database mode and ownership match the original database.
- [x] Temporary artifacts and sidecars are removed after a proven outcome.
- [x] A rollback artifact is retained rather than deleted when recovery cannot be proven.
- [x] No source path, database content, SQL error, or native exception is returned by API/CLI.

## Failure and recovery

- [x] The live handle remains open through all staging and validation.
- [x] The rollback snapshot uses SQLite's online backup API.
- [x] Every injected post-close failure reinstalls and reopens the original database.
- [x] Recovery installs from an independent SQLite-backup copy, leaving the separate `0600`
      rollback snapshot unchanged until reopening is proven.
- [x] Busy WAL checkpoints fail before close.
- [x] `SIGTERM`/`SIGKILL` PID identity checks prevent signalling a replacement process.
- [x] Final-force-stop `ESRCH` is treated as an already-completed stop.

## Logging and unrelated web risks

- [x] Existing request logs contain method/path/status only; restore adds no values or paths.
- [x] This change adds no authentication data, credentials, remote calls, HTML output, SQL string
      interpolation, or new rate-sensitive endpoint.
