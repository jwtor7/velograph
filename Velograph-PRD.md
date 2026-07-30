# Velograph Product Requirements Document

**Status:** Draft for implementation  
**Version:** 0.1  
**Created:** 2026-07-28 EDT  
**Product type:** Open-source, local-first web application  
**Working description:** Turn Apple Health cycling data into clear visuals and AI-powered insights that help riders understand every ride.

## 1. Executive summary

Velograph is a privacy-first web application for importing cycling data exported from Apple Health through Health Auto Export, storing it in a local database, calculating deterministic ride and conditioning metrics, reconstructing recorded routes from GPX data, and presenting interactive visualizations.

An optional AI layer converts the app's calculated metrics into plain-language ride audits, comparisons, fatigue signals, and training guidance. The primary AI provider is a locally installed Codex CLI authenticated by the user, including supported ChatGPT subscription sign-in. Ollama is the secondary local provider. AI is optional: importing, calculating, comparing, mapping, and charting must work without an internet connection or an LLM.

Velograph is open source. The public repository, build artifacts, tests, documentation, issues, pull requests, and CI logs must never contain a maintainer's real health records, locations, route traces, identifiers, credentials, or other personal data.

## 2. Product principles

1. **Local first:** Raw and normalized health data lives in a user-controlled local data directory and local SQLite database.
2. **Deterministic core:** The same inputs, settings, timezone data, and analytics-engine version produce the same metrics and chart specifications.
3. **AI explains; it does not calculate:** All numeric claims originate in the deterministic analytics engine. The LLM writes narrative from a constrained metrics payload.
4. **Useful without AI:** The complete core experience works with AI disabled and the network unavailable.
5. **Private by default:** No telemetry, remote fonts, CDNs, map tiles, geocoding, or background network calls are enabled by default.
6. **Evidence before advice:** Every generated insight must be traceable to one or more calculated facts. Missing context is labelled unavailable.
7. **Portable by design:** A user can run Velograph from source or a container and move or restore it using a documented data-directory backup.
8. **Open-source-safe development:** Only synthetic fixtures may enter the repository.

## 3. Source compatibility and constraints

Health Auto Export supports Apple Health and workout exports in CSV, JSON, and GPX, as well as several automated destinations. Velograph v1 will target folder, multi-file, and ZIP imports of CSV and GPX exports. A later release may add watched-folder and authenticated REST ingestion. See [HealthyApps](https://www.healthyapps.dev/) and the [Health Auto Export documentation repository](https://github.com/Lybron/health-auto-export).

The private reference corpus was inspected only to determine file and header shapes. No real paths, filenames, timestamps, measurements, source/device values, coordinates, counts, or route data from that corpus may be copied into this document or the future repository.

Observed input families that v1 must support:

| Input family | Required fields or shape |
|---|---|
| Heart rate and heart-rate recovery CSV | Date/time; minimum, maximum, and average beats per minute; context; source |
| Cycling cadence CSV | Date/time; cadence; source |
| Cycling distance CSV | Date/time; distance with explicit `km` or `m` header; source |
| Active and resting energy CSV | Date/time; energy with explicit `kJ`, `J`, or `kcal` header; source |
| Route CSV | Timestamp; latitude; longitude; altitude/accuracy in `m` or `ft`; speed in `m/s` or `km/h`; course in `deg` |
| GPX route | Track, segment, track point, time, elevation, and optional speed/course/accuracy extensions |
| Optional supporting metrics | Steps, walking/running distance, flights climbed, and future Health Auto Export metrics |

Sanitized filename examples:

```text
Outdoor Cycling-Heart Rate-YYYYMMDD_HHMMSS.csv
Outdoor Cycling-Cycling Distance-YYYYMMDD_HHMMSS.csv
Outdoor Cycling-Route-YYYYMMDD_HHMMSS.csv
Outdoor Cycling-Route-YYYYMMDD_HHMMSS.gpx
```

The importer must not assume that all files exist, that all sources use identical sampling intervals, or that every future Health Auto Export release preserves the same header spelling.

## 4. Problem statement

Apple Health contains useful cycling measurements but does not provide a portable, inspectable analysis workflow tailored to a rider's longitudinal conditioning. Raw exports are fragmented across files, routes and metrics need to be associated with the correct workout, and manual analysis is slow and inconsistent. General-purpose AI can produce useful prose, but it can also calculate incorrectly, infer context that was never supplied, expose sensitive data, or make core functionality dependent on a remote service.

Velograph solves this by separating ingestion, storage, deterministic analytics, visual presentation, and optional narrative generation.

## 5. Goals and non-goals

### 5.1 v1 goals

- Import a Health Auto Export folder, selected files, or ZIP containing cycling CSV and GPX files.
- Associate metric files and routes with the correct workout without relying on filename matching alone.
- Store source metadata, normalized samples, routes, settings, calculated metrics, and generated insights in SQLite.
- Provide a ride library, ride-detail dashboard, comparisons, and longitudinal conditioning dashboard.
- Reconstruct and display recorded GPX routes without an internet connection.
- Calculate ride summaries, heart-rate zones, pacing, efficiency, drift/decoupling proxies, cadence, elevation, recovery, and data-quality indicators deterministically.
- Generate an evidence-linked ride audit in a consistent structure through Codex or Ollama.
- Run locally from source and through a documented container deployment.
- Provide backup, restore, re-index, and full local deletion workflows.
- Enforce open-source privacy controls in local hooks and CI.

### 5.2 Non-goals for v1

- Medical diagnosis, treatment, emergency guidance, or clinical decision support.
- Real-time ride tracking or turn-by-turn navigation.
- Social feeds, leaderboards, public profiles, or cloud accounts.
- Automatic road snapping, reverse geocoding, or online map tiles.
- Training-plan automation that changes a user's schedule without confirmation.
- Direct Apple HealthKit access.
- Multi-user hosting or internet-facing deployment.
- Perfect attribution of fatigue to sleep, stress, nutrition, illness, or training unless those inputs are explicitly present.
- LLM-generated metrics, charts, route geometry, chart configurations, or data corrections.

## 6. Users and jobs to be done

### 6.1 Primary user

A privacy-conscious cyclist who records rides with Apple Health, exports them through Health Auto Export, and wants understandable performance and conditioning trends without uploading their entire health history to a hosted analytics service.

### 6.2 Core jobs

- “Import my latest exports and see what changed.”
- “Understand how I executed this ride.”
- “Compare this ride with a prior ride or my recent baseline.”
- “See whether my heart rate rose while my pace stayed similar.”
- “Review my route, elevation, speed, heart rate, and cadence together.”
- “Get a written audit without trusting an LLM to calculate the numbers.”
- “Keep my data local, portable, and out of the public repository.”

## 7. Core user journeys

### 7.1 First run

1. The user starts Velograph locally.
2. Velograph creates or connects to a data directory outside the source checkout.
3. The user reviews privacy defaults and chooses a display timezone and unit system.
4. The user configures heart-rate zones manually or selects “not configured.”
5. AI remains disabled until the user configures and tests a provider.

### 7.2 Import rides

1. The user drags in a folder/ZIP, selects multiple files, or uses the local CLI importer.
2. Velograph evaluates each file without changing the source or database, using the same parser,
   content-hash duplicate check, and database-backed association rules as confirmed import.
3. It shows exact recognized, duplicate, ambiguous, invalid, unsupported, unmodelled-metric, and
   non-cycling outcomes.
4. The user confirms the import.
5. Velograph hashes and parses the files, associates them with workouts, validates data, writes one transaction, and calculates analytics.
6. The result summarizes imported, updated, skipped, and quarantined records without exposing sensitive values in logs.

### 7.3 Review a ride

1. The user opens a ride from the library.
2. The summary and charts render immediately from local data.
3. The user inspects synchronized heart rate, speed, cadence, elevation, zones, splits, and route.
4. Data-quality badges explain missing samples or calculation limitations.
5. If desired, the user selects “Generate insight,” reviews the outbound payload, and chooses Codex or Ollama.

### 7.4 Compare rides

1. The user selects two rides or a ride plus a rolling baseline.
2. Velograph shows aligned metrics, distributions, trends, and percentage changes.
3. Only comparable metrics are shown; unavailable or low-quality comparisons are labelled.
4. An optional AI comparison uses the already calculated comparison payload.

### 7.5 Back up or move Velograph

1. The user stops writes or uses the built-in backup action.
2. Velograph creates a local backup containing the database, migrations manifest, and optional source-file archive.
3. The backup excludes credentials and Codex authentication.
4. The user restores it into another compatible Velograph installation and receives an integrity report.

## 8. Functional requirements

Priority labels: **P0** is required for the first usable release; **P1** is required for v1; **P2** is a planned follow-up.

### 8.1 Import and data management

| ID | Priority | Requirement |
|---|---:|---|
| IMP-001 | P0 | Import selected CSV/GPX files, a folder selection, or a ZIP through the web UI. Before confirmation, both selected-file and folder-path flows must run the confirmed import's parser, duplicate check, and database association rules in a bounded, cancellable, rollback-only preflight and show exact per-file outcomes. |
| IMP-002 | P0 | Provide a CLI import command for direct local paths and automation. |
| IMP-003 | P0 | Compute SHA-256 per source file and make repeat imports idempotent. |
| IMP-004 | P0 | Parse supported headers through versioned adapters with normalized canonical field names and units. |
| IMP-005 | P0 | Associate files using workout type, filename timestamp, internal sample times, and tolerance checks. Never rely on filename alone. |
| IMP-006 | P0 | Prefer GPX for route geometry, use route CSV as a fallback, and preserve provenance. |
| IMP-007 | P0 | Commit each confirmed import atomically; a parser failure must not leave a partially imported workout. |
| IMP-008 | P0 | Quarantine malformed or unsupported in-scope files with a safe, actionable error that contains no sample values. Treat well-formed unmodelled cycling metrics and non-cycling workouts as aggregate normal skips without persisting their hashes or filenames. |
| IMP-009 | P0 | Preserve raw files only when the user enables “retain source files.” Default: store hashes, metadata, and normalized data, not duplicate raw files. |
| IMP-010 | P1 | Let users reprocess existing imports after a parser or analytics-engine upgrade. |
| IMP-011 | P1 | Support export and deletion of one ride, one import batch, or all local data. |
| IMP-012 | P2 | Watch a user-selected export directory and import stable, completed files automatically. |
| IMP-013 | P2 | Accept authenticated Health Auto Export REST pushes through an opt-in LAN endpoint. |

### 8.2 Ride library and detail

| ID | Priority | Requirement |
|---|---:|---|
| RIDE-001 | P0 | List rides by local date with duration, distance, average speed, average heart rate, and data-quality state. |
| RIDE-002 | P0 | Search and filter by date range, duration, distance, heart-rate zone, route availability, and tags. |
| RIDE-003 | P0 | Display summary metrics and deterministic charts for one ride. |
| RIDE-004 | P0 | Synchronize the chart cursor across heart rate, speed, cadence, elevation, and route position where timestamps permit. |
| RIDE-005 | P1 | Add private local notes and tags that are never included in AI payloads unless explicitly selected. |
| RIDE-006 | P1 | Show calculation definitions, algorithm version, units, source coverage, and reasons a metric is unavailable. |

### 8.3 Deterministic analytics

| ID | Priority | Requirement |
|---|---:|---|
| ANA-001 | P0 | Calculate duration, moving time, distance, average/max speed, average/max heart rate, energy, cadence, elevation gain/loss, and coverage. |
| ANA-002 | P0 | Calculate time in manually configured heart-rate zones using interval-weighted samples, not row counts. |
| ANA-003 | P0 | Calculate speed-to-heart-rate efficiency when both inputs meet coverage thresholds. |
| ANA-004 | P1 | Calculate first-half versus second-half efficiency change as a speed/heart-rate decoupling proxy, clearly labelled as terrain- and wind-sensitive. |
| ANA-005 | P1 | Calculate pacing variability and fixed time/distance splits. |
| ANA-006 | P1 | Use exported heart-rate recovery records when present and display their context and coverage. |
| ANA-007 | P1 | Build rolling 7-, 28-, and 90-day volume, intensity-distribution, efficiency, cadence, and recovery trends. |
| ANA-008 | P1 | Compare a ride with a user-selected ride, the immediately previous ride, and a recent rolling median. |
| ANA-009 | P1 | Version every formula and persist source hashes, settings, and engine version with each analytics snapshot. |
| ANA-010 | P1 | Recalculate from normalized source data when thresholds, timezone, units, or algorithm versions change. |

Analytics definitions:

- **Efficiency:** average speed in km/h divided by average heart rate in bpm. This is a descriptive ratio, not a clinical measure.
- **Efficiency-change proxy:** calculate efficiency separately for the first and second comparable halves; report the relative decline from first-half efficiency. Pauses and invalid samples are excluded by documented rules.
- **Heart-rate zones:** user-supplied boundaries are authoritative. Velograph must not silently infer zones from age.
- **Coverage:** valid time represented by a metric divided by eligible ride time.
- **Elevation gain:** sum positive changes after a documented, versioned noise filter.
- **Moving time:** duration of valid route segments whose derived or recorded speed exceeds the configured threshold.

All thresholds, resampling rules, outlier rules, and formulas must be documented, unit-tested, and versioned.

### 8.4 Route reconstruction

| ID | Priority | Requirement |
|---|---:|---|
| ROUTE-001 | P0 | Parse GPX tracks, segments, points, timestamps, elevation, and supported speed/course/accuracy extensions. |
| ROUTE-002 | P0 | Render the recorded route shape entirely from local assets and data, without online map requests. |
| ROUTE-003 | P0 | Display start, finish, direction, distance markers, elevation profile, and cursor position. |
| ROUTE-004 | P0 | Preserve segment gaps instead of drawing false straight lines across missing data. |
| ROUTE-005 | P0 | Reject external XML entities and enforce file, point-count, coordinate, timestamp, and nesting limits. |
| ROUTE-006 | P1 | Use route CSV when GPX is absent or invalid and report the fallback. |
| ROUTE-007 | P1 | Offer an optional locally supplied offline basemap package; route viewing must remain useful without it. |
| ROUTE-008 | P1 | Redact a configurable radius around route starts and finishes in shared exports, enabled by default. |

v1 reconstructs the recorded track; it does not snap points to roads or infer an unrecorded path. The default renderer is a tile-free route canvas/SVG over a neutral grid. Any optional basemap must be installed locally and must not cause a remote request.

### 8.5 AI-generated insights

| ID | Priority | Requirement |
|---|---:|---|
| AI-001 | P0 | AI is disabled by default and is never required to import, calculate, compare, or visualize data. |
| AI-002 | P0 | Provide a provider interface with `codex`, `ollama`, and `disabled` implementations. |
| AI-003 | P0 | Send only a versioned, minimized JSON analysis payload; do not send source files, raw time-series rows, route coordinates, exact route names, source/device strings, or local notes by default. |
| AI-004 | P0 | Show a human-readable payload preview and remote/local destination before every first provider use and whenever the privacy policy changes. |
| AI-005 | P0 | Require structured output matching a versioned JSON Schema. |
| AI-006 | P0 | Validate every numeric statement against supplied facts or remove/flag it before display. |
| AI-007 | P0 | Require evidence references from each finding to deterministic metric IDs. |
| AI-008 | P0 | Mark sleep, stress, nutrition, weather, soreness, goals, and recovery context “not available” unless explicitly imported or entered and included. |
| AI-009 | P0 | Store provider, model-reported identifier when available, prompt version, input hash, output, validation status, and creation time locally. Never store provider credentials. |
| AI-010 | P1 | Let users regenerate, compare providers, delete a run, and view the exact sanitized payload and prompt version used. |
| AI-011 | P1 | Refuse medical diagnosis and present training guidance as informational, not clinical advice. |
| AI-012 | P1 | Allow fully local narrative generation with Ollama through a loopback-only endpoint. |

The default insight structure mirrors the useful organization of the supplied example while tightening evidence requirements:

1. Ride execution
2. Heart-rate dynamics and recovery
3. Comparative conditioning signal
4. Strengths
5. Fatigue indicators
6. Training considerations
7. Data limitations
8. Bottom line

#### Codex provider

Codex supports ChatGPT subscription sign-in for local CLI use, and `codex exec` supports non-interactive execution, ephemeral sessions, JSONL events, and JSON Schema-constrained final output. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth) and [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

Velograph will:

- Detect a host-installed `codex` executable and show authentication status without reading or copying its token cache.
- Ask the user to complete `codex login` outside Velograph if required.
- Invoke `codex exec` as a child process with an argument array, never a constructed shell command.
- Run it in an isolated empty temporary working directory, an ephemeral session, and a read-only sandbox; use the documented non-repository override for that dedicated directory.
- Disable unrelated project instructions, rules, tools, and web search for the analysis run where supported.
- Pass the prompt/payload through stdin and require the Velograph insight output schema.
- Set a timeout, cap captured output, support cancellation, and treat non-zero exit, schema failure, or provider throttling as a recoverable error.
- Never mount, copy, bundle, log, or commit the Codex authentication cache.

For container deployment, a small optional host-side Velograph AI Bridge will invoke the host CLI over an authenticated loopback or Unix-socket connection. This avoids mounting the user's Codex credential store into the application container. The bridge is optional and independently installable.

#### Ollama provider

Velograph will connect only to a user-configured loopback Ollama endpoint by default. The user selects an installed model. The same minimized payload, structured schema, evidence validation, timeout, and audit metadata apply. Model availability is checked at runtime; no model is downloaded automatically.

## 9. Visualization requirements

### 9.1 Ride-detail visuals

- Synchronized heart rate, speed, cadence, and elevation time series
- Heart-rate zone distribution
- Distance/time splits
- Route trace with position cursor
- Elevation profile
- Speed and heart-rate relationship scatterplot
- First-half versus second-half efficiency comparison
- Data-coverage timeline

### 9.2 Longitudinal visuals

- Weekly/monthly distance, duration, and ride count
- Zone distribution over time
- Average heart rate and speed trends
- Efficiency trend with confidence/data-quality indicators
- Cadence distribution and trend
- Recovery metric trend where available
- Comparison table for selected rides

### 9.3 Determinism contract

- Chart data comes only from versioned analytics queries.
- Chart specifications are generated by pure, tested functions.
- Dependencies, timezone data, fonts, icons, and styles are bundled and version-pinned.
- No CDN, remote tile, geocoding, remote font, or LLM call may occur during rendering.
- Sorting and tie-breaking rules are explicit.
- Units, rounding, interpolation, missing-value handling, downsampling, and axis domains are deterministic.
- Exported SVG/PNG files contain no hidden source paths, device strings, coordinates beyond what the selected visual visibly requires, or nondeterministic generation timestamps.
- CI includes offline browser tests, chart-spec snapshots, and representative pixel/SVG regression tests.

## 10. Data model

SQLite is the v1 database. Foreign keys are enabled and schema changes use ordered migrations.

| Table | Purpose |
|---|---|
| `import_batches` | One import transaction, status, counts, timestamps, and importer version |
| `source_files` | Hash, sanitized original name, detected type, parser version, retention state, and error code |
| `workout_source_files` | Durable workout ownership for every successfully associated source, including superseded or fallback-only route files |
| `workouts` | Stable workout ID, type, start/end, timezone, duration, provenance, and quality state |
| `metric_series` | Metric type, canonical unit, source, start/end, sample count, and coverage |
| `metric_samples` | Series ID, timestamp, normalized numeric fields, context, and validity flags |
| `routes` | Workout relationship, source format, bounds, point count, distance, and quality state |
| `route_points` | Segment, sequence, timestamp, coordinates, elevation, speed, course, and accuracy |
| `analytics_snapshots` | Workout/baseline relationship, formula version, settings hash, input hash, and result JSON |
| `insight_runs` | Provider, prompt/schema version, sanitized input hash/payload, validated output, and status |
| `user_settings` | Units, timezone, zone boundaries, privacy controls, provider configuration, and feature flags |
| `notes_tags` | Local notes and tags with explicit AI-inclusion state |

Raw imports are immutable when retained. Normalized rows and analytics snapshots are reproducible from their source hash plus parser, settings, and formula versions.

## 11. Recommended system architecture

### 11.1 Components

```text
Browser UI
    |
Local HTTP API (loopback by default)
    |
    +-- Import adapters (CSV/GPX/ZIP)
    +-- Normalization and association engine
    +-- Deterministic analytics engine
    +-- Route and chart specification engine
    +-- SQLite repository
    +-- Insight orchestrator
            +-- Optional host Codex bridge -> Codex CLI -> OpenAI
            +-- Optional Ollama adapter -> local Ollama
```

### 11.2 Implementation recommendation

- TypeScript monorepo with shared canonical types and validation schemas
- React-based client with locally bundled visualization libraries
- Node.js local API service
- SQLite with a migration-capable typed query layer
- Streaming CSV parser and secure, namespace-tolerant GPX parser
- Pure analytics package with no framework, database, network, or LLM dependency
- Docker image and Compose file with a named/configurable data volume
- Native `pnpm` development and production commands

The architecture is a recommendation, not permission to weaken the requirements. A different stack must preserve the same local-first, deterministic, portable, and privacy boundaries.

### 11.3 Runtime boundaries

- Default bind address: `127.0.0.1`.
- Non-loopback binding is an advanced setting and must require authentication before release.
- Default `VELO_DATA_DIR` is an OS-appropriate application-data directory outside the repository.
- Containers mount only the configured Velograph data directory.
- Source-export directories are read-only inputs and are never mounted into CI.
- The core app makes zero outbound requests in offline mode.

## 12. Privacy and security requirements

### 12.1 Data classification

| Class | Examples | Policy |
|---|---|---|
| Restricted health/location data | Raw exports, heart-rate samples, routes, notes, exact timestamps | Local data directory only; never committed; remote AI only after minimization and consent |
| Secrets | Codex auth cache, API keys, bridge token | OS credential store or process memory; never SQLite, logs, fixtures, or repository |
| Derived private data | Ride metrics, trends, insight text | Local by default; explicit export only |
| Public-safe data | Source code, schemas, synthetic fixtures, documentation | Repository allowed after privacy tests |

### 12.2 Repository leak prevention

The repository must include:

- A default-deny `.gitignore` for application data directories, SQLite files and journals, CSV, GPX, Health Auto Export archives, backups, logs, generated reports, and common credential files.
- A `fixtures/synthetic/` allowlist for intentionally generated CSV/GPX test data.
- Synthetic fixture generation that uses invented values, dates, names, source strings, and route coordinates that do not trace a real person's route or home.
- A pre-commit privacy scanner and the same blocking CI job.
- Secret scanning plus custom checks for GPS coordinates, Health Auto Export filename patterns with real timestamps, Apple Health source/device strings, SQLite files, archives, and oversized data files.
- A PR checkbox: “This change contains no real health, location, account, credential, or user data.”
- A documented incident process to rotate secrets, purge Git history, invalidate releases, and notify maintainers if a leak is detected.

Git history is not an acceptable deletion mechanism. Sensitive data found after commit must be treated as exposed.

### 12.3 Application privacy

- No telemetry, crash upload, advertising, or product analytics by default.
- No remote resources in the browser bundle.
- Logs use stable IDs and error codes, not metric values, coordinates, raw filenames, prompts, or insight payloads.
- UI exports default to removing source/device metadata and redacting route starts/finishes.
- AI payloads exclude raw coordinates and exact timestamps by default.
- Provider setup explains that Codex is remote inference while Ollama can remain local.
- A one-click network-off mode disables all AI providers and any future update checks.
- The local API enforces strict Origin, Host, CORS, and CSRF controls even when bound only to loopback.
- Content Security Policy defaults to self and loopback resources only.
- ZIP extraction prevents path traversal, symlink escapes, decompression bombs, and unsupported nested archives.
- GPX parsing disables external entities and applies resource limits.
- Imported values and filenames are always data, never executable shell fragments, templates, or dynamic code.
- v1 documentation must state whether the selected SQLite build provides application-level encryption. If it does not, users are told to use full-disk encryption and the limitation is not obscured by “local-first” language.
- The app must pass a privacy threat-model review before its first public release.

## 13. Portability, backup, and recovery

- Supported v1 deployment: Docker/Compose on macOS and Linux, plus source-based local execution.
- Container images target `amd64` and `arm64`.
- All persistent state lives under one documented data directory.
- No absolute source-checkout paths are stored in portable records.
- Backup uses SQLite's safe backup mechanism rather than copying a live WAL database.
- A backup manifest records schema version, app version, checksums, and included categories.
- Restore verifies checksums, runs compatible migrations, and never overwrites an existing data directory without explicit confirmation.
- A repair command verifies foreign keys, source hashes, orphaned records, analytics versions, and route ordering.
- Credentials, Codex auth, Ollama models, and temporary files are never included in a Velograph backup.

## 14. Non-functional requirements

| Area | Requirement |
|---|---|
| Offline behavior | Import, browse, calculate, compare, map, chart, export, back up, and restore with external networking blocked |
| Performance | Import a synthetic 100-workout corpus with one million metric/route samples in under 3 minutes on a documented reference laptop |
| UI responsiveness | Open an already imported ride in under 1 second at p95 on the reference corpus; long web imports expose cancellation and propagate abort/disconnect signals into the atomic importer |
| Reliability | Re-importing identical files creates no duplicate workouts or samples |
| Reproducibility | Recalculation with identical input/settings/versions produces byte-equivalent analytics JSON |
| Accessibility | Keyboard navigation, visible focus, semantic labels, colour-independent status cues, and WCAG 2.2 AA contrast |
| Localization | Store canonical SI units and instants; render user-selected units and timezone without changing source truth |
| Browser support | Current stable Chromium, Firefox, and Safari for local use |
| Observability | Local structured logs with redaction and configurable retention; no remote sink |
| Supply chain | Lockfiles, dependency review, SBOM, licence audit, pinned CI actions, and reproducible production build instructions |

## 15. AI output quality and safety

An insight is valid only if:

- Its JSON passes the current output schema.
- Every numeric value matches an allowed calculated value and rounding rule.
- Every finding cites supplied metric IDs.
- It separates observation from interpretation and recommendation.
- It does not infer unprovided sleep, stress, nutrition, weather, illness, or goals.
- It states material data gaps and coverage limitations.
- It avoids medical diagnoses and absolute causal claims.
- It does not promise fat loss or body-composition outcomes based on zone time or a single ride.
- It does not expose information removed by the payload minimizer.

Failed validation displays no polished narrative as if it were trustworthy. The user sees a clear provider/validation error and may inspect the safe diagnostic.

## 16. Open-source engineering workflow

### 16.1 Git and pull requests

- `main` is protected; all changes enter through pull requests.
- No direct pushes or force pushes to `main`.
- Each issue or independently reviewable change gets its own branch and PR.
- Suggested branch format: `<agent>/<issue>-<short-description>`.
- Claude, Codex, and Hermes work in separate branches/worktrees. Agents do not share an active worktree or rewrite another agent's branch.
- Every task defines file/module ownership before implementation when concurrent changes could overlap.
- Rebase or merge `main` before final review; resolve conflicts intentionally.
- Squash merge by default with a clear, issue-linked commit title.
- Generated code is held to the same tests, privacy checks, documentation, and review standards as human-written code.

### 16.2 Required PR contents

- Linked issue and requirement IDs
- Scope and non-scope
- Implementation summary
- Tests run and evidence
- Screenshots using synthetic data only, when UI changes
- Migration and rollback notes, when relevant
- Privacy impact
- Data-handling changes
- Dependency and licence impact
- Contribution-licensing status; significant outside contributions require a signed CLA on
  file before merge
- Explicit attestation that no real health/location/credential data is present

### 16.3 Required merge gates

- Formatting and lint
- Type checking
- Unit tests
- Parser contract tests
- Database migration tests
- Deterministic analytics golden tests
- Offline end-to-end tests
- Accessibility smoke tests
- Privacy/data-leak scan
- Secret scan
- Dependency and licence policy
- Maintainer verification that any significant outside contribution has a signed CLA on
  file; until an execution-ready CLA process exists, such contributions are ineligible for
  merge
- Build for supported architectures
- At least one independent review

### 16.4 Repository guidance

The repository must contain an `AGENTS.md` describing architecture boundaries, source-of-truth schemas, allowed commands, synthetic-data rules, privacy prohibitions, test gates, branch/PR workflow, and module ownership conventions. Agent-specific convenience files may point to it but may not weaken it.

## 17. Delivery phases

### Phase 0 — Privacy and repository foundation

- `AGPL-3.0-only` licence publication, ownership notice, and repository publication checklist
- Protected branch and PR template
- `AGENTS.md`
- Ignore rules, synthetic fixture generator, privacy scanner, CI skeleton
- Architecture decision records for local data, deterministic analytics, and AI boundary

Exit criterion: a deliberately inserted synthetic leak marker is blocked locally and in CI; no private corpus is present anywhere in the repository or history.

### Phase 1 — Import and local data

- SQLite schema and migrations
- CSV/GPX/ZIP parsers
- File association, validation, idempotency, and quarantine
- Import UI/CLI and data-quality reporting
- Backup, restore, delete, and repair

Exit criterion: synthetic mixed imports are atomic, repeatable, portable, and recoverable.

### Phase 2 — Deterministic analytics and visuals

- Ride library/detail
- Analytics engine and formula documentation
- Charts, comparisons, longitudinal dashboard
- Tile-free route and elevation views
- Offline and deterministic regression tests

Exit criterion: the full non-AI product passes with outbound networking denied.

### Phase 3 — Insight providers

- Payload minimizer and preview
- Insight schema, evidence links, and numeric validator
- Codex host bridge and provider
- Ollama provider
- Insight history and deletion

Exit criterion: no raw routes or source files reach either provider; unsupported claims and altered numbers fail validation.

### Phase 4 — Public release hardening

- Accessibility audit
- Threat model and privacy review
- Cross-platform packaging
- SBOM/licence review
- Performance benchmark
- Contributor documentation and security policy

Exit criterion: release checklist is complete, repository history passes privacy audit, and installation/backup/restore are reproduced on a clean machine.

## 18. v1 release acceptance criteria

Velograph v1 is releasable when all of the following are true:

1. A clean installation can import a synthetic Health Auto Export-shaped folder and ZIP.
2. GPX and route CSV association works, including missing, duplicated, and ambiguous cases.
3. Identical re-imports produce no duplicates.
4. All supported metrics use canonical units and documented versioned calculations.
5. Every chart and route view renders with external networking blocked.
6. The same fixture and settings produce identical analytics JSON across repeated runs.
7. Ride detail and comparison screens expose data-quality and formula information.
8. Codex and Ollama are optional and can fail without degrading the core app.
9. AI output is schema-valid, evidence-linked, numerically checked, and honest about unavailable context.
10. Codex credentials are never read into application storage or mounted into the app container.
11. Backups restore successfully on a clean supported installation.
12. Delete-all removes local data according to the documented secure-deletion limitations of the filesystem.
13. The repository, Git history, CI logs, screenshots, fixtures, releases, and container layers pass the privacy audit.
14. Required PR checks and independent review are enforced on `main`.
15. Security, privacy, medical-disclaimer, contribution, and licence documentation are published.

## 19. Success measures

Success is measured locally and voluntarily; Velograph does not phone home.

- A user can import, inspect, and compare rides without configuring AI.
- A repeat import requires no manual cleanup.
- A generated audit contains zero unsupported numeric claims in the reference evaluation suite.
- A generated audit contains zero claims about unavailable lifestyle context.
- No core browser request targets a non-loopback host during offline tests.
- No real personal data appears in the public repository or its artifacts.
- A backup can be moved between two clean supported installations without path edits.
- New contributors can implement a scoped issue through the documented PR workflow without access to private data.

## 20. Product decisions

These decisions do not block Phase 0 or the deterministic core, but the open items must be
resolved before public v1:

1. **Resolved 2026-07-30 — open-source licence:** Velograph uses
   `AGPL-3.0-only`. Junior Williams Consulting Inc. retains ownership of the original core
   code. Before accepting significant outside contributions, the company will adopt a CLA
   that lets contributors retain their copyright while granting the company the right to
   relicense their contributions.
2. Whether Windows is a v1 supported runtime or a post-v1 target.
3. The default moving-speed threshold and route accuracy/outlier limits.
4. Whether locally entered goals and subjective recovery notes are included in v1 or deferred.
5. The minimum coverage threshold for efficiency and decoupling metrics.
6. Whether the authenticated Health Auto Export REST endpoint belongs in v1.1 or v2.
7. Whether application-level SQLite encryption is a v1 requirement or a documented post-v1 enhancement.

## 21. Terminology

- **Deterministic analytics:** Versioned code that calculates metrics from stored data and settings without an LLM or external service.
- **Insight:** Optional LLM-authored narrative produced from a minimized deterministic metrics payload.
- **Coverage:** The proportion of eligible ride time represented by valid samples.
- **Route reconstruction:** Rendering the recorded GPX/route points and their segments; it does not imply road snapping.
- **Source truth:** Immutable retained source file when enabled, or its hash plus normalized records, provenance, parser version, and validation result.
- **Private corpus:** A user's real export data, which is never a repository fixture.
