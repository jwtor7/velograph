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

- [x] Stage and rollback files are created as `0600` inside a verified random mode-`0700`
      operation directory before private bytes are written.
- [x] Every backup destination is atomically replaced from a unique validated and fsynced `0600`
      operation-directory stage, even when the existing destination is permissive.
- [x] Failed backup creation preserves the prior backup and removes incomplete stages.
- [x] Backup rejects the live database, its sidecars, and filesystem aliases as destinations.
- [x] Same-destination and case-only alias backup requests are conservatively serialized by
      verified parent identity in-process and by one persistent lock on the shared canonical
      parent filesystem across processes, including processes with distinct `TMPDIR` values. The
      lock is held through rollback and cleanup inside a current-user-owned, non-symlink
      mode-`0700` directory. Its single-link mode-`0600` regular file and directory are pinned by
      no-follow descriptors and revalidated by descriptor/path identity around SQLite open. A
      second zero-timeout connection must contend on the pinned path, proving the primary SQLite
      connection locked the validated inode.
- [x] The persistent directory, lock, and SQLite sidecar names are reserved backup destinations.
      The lock stores no path or ride data and remains after completion to prevent split-inode
      locking; the directory may be removed only while no process can be backing up there.
- [x] The verified destination parent device/inode and canonical path are checked after
      asynchronous staging and immediately around final install; cleanup never follows a changed
      parent.
- [x] Backup rollback retains an independent prior snapshot until directory durability is proven.
- [x] Restore binds the canonical live path, expected file inode, and parent device/inode before
      staging and revalidates them around every asynchronous cutover/recovery boundary.
- [x] Parent substitution cannot redirect backup, restore, rollback, or recovery population:
      SQLite's destination remains beneath the random `0700` directory, which is absent from a
      replacement parent.
- [x] Installed database mode and ownership match the original database.
- [x] Temporary artifacts and sidecars are removed after a proven outcome.
- [x] A rollback artifact is retained rather than deleted when recovery cannot be proven.
- [x] No source path, destination path, database content, SQL error, native exception, or stack is
      returned by API/CLI, including data-directory resolution and live-database open/close errors.

## Failure and recovery

- [x] The live handle remains open through all staging and validation.
- [x] The rollback snapshot uses SQLite's online backup API.
- [x] Every injected post-close failure reinstalls and reopens the original database.
- [x] Replacement and recovery opens use `fileMustExist` and accept only the expected inode,
      canonical path, and canonical Velograph schema; a missing path is never created or adopted.
- [x] Recovery installs from an independent SQLite-backup copy, leaving the separate `0600`
      rollback snapshot inside the `0700` operation directory unchanged until reopening is proven.
- [x] Busy WAL checkpoints fail before close.
- [x] `SIGTERM`/`SIGKILL` PID identity checks prevent signalling a replacement process.
- [x] Final-force-stop `ESRCH` is treated as an already-completed stop.

## Logging and unrelated web risks

- [x] Existing request logs contain method/path/status only; restore adds no values or paths.
- [x] This change adds no authentication data, credentials, remote calls, HTML output, SQL string
      interpolation, or new rate-sensitive endpoint.
