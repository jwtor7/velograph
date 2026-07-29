# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — see
[`docs/releasing.md`](docs/releasing.md) for what major/minor/patch mean while the project
is pre-1.0, and for the release procedure.

## [Unreleased]

### Added

- **Portable, self-verifying backups.** Every new SQLite backup carries a versioned manifest with
  the Velograph app version, current schema migration, included/excluded categories, and
  deterministic SHA-256 table checksums. Restore verifies the manifest, checksums, SQLite
  integrity, foreign keys, migration ordering, and migration content hashes before cutover, then
  returns a value-free integrity report. The filename-only v0.1.0 migration is adopted only while
  its bundled SQL matches the immutable published digest; all other missing checksums, duplicate
  sequence numbers, and altered applied migrations fail closed. The API and CLI require explicit
  replacement confirmation, while known older backups remain restorable through a reported
  compatibility migration (PRD §13).
- **Interactive offline route maps** replace the static route image with a keyboard-, pointer-,
  and touch-operable geographic viewport with fit, scale, markers, preserved gaps, and the
  synchronized chart cursor. An optional, validated raster MBTiles package can be loaded only
  from the local data environment and served through the loopback API; the useful route-only
  fallback makes no remote tile, font, geocoding, telemetry, or CDN request. MBTiles files remain
  ignored and are rejected by the repository privacy scanner (#56).
- **One-command development stack**: `pnpm dev` now starts the loopback API and Vite UI
  together, owns both foreground processes, and stops both on exit. The Vite proxy rewrites
  only its configured loopback Origin and Host for API requests, preserving the API's strict
  DNS-rebinding and cross-origin checks. CI now also proves the production web build (#25).
- **Local server lifecycle commands**: `pnpm app:start`, `app:stop`, `app:status`, and
  `app:restart`. `app:start` builds the web client, refuses to start when a server already
  holds the port, and waits for the API to actually answer before reporting success.
  `app:status` reports pid, port, data directory, ride count, and timezone, and is safe to
  run when nothing is up. Previously there was no supported way to tell whether a server was
  running or which data directory it served, and a stale API could end up serving a
  freshly-built web client whose endpoints it did not implement (#49).

### Fixed

- **Ride deletion now uses the configured timezone everywhere.** The visible ride date, delete
  button accessible name, and irreversible-action confirmation no longer disagree when the
  browser timezone differs from the Velograph display timezone.
- **Keyboard and low-vision access no longer stops at core ride controls.** Confirmation dialogs
  now place and trap focus, close on Escape only when safe, and restore focus to their trigger.
  Synchronized time-series cursors expose slider semantics plus fine, page, and boundary keyboard
  controls. Muted 11–12 px text now clears WCAG AA contrast on both card surfaces, and Settings
  save success is announced through its live status region. Backup and restore paths now have
  accessible labels, and their outcomes are announced as status updates. At phone widths, page
  actions move below the title, content padding stays usable, and lower-priority direction labels
  no longer obscure the route. Compact sidebar links also retain their accessible names when the
  visible labels collapse to icons (#56).
- **Strict, rollback-safe restore and graceful shutdown.** Restore now rejects corrupt input,
  forged or incomplete schemas, foreign-key violations, and unknown/future/out-of-order migration
  histories. It migrates a private staged copy and compares its complete schema against a freshly
  migrated canonical database before touching the live handle. Every backup, including replacement
  of an existing permissive destination, is now built and validated in a `0600` file inside a
  verified random mode-`0700` operation directory, fsynced, atomically installed, and followed by a
  parent-directory fsync; failures preserve the prior backup and clean incomplete stages. Restore
  stage and rollback snapshots use SQLite's backup API inside the same protected layout and are
  closed/fsynced before cutover. Recovery installs an independent copy of the original, retaining a
  separate canonical `0600` rollback snapshot whenever reopen cannot be proven. Backup rejects the
  live database and sidecars as destinations, serializes identical and case-only alias paths across
  API/CLI processes through rollback and cleanup using one private persistent lock in the shared
  canonical destination parent, independent of each process's `TMPDIR`. The hidden lock lives in a
  descriptor-verified owner-only directory; an independent contention probe proves SQLite locked
  the pinned inode. The lock stores no path or ride data, reserves its SQLite sidecar names, and
  remains after completion to avoid split-inode locking. Backup rejects a destination parent
  replaced during staging and retains an independent prior snapshot until rollback durability is
  proven. Restore binds and revalidates the canonical live parent and expected inode across
  asynchronous cutover/recovery boundaries; existing-file, canonical-identity reopen checks prevent
  a substituted or missing path from creating or adopting an empty database. API and CLI surfaces
  expose only stable value-free codes, including data-directory and live-database open/close
  failures. The API rejects concurrent work during the restore barrier, tracks
  asynchronous work after client disconnect, and fails closed only when recovery cannot be proven.
  SIGINT/SIGTERM drain accepted work and checkpoint/close the current handle. `app:stop` waits 12
  seconds for the verified process, safely escalates, and treats a final `SIGKILL` `ESRCH` race as a
  completed stop (#43, #55).
- **Analytics now load every route without inventing timestamps or cross-file intervals.**
  Associated route rows and their segments load in deterministic database order, missing point
  times remain explicit `null`, and timing-derived metrics never bridge an untimed point, segment,
  or route-file boundary while geometry and elevation remain usable (#20).
- **Analytics snapshots are immutable evidence for their provenance key.** Byte-identical replays
  are idempotent cache hits, while a differing result for the same formula, settings, and input
  hashes raises a value-free integrity error without changing the original result or creation
  timestamp (#21).
- **Analytics settings now fail closed before storage or computation.** One shared runtime parser
  rejects unknown keys, wrong types, non-finite or out-of-range thresholds, invalid timezones, and
  implausible, duplicate, or unordered heart-rate boundaries without partial writes. The Settings
  screen now treats five blank zones as an explicit disable action and announces partial or invalid
  drafts instead of silently converting them to `null` (#22).
- **Analytics v2 clips every metric to its real window and uses moving time for drift.** Heart-rate
  coverage and zone seconds cannot run past the workout or half boundary, and an even number of
  positive sample gaps now gives the final sample the true statistical median instead of the upper
  middle gap. Distance increments are interval-aligned across time windows; kilometre
  crossings are interpolated even when one row crosses several thresholds; elevation never jumps
  across route boundaries; and decoupling now requires independent HR, distance, and route
  coverage, using exact unrounded coverage for threshold decisions, with stable reasons for an
  unstable result. The immutable `analytics-v2` snapshot is computed beside any prior
  `analytics-v1` evidence rather than overwriting it (#18, #19, #29, analytics half of #53).
- **Trend charts preserve unavailable metrics instead of inventing zero observations.** Missing
  heart rate, speed, and efficiency values render as explicit dashed `n/a` markers with a
  privacy-safe coverage note, while a genuinely recorded zero remains a distinct solid bar (#27).
- **Ride repair reloads the complete canonical ride instead of only swapping analytics.** The
  detail screen now keeps its repair state active while it refetches workout bounds, metrics,
  route, analytics, and the ride library, then resets the synchronized cursor and previous-ride
  comparison against the repaired time domain (#46).
- **Large and partially timed routes render safely and stay synchronized.** Route bounds now use
  one bounded pass instead of spreading every coordinate into `Math.min`/`Math.max`, including
  the persisted route summary. Elevation keeps recorded segment gaps, uses the ride's full time
  domain, and excludes missing timestamps instead of substituting the Unix epoch (#28).
- **Backup destinations cannot bypass checkout protection through symlinks.** Destination
  validation now resolves the nearest existing ancestor, appends only validated missing path
  components, and re-checks the canonical destination after creating directories. Outside and
  nested symlink aliases into a checkout are rejected with privacy-safe errors that never echo
  local absolute paths (#44).
- **AI insight output now fails closed against its declared schema and cited evidence.**
  Runtime validation rejects unexpected root, section, and finding properties with value-free
  errors, and numeric claims can match only facts authorized by the finding's cited metric IDs.
  Explicit zone-share percentage representations remain supported without allowing unrelated
  metrics with colliding values to validate a claim (#34, #35).

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
