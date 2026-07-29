# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — see
[`docs/releasing.md`](docs/releasing.md) for what major/minor/patch mean while the project
is pre-1.0, and for the release procedure.

## [Unreleased]

### Added

- **Production API and CLI packages** now run from checked-in esbuild bundles instead of
  TypeScript source. The API package contains the complete offline web build, and both packages
  carry byte-identical migrations and dependency notices. The API uses the audited web packager
  for local builds and tarball prepack, so its embedded client retains exact file hashes,
  package-module evidence, and canonical notices; its only external runtime dependencies are
  pinned to the exact reviewed versions. Clean-install verifiers exercise
  import, repair, backup, restore, web assets, health/version reporting, migration adoption,
  signal shutdown, and value-free failures on Node 20 and 26. The local app supervisor now
  proves health, PID, and command identity before declaring readiness or signaling a process,
  rejects malformed host/port configuration before opening storage, cleans up its exact child
  on startup failure or timeout, and routes detached output through an owner-only sink that keeps
  only the current and one previous hard-capped generation while rejecting symlink, replacement,
  or non-regular log targets. API builds, prepack, and local lifecycle commands share one
  direct Node packaging orchestrator, so development tests preserve the canonical web notice and
  module evidence and no lifecycle build recursively resolves a package-manager shim (#11).
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
- **Loose-file imports now require an exact server review before confirmation.** Browser
  selections keep a unique identity for every `File`, including distinct files with the same
  name and size, then call `POST /api/import/inventory`. The review runs the confirmed import's
  real parser, content-hash duplicate check, and database-backed workout association rules inside
  a rollback-only transaction, and displays recognized, duplicate, ambiguous, invalid,
  unsupported, unmodelled-metric, and non-cycling outcomes without retaining preview writes.
  Confirmation is bound to that ordered selection. Browser encoding is sequential and the browser/API share practical
  file-count, per-file, decoded-total, and encoded-body limits; large exports are directed to
  path import. The API validates the complete exact-key schema and canonical base64 before
  decoding or writing, rejects mixed invalid requests atomically, returns stable value-free
  errors, and uses HTTP 413 for every limit breach. ZIPs selected through this route inherit the
  same expanded per-entry and aggregate byte ceilings as ordinary browser files, so compression
  cannot bypass the loose-upload memory contract (#23, #26).
- **Web imports are cancellable end to end.** File review/encoding, path preview, loose-file
  import, and path import expose explicit Cancel controls backed by request-scoped
  `AbortController`s. The API converts aborted/incomplete loopback requests and disconnected
  responses into the importer signal. The transactional importer checks that signal between
  bounded groups/files and before commit; an observed cancellation throws out the complete
  batch rather than preserving partial workouts.
- **Path-based folder import.** The web client can import a Health Auto Export folder by
  path instead of routing every file through the browser as base64: paste the folder path,
  preview the files it finds (grouped by ride — workout type + the filename's trailing
  timestamp — so companion metric files are obvious), and review every file through the same
  exact rollback-only parser, duplicate, and database-association preflight as loose uploads,
  then confirm. The API reads the folder directly from disk, recursing into subfolders,
  through incremental directory handles with explicit visited-entry, directory, depth,
  importable-file, and total-byte bounds; unsupported entries count toward traversal limits
  too. Each directory's canonical target and device/inode identity are captured before it is
  opened and revalidated after enumeration, so replacing a nested directory with a symlink
  during traversal fails the whole value-free plan with `path_changed` rather than returning
  entries from the replacement. Preview returns an opaque digest of the exact private manifest
  and never echoes the requested or canonical absolute root path.
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
  Folder drag-and-drop (`webkitGetAsEntry`) progressively uses a local desktop runtime's
  nonstandard absolute `File.path` only when every dropped file maps to one root through an exact,
  independently built relative suffix. A verified root populates the path field and immediately
  starts the same disk-backed preview; standard browsers, absent paths, and inconsistent roots
  visibly fall back to the bounded loose-file list. Virtual `entry.fullPath` values are never
  trusted as filesystem paths. CLI directory imports now use the same bounded recursive planner
  and lazy, identity-revalidated readers; symbolic input paths fail closed, direct files have
  descriptor/identity and size checks, and quarantine summaries expose codes and counts without
  source filenames (#51).
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
  spawning process's liveness and shuts itself down when it's gone. Automated lifecycle and
  parent-death regressions cover signal forwarding, bounded escalation, child cleanup, and
  listener release without claiming an unretained manual PTY result. The background commands
  (`app:start`/`app:stop`/`app:status`/`app:restart`) are unchanged and remain the right
  choice for a server that should outlive the current shell (#51).
- **Release governance and portable container delivery**: a loopback-only
  Docker/Compose deployment with a local Docker-managed data volume, read-only
  runtime filesystem, dropped capabilities, bounded temporary storage, and no
  source-export or credential mounts. CI now verifies clean frozen-lockfile
  installs on Node 20.19 and Node 26, audits worktree/Git-history/container
  application payloads for privacy leaks, and performs a non-publishing
  `amd64`/`arm64` Buildx build with per-platform SBOM and provenance
  attestations. The fail-closed audit verifies and scans the exact OCI output;
  CI retains it with its archive checksum and image-index digests. Container
  installs can run outside Git, while the runtime includes only the built web
  client and API production deployment. Security reporting, contribution
  rules, threat model, privacy incident response, and release audit procedures
  are documented. A fail-closed runtime licence gate now verifies exact
  web/API/CLI dependency closures, installed SPDX metadata and authoritative
  texts, Vite and embedded SQLite evidence, all emitted browser file hashes
  and package provenance, canonical notices in browser/API artifacts, final
  web-artifact lineage, and native Node/`tini` notice placement for every
  container platform. The container supervises both the API and ingress proxy, probes health
  through published ingress, allows 25 seconds for coordinated shutdown, and is smoke-tested
  in CI with an empty synthetic data mount. The image relay defaults to container loopback; the
  supported Compose and CI paths explicitly enable container-network ingress only alongside a
  loopback-only host publication. The packaged API web tree is the sole runtime copy;
  selecting a project licence for Velograph remains an explicit maintainer decision.
- **Local server lifecycle commands**: `pnpm app:start`, `app:stop`, `app:status`, and
  `app:restart`. `app:start` builds the web client, refuses to start when a server already
  holds the port, and waits for the API to actually answer before reporting success.
  `app:status` reports pid, port, data directory, ride count, and timezone, and is safe to
  run when nothing is up. Previously there was no supported way to tell whether a server was
  running or which data directory it served, and a stale API could end up serving a
  freshly-built web client whose endpoints it did not implement (#49).

### Fixed

- **Release verification is stable under real CI timing and native BuildKit layers.** The
  development-proxy regression waits for the production build it launches instead of assuming a
  four-second startup, while the release privacy audit accepts only the exact safe tar root marker
  emitted by BuildKit and continues to reject traversal and absolute archive paths (#11).
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
  visible labels collapse to icons. The Import drop surface is now a labelled, non-interactive
  group; the native file chooser button alone owns activation and therefore retains browser-native
  Space and Enter semantics. The ride library keeps its complete metric table in a labelled,
  keyboard-focusable local scroller instead of overflowing and crushing columns. The fixed app
  shell now keeps vertical scrolling inside the main pane instead of showing a second document
  scrollbar on compact screens (#56).
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
  Explicit textual units must also match the cited fact's canonical unit, so equal values from
  seconds, heart rate, distance, or another dimension cannot validate each other.
  Explicit zone-share percentage representations remain supported without allowing unrelated
  metrics with colliding values to validate a claim (#34, #35).
- **Privacy gate failures no longer republish sensitive filenames.** Worktree, staged, and
  all-ref history reports and the generated-runtime verifier now use per-run salted opaque file
  handles while retaining the value-free rule and line needed for local investigation. The
  handles remain consistent only within one report and cannot be correlated or
  dictionary-guessed across public CI runs. Web licence-evidence mismatches omit output paths,
  and CLI quarantine output likewise emits only a stable code and count.

- **CSV inputs are bounded, kind-checked, converted, and versioned.** `hae-csv-v4` requires the
  filename metric label to agree with the recognized metric or route headers before any row is
  normalized. It limits raw input to 32 MiB, 500,000 samples, 64 columns, and 64 KiB per field;
  parsing no longer retains a second `string[][]` copy. API parsing, bounded timestamp sorting,
  route segmentation, bounds calculation, and SQLite inserts yield at cooperative checkpoints,
  and cancellation still rolls the complete transaction back. It converts distance `km`/`m`,
  energy `kJ`/`J`/`kcal`, route altitude/accuracy `m`/`ft`, and route speed `m/s`/`km/h` to
  canonical SI before persistence. Route course accepts `deg`. Generic or unsupported
  distance, energy, altitude, speed, accuracy, or course headers now quarantine with
  `unit_unsupported`; filename/header disagreement uses `metric_kind_mismatch`, and a breached
  CSV bound uses `csv_limits_exceeded`. None of these cases can silently reinterpret values
  (IMP-004).
- **Out-of-scope Health Auto Export files are normal aggregate skips.** Unmodelled cycling
  metrics and non-cycling workouts increment value-free skip codes without storing hashes,
  filenames, warnings, or quarantine rows, so a future adapter can import those same bytes.
  Malformed in-scope files still quarantine. GPX inventory and parsing now require the same
  canonical `Indoor|Outdoor Cycling-Route-YYYYMMDD_HHMMSS.gpx` form; noncanonical names and GPX
  files labelled as other cycling metrics fail closed instead of being previewed as importable.
  A Running or other non-cycling route can never default to outdoor cycling (#53).
- **The `webkitdirectory` folder picker could not be confirmed on macOS.** Removing its
  `accept` attribute (#49) was necessary but not sufficient — the OS picker still could not
  be confirmed from inside the target folder on macOS, reported as still unusable against a
  real export. The button is removed: `webkitdirectory` is non-standard, behaves differently
  per browser, and gave no way to preview what would be imported before committing to it.
  Folder import is now path-based (see above), which works the same way everywhere and
  previews first (#51).
- **Deleting a ride now forgets every exclusively owned route hash.** Source
  ownership is preserved independently from active geometry, so a route CSV
  remains attached after GPX supersedes it and fallback-only route files remain
  attributable. Deleting the workout removes those exclusive hashes while
  retaining sources shared with another workout; a migration forgets legacy
  successful hashes whose ownership could no longer be recovered safely (#45).
- **Workout association now fails closed on contradictory evidence.** Filename
  timestamps corroborate workout type and internal sample ranges rather than
  being ignored; conflicting inputs use `association_conflict`, and multiple
  viable workouts use `association_ambiguous` instead of silently choosing the
  earliest candidate (#12).
- **Import validation no longer fabricates zeroes or normalized dates.** Blank,
  malformed, non-finite, and out-of-range required numeric fields quarantine
  the source file with `numeric_value_invalid`; impossible calendar dates,
  times, offsets, and present-but-malformed GPX timestamps use
  `timestamps_invalid`. Optional GPX times remain explicitly null (#13).
- **Malformed outer ZIPs no longer abort valid sibling imports.** Each failed
  archive receives its own durable, value-free quarantine record while valid
  selected files continue in the same committed batch. ZIP central-directory
  metadata is preflighted before inflation, output is hard-capped and checked
  against declared sizes and CRCs, hidden entries are skipped before inflation,
  and all selected archives share one decoded-byte budget (#14).
- **GPX XML is parsed without structural recovery.** Exact qualified opening
  and closing names must match, namespace prefixes must be declared, and
  closing-tag attributes, multiple roots, unknown entities, trailing content,
  mismatched, misnested, prematurely closed, and unclosed structures fail with
  the privacy-safe `malformed_xml` code (#15).
- **Parser upgrades now replace prior normalized output transactionally.**
  Matching content hashes are skipped only when the stored parser version is
  current; otherwise a complete replacement parse and unique ownership check
  must succeed before old parser-owned rows are detached. Successful upgrades
  reuse the existing source and stable workout IDs, preserving notes/tags;
  failed or ambiguously owned upgrades retain all last-known-good data and add a
  value-free failure record instead (#12).
- **Large and partially timed GPX routes stay bounded and truthful.** Route
  time ranges and geographic bounds are reduced in one pass rather than spread
  into function arguments, untimed points remain nullable through database,
  analytics, API, and web types, namespace scopes no longer clone inherited
  maps, raw bytes are capped before UTF-8 decoding, the total-attribute budget
  accommodates the documented point limit, invalid UTF-8 is rejected, and XML
  declarations must describe XML 1.0 UTF-8 input (#13, #15).
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
