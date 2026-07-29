# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — see
[`docs/releasing.md`](docs/releasing.md) for what major/minor/patch mean while the project
is pre-1.0, and for the release procedure.

## [Unreleased]

### Added

- **Path-based folder import.** The web client can import a Health Auto Export folder by
  path instead of routing every file through the browser as base64: paste the folder path,
  preview the files it finds (grouped by ride — workout type + the filename's trailing
  timestamp — so companion metric files are obviously one ride before anything imports),
  then confirm. The API reads the folder directly from disk, recursing into subfolders,
  through incremental directory handles with explicit visited-entry, directory, depth,
  importable-file, and total-byte bounds; unsupported entries count toward traversal limits
  too. Each directory's canonical target and device/inode identity are captured before it is
  opened and revalidated after enumeration, so replacing a nested directory with a symlink
  during traversal fails the whole value-free plan with `path_changed` rather than returning
  entries from the replacement. Preview returns an opaque digest of the exact private manifest.
  Confirmation repeats the bounded walk and requires that digest to match before reading source
  bytes or beginning the database transaction, so mutation, addition, deletion, replacement, or
  a path swap fails closed with `path_changed`; a root deleted or replaced by a non-directory
  after preview uses that same conflict so the UI clears its stale preview. If the editable path
  changes while a preview request is pending, that request's eventual success or failure is
  ignored instead of overwriting the new path's state. A truncated preview is visibly
  non-confirmable and the API independently refuses it with `folder_limits_exceeded`. Accepted
  confirmation revalidates
  canonical root/file identity and reads one bounded association group at a time inside one
  atomic import transaction, so a large accepted folder is never retained as one giant
  buffer. If a planned entry disappears, becomes dangling, or changes type during that lazy
  read, the API returns `file_changed` so the UI discards its stale preview; genuine access
  failures remain separately reported as `file_unreadable`. ZIP groups preflight
  central-directory and local-header names, counts, and declared
  sizes without extraction and skip hidden/resource entries before inflation. Included entries
  are decoded with a maximum output length configured before inflation begins, so forged declared
  sizes cannot materialize output beyond the remaining per-entry or aggregate limit. Declared,
  local-header, and actual-size mismatches fail closed. A group over the resident-byte cap is
  reported and excluded in full rather than importing a partial ride. A symlinked directory
  is never followed, and a symlinked file is only followed when its target stays inside the
  walked tree. Anything a cap or symlink rule excludes is reported, and unsupported regular files
  — including symlink aliases to regular files — are listed as `unsupported_file_type` instead of
  being silently omitted. Symlink containment and target type are checked before extension
  classification, so an external alias remains `symlink_outside_tree`. The destination path is
  rejected when it resolves inside the repository checkout, reusing `guardAgainstCheckout`
  (the same guard `VELO_DATA_DIR` and database backups use). New endpoints:
  `POST /api/import/path/inventory` (preview) and `POST /api/import/path` (import), both
  loopback-only with the same CSRF header and hardened headers as every other mutating route.
  Folder drag-and-drop (`webkitGetAsEntry`) reads a dropped folder's files into the existing
  multi-file list, since browsers do not expose a dropped folder's real filesystem path to a
  page — only pasting the path does. The existing multi-file picker and loose-file
  drag-and-drop are unchanged (#51).
- **`pnpm app:dev`**: the foreground counterpart to `app:start` — builds the web client,
  runs the API in the foreground of the current terminal, opens the browser once it answers,
  and shuts down cleanly on Ctrl-C (SIGINT) or SIGTERM. Shutdown is redundant on purpose: the
  API process (`apps/api/src/main.ts`) now handles SIGINT/SIGTERM itself, closing the HTTP
  server and the database before exiting — this matters because a real terminal Ctrl-C
  delivers SIGINT to every process in the foreground group at once, not just the wrapper
  script, so the API must not depend solely on the wrapper forwarding it. The wrapper also
  forwards SIGTERM to the child and force-kills it after a grace period as a second layer.
  For the case neither of those can help — the wrapper is SIGKILLed, crashes, or a shell/shim
  around it swallows the signal instead of forwarding it — the API independently polls its
  spawning process's liveness and shuts itself down the moment it's gone, so a killed wrapper
  can never leave the port held. Verified directly: a real pty-delivered Ctrl-C, a `SIGTERM`
  to the wrapper, and a `SIGKILL` to the wrapper were each confirmed (via `lsof`) to leave the
  port free with no process alive. One command starts everything; killing it — by any of
  these means — tears everything down. The background commands
  (`app:start`/`app:stop`/`app:status`/`app:restart`) are unchanged and remain the right
  choice for a server that should outlive the current shell. Missing OS browser launchers
  are handled asynchronously before detaching, so a headless Linux `ENOENT` prints the
  loopback URL without crashing the wrapper or orphaning the API child (#51).
- **Local server lifecycle commands**: `pnpm app:start`, `app:stop`, `app:status`, and
  `app:restart`. `app:start` builds the web client, refuses to start when a server already
  holds the port, and waits for the API to actually answer before reporting success.
  `app:status` reports pid, port, data directory, ride count, and timezone, and is safe to
  run when nothing is up. Previously there was no supported way to tell whether a server was
  running or which data directory it served, and a stale API could end up serving a
  freshly-built web client whose endpoints it did not implement (#49).

### Fixed

- **The `webkitdirectory` folder picker could not be confirmed on macOS.** Removing its
  `accept` attribute (#49) was necessary but not sufficient — the OS picker still could not
  be confirmed from inside the target folder on macOS, reported as still unusable against a
  real export. The button is removed: `webkitdirectory` is non-standard, behaves differently
  per browser, and gave no way to preview what would be imported before committing to it.
  Folder import is now path-based (see above), which works the same way everywhere and
  previews first (#51).
- **"Choose export folder" could not select a folder.** The directory input carried
  `accept=".csv,.gpx,.zip"`; since a directory matches none of those extensions, the OS
  picker greyed folders out. Because Health Auto Export writes one CSV per metric, this
  forced users into hand-picking files and produced rides missing most of their data — one
  ride imported with only `energy`, another with only `distance` (#49).

## [0.1.0] - 2026-07-28

Initial MVP: import a Health Auto Export CSV/GPX/ZIP, compute deterministic ride and
conditioning metrics, browse rides and trends in a local web client, and generate AI
narratives once a real provider is implemented (today, AI is a stub — see below).

### Added

- **Privacy and Phase 0 foundation**: default-deny `.gitignore`, pre-commit and CI privacy
  scanner blocking real health data/GPS/credentials, synthetic fixture generator, monorepo
  scaffold (pnpm, TypeScript, ESLint, Prettier, Vitest), design system, and CI skeleton (#1).
- **Core data layer**: SQLite schema and ordered migrations, streaming CSV/GPX/ZIP
  importers, workout association by type + timestamp + sample tolerance, hash-based import
  idempotency, quarantine of unparseable files, and the `velograph-import` CLI (#3).
- **Deterministic analytics engine**: pure `@velograph/analytics` package with versioned
  formulas (`analytics-v1`), settings- and input-hashed snapshots, and golden tests
  guaranteeing byte-identical output for identical input (#8).
- **Loopback HTTP API**: workout list/detail, analytics, trends, import, and settings
  endpoints, binding `127.0.0.1` by default with hardened Origin/Host/CORS/CSP headers (#10).
- **Web client**: import UI, ride library and ride detail with synchronized charts,
  tile-free (offline) route rendering, and a trends dashboard, built on the cover-art visual
  identity (#17).
- **AI insight provider stub**: the `@velograph/insights` package ships the provider
  interface, a minimized/allow-listed payload builder, a versioned output schema, and
  evidence/numeric validation against deterministic facts. **No real provider is
  implemented** — `codex` and `ollama` are typed stubs that reject with
  `ProviderNotImplementedError` and perform no filesystem, process, or network I/O; only
  `disabled` (the default) actually runs, and it sends nothing anywhere (#30).
- **Guardrail hardening**: closed three Phase 0 bugs — privacy-scanner bypasses for binary
  metadata and GPX longitudes, unsafe recursive deletion in the fixture generator, and
  unpinned CI actions moved to pinned commit SHAs (#32).
- **Agent-worktree tooling fix**: git, Prettier, ESLint, and Vitest now ignore nested agent
  worktrees created under the checkout during multi-agent development (#36).
- **Ride delete and local data management**: delete a ride and its transactional cascade
  (metric samples, route, analytics snapshots, and any source file no longer referenced by
  another workout); backup and restore the whole database through SQLite's own online backup
  API (never a raw file copy of a live WAL database), with the destination/source path
  refused if it resolves inside a git checkout; and per-workout repair that re-derives the
  workout's span from its stored samples/route points and rebuilds any analytics snapshot
  left over from an older `FORMULA_VERSION`. Deleting a ride deliberately forgets its source
  file's content hash rather than tombstoning it, so re-importing the identical file
  afterwards imports cleanly instead of being silently skipped as a duplicate — see
  `docs/data-management.md` for the full reasoning and the rejected tombstone alternative
  (#38).
- **Release hygiene**: `CHANGELOG.md`, `docs/releasing.md`, and a CI job that requires PRs
  touching `packages/**`, `apps/**`, or `scripts/**` to also update this file (with a
  documented `Changelog-Exempt` escape hatch for non-behavioural changes) (#39).
- **Import and display timezone**: offset-less Health Auto Export wall times resolve in a
  configurable IANA timezone rather than being assumed UTC. DST is handled explicitly —
  ambiguous fall-back times resolve to the earlier occurrence and nonexistent
  spring-forward times fail closed rather than silently shifting. Explicit `Z` and numeric
  offsets remain authoritative. The zone is a validated app setting defaulting to the host
  zone, threaded through the importer, API, and CLI, with a Settings field and local-time
  rendering in the ride library and ride detail (#37).
- **Route map context**: start/finish markers, cumulative-distance labels, direction
  chevrons, and a geographic scale bar derived from the route projection, sampled only
  along recorded segments — still with no tiles, CDN assets, or geocoding (#37).
- **Import folder picker**: the import screen accepts a whole export folder and states
  explicitly that one CSV holds a single metric, so one file is not a complete ride (#37).

### Fixed

- **Offset-less metric timestamps no longer strand companion files.** Health Auto Export
  metric CSVs can carry local wall time while route CSV/GPX carry absolute UTC. Forcing the
  former to UTC pushed valid heart-rate, cadence, distance, and energy series outside the
  association tolerance, so a ride could render its route with most metrics missing even
  though the source files were present (#37).
- **Real Health Auto Export column names** are recognized — `cyclingdistancekm`,
  `cyclingcadencecount/min`, and the `count/min` heart-rate variants. Real exports using
  these headers previously matched no metric shape and produced no samples (#37).

- README quickstart no longer walks a reader into importing synthetic fixtures into their
  real `VELO_DATA_DIR`. The fixture-import step now sends data to an explicit throwaway
  directory (`VELO_DATA_DIR=$(mktemp -d)`) and starts the API against that same directory,
  with a warning that this matters because ride deletion was unimplemented until #38 — before
  that, the only way to undo an accidental import was deleting the whole database (#39).

[Unreleased]: https://github.com/jwtor7/velograph/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jwtor7/velograph/releases/tag/v0.1.0
