# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — see
[`docs/releasing.md`](docs/releasing.md) for what major/minor/patch mean while the project
is pre-1.0, and for the release procedure.

## [Unreleased]

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

### Fixed

- README quickstart no longer walks a reader into importing synthetic fixtures into their
  real `VELO_DATA_DIR`. The fixture-import step now sends data to an explicit throwaway
  directory (`VELO_DATA_DIR=$(mktemp -d)`) and starts the API against that same directory,
  with a warning that this matters because ride deletion was unimplemented until #38 — before
  that, the only way to undo an accidental import was deleting the whole database (#39).

[Unreleased]: https://github.com/jwtor7/velograph/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jwtor7/velograph/releases/tag/v0.1.0
