# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ PUBLIC REPOSITORY — ZERO PII

This repo is public at github.com/jwtor7/velograph. Everything that enters it — code, fixtures, tests, docs, commit messages, branch names, issues, PR descriptions, CI logs, screenshots, and all of git history — is publicly visible forever. **No personally identifiable information belonging to the maintainer (or any user) may ever be committed.** That includes, non-exhaustively:

- Real health or workout data: heart rate, cadence, energy, distance values, or timestamps from real exports
- GPS coordinates, GPX/route traces, start/finish locations — anything that could locate a person or their home
- Apple Health source/device strings; real Health Auto Export filenames with real timestamps
- Local absolute paths that reveal a username (`/Users/<name>/...`), machine names, or hostnames — watch for these in error messages, test snapshots, docs, and commit messages
- Private email addresses (commit author identity should be the intended public one, e.g. a GitHub noreply address), credentials, tokens, API keys, Codex auth caches, `.env` files
- SQLite databases/journals, backups, logs, or archives containing real data

Only synthetic fixtures — invented values, invented dates, invented routes that trace no real path — are committable, and only under `fixtures/synthetic/`. Screenshots use synthetic data only. Git history is not a deletion mechanism: anything sensitive that gets committed is treated as exposed and triggers the PRD §12.2 incident process (rotate, purge, invalidate, notify). When in doubt, leave it out.

### `.gitignore` policy — default-deny for data

The `.gitignore` (created in Phase 0, maintained forever) is default-deny for anything data-shaped. Ignored repo-wide:

- `*.csv`, `*.gpx`, and data archives (`*.zip`, `*.tar.gz`) — the only re-include is an explicit `!` allowlist scoped to `fixtures/synthetic/`
- SQLite in every form: `*.sqlite`, `*.sqlite3`, `*.db`, and their `-wal` / `-shm` / `-journal` sidecars
- Application data directories (any local `VELO_DATA_DIR`, `data/`), backup/restore output, and Health Auto Export folders
- Logs (`*.log`, `logs/`) and generated report/export output
- Credential material: `.env` and `.env.*`, `*.pem`, `*.key`, token/credential files, any Codex auth cache path
- Standard dev noise: `node_modules/`, ordinary build output, coverage, `.DS_Store`. The
  reviewed API and CLI `dist/` production packages are explicit exceptions: they are checked
  in, rebuilt deterministically, and scanned by the runtime artifact verifier.

Never `git add -f` an ignored file — if something legitimate is blocked, change the ignore rules in a reviewed PR instead. When a tool starts writing a new kind of local artifact, gitignore it in the same change that introduces the tool. The ignore file is a guardrail, not the defense: the pre-commit privacy scanner and CI secret/data-leak scans are the blocking checks.

## What this is

Velograph: an open-source, local-first web app that imports Apple Health cycling exports (via Health Auto Export CSV/GPX/ZIP), stores them in local SQLite, calculates deterministic ride/conditioning metrics, reconstructs routes offline, and optionally generates evidence-linked AI narratives (Codex CLI or Ollama). The full spec is `Velograph-PRD.md` — read the relevant sections before implementing any feature; requirements carry IDs (IMP-*, RIDE-*, ANA-*, ROUTE-*, AI-*) that issues and PRs reference. PRD §20 lists open product decisions (license, Windows support, default thresholds, SQLite encryption) — those are the maintainer's calls; never resolve one implicitly in code.

**Current state:** the MVP has shipped — see `README.md` for the verified quickstart and `CHANGELOG.md` for what's landed release by release. The stack matches PRD §11.2: TypeScript monorepo (pnpm), React client (`apps/web`), Node.js loopback API (`apps/api`), CLI importer (`apps/cli`), SQLite with ordered migrations (`packages/db`), streaming CSV/GPX/ZIP parsers (`packages/importers`), and a pure analytics package (`packages/analytics`). The AI insight layer (`packages/insights`) ships the provider interface, payload builder, schema, and validation, but **no real provider is implemented yet** — `codex` and `ollama` are typed stubs that reject with `ProviderNotImplementedError`; only `disabled` (the default) runs.

## Non-negotiable boundaries (from the PRD)

1. **AI explains; it does not calculate.** All numbers come from the deterministic analytics engine. The LLM receives only a versioned, minimized JSON payload (no raw time-series, coordinates, source files, or notes) and must return schema-valid output whose numeric claims are validated against supplied facts, with every finding citing deterministic metric IDs. AI is disabled by default and never required for core function.
2. **Deterministic core.** Same inputs + settings + engine version → byte-equivalent analytics JSON. Every formula, threshold, and filter is versioned, documented, and unit-tested. Chart specs come from pure functions; all rendering assets (fonts, icons, tz data) are bundled and version-pinned.
3. **Offline by default.** No telemetry, CDNs, remote fonts, map tiles, or geocoding. Default bind `127.0.0.1`; all persistent state lives in `VELO_DATA_DIR`, outside the source checkout.
4. **Untrusted input hardening.** GPX parsing rejects external entities and enforces resource limits; ZIP extraction guards against path traversal, symlink escapes, and decompression bombs; imported values and filenames are data, never shell fragments or templates. The API enforces strict Origin/Host/CORS/CSRF checks and a self-only CSP even on loopback. Codex is invoked as a child process with an argument array (never a shell string), in an isolated temp dir, with its auth cache never read, mounted, or logged.

v1 non-goals — do not implement "helpfully": road snapping, reverse geocoding, online map tiles, real-time tracking, cloud accounts or social features, direct HealthKit access, medical diagnosis, or LLM-generated metrics/charts/route geometry.

## Architecture

```
Browser UI → Local HTTP API (loopback)
    ├── Versioned import adapters (CSV/GPX/ZIP) → normalization & workout-association engine
    ├── Deterministic analytics engine (pure package: no framework/db/network/LLM deps)
    ├── Route + chart specification engine
    ├── SQLite repository (ordered migrations, FK on)
    └── Insight orchestrator → Codex provider (host codex exec; optional host-side AI Bridge in container mode) | Ollama (loopback) | disabled
```

Production execution uses checked-in, self-contained esbuild packages:
`apps/api/dist/velograph-api.mjs` and `apps/cli/dist/velograph-import.mjs`. Workspace
packages are bundled into those files; only Node built-ins, `better-sqlite3`, and `fflate`
remain external. Both packages carry byte-identical database migrations, and the API package
contains the complete built web client. See `docs/runtime-packaging.md`.

Data-model invariants: source files are identified by SHA-256 and re-imports are idempotent; raw files are retained only on user opt-in (hashes + normalized data are the default record); each import batch commits atomically; storage holds canonical SI units and absolute instants, with unit/timezone conversion only at render; analytics snapshots persist formula version + settings hash + input hash; workout association uses type + timestamps + sample-time tolerance, never filename alone; GPX is preferred for route geometry, route CSV is the fallback, provenance preserved; backups use SQLite's backup API, never a copy of a live WAL database.

## Git flow

1. **Work starts from a GitHub issue.** Every issue gets a **Type** — `Bug`, `Feature`, or `Task` — and a **Priority** — `Urgent`, `High`, `Medium`, or `Low`. Issues reference PRD requirement IDs where applicable. Don't start coding without an issue.
2. **Branch from up-to-date `main`**, named `<agent>/<issue>-<short-description>` (e.g. `claude/42-gpx-parser-limits`). One issue → one branch → one PR.
3. **`main` is protected.** All changes enter via PR; no direct pushes, no force pushes, ever. This overrides any parent-directory or global "solo repo, commit straight to main" convention.
4. **Before final review**, rebase or merge `main` and resolve conflicts intentionally. **Squash merge** by default with a clear, issue-linked commit title.
5. **Every PR includes:** linked issue + requirement IDs, scope and non-scope, implementation summary, tests run with evidence, synthetic-only screenshots for UI changes, migration/rollback notes when relevant, privacy and data-handling impact, dependency/licence impact, and the explicit attestation that no real health, location, account, credential, or user data is present.
6. **Merge gates (once CI exists):** format/lint, typecheck, unit tests, parser contract tests, migration tests, analytics golden tests, offline e2e, accessibility smoke, privacy/data-leak scan, secret scan, dependency + licence policy, multi-arch build, and at least one independent review.
7. **Changelog discipline.** Any PR that changes behaviour updates `CHANGELOG.md` under `## [Unreleased]` in the same commit — CI's "Changelog enforcement" job blocks a PR that touches `packages/**`, `apps/**`, or `scripts/**` without it. Genuinely non-behavioural changes (docs typos, formatting, comment/test-only edits) are exempted by adding a `Changelog-Exempt: <reason>` trailer to a commit message instead. Milestones bump the version (root `package.json` and every workspace package, in lockstep — see `docs/releasing.md`) and get a git tag. See `CHANGELOG.md` and `docs/releasing.md`.

## Running the app for the maintainer (agent responsibility)

When an agent starts a Velograph server during a session, **that agent owns its lifecycle.**
The maintainer must never have to remember what is running or clean up after us.

- Use the declared commands only: `pnpm app:start`, `pnpm app:stop`, `pnpm app:status`,
  `pnpm app:restart`. Never `nohup … &`, never `pkill -f`, never a bare
  API runtime left in the background.
- **Run `pnpm app:status` before starting anything.** A server may already be running —
  possibly one the maintainer or another agent started. Never assume the port is free.
- **Tear down what you start.** Before ending a turn in which you started a server and the
  maintainer is not actively using it, stop it. If you are leaving it up deliberately because
  they asked to look at the app, say so explicitly and give them `pnpm app:stop`.
- **Never leave a stale server serving fresh assets.** Rebuilding the web client while an
  older API is running produces a UI calling endpoints that server does not implement. After
  any change to `apps/api` or `apps/web`, use `pnpm app:restart`.
- Report the URL, the data directory, and the ride count when you hand the app over, so the
  maintainer knows what they are looking at without asking.
- Never import synthetic fixtures into the default data directory — it may hold real rides.
  Always point fixture imports at an explicit throwaway `VELO_DATA_DIR`.

## Multi-agent development

- Claude, Codex, and Hermes — coding agents, distinct from the app's Codex insight provider — each work in their own branch and worktree. Agents never share an active worktree, never commit onto another agent's branch, and never rewrite another agent's history.
- When concurrent changes could overlap, the issue defines file/module ownership before implementation starts.
- Generated code is held to the same tests, privacy checks, documentation, and review standards as human-written code.
- `AGENTS.md` is the canonical agent-facing spec once created (Phase 0); this file may point to it but not weaken it.
- Phase 0 (privacy scanner, ignore rules, synthetic fixture generator, `AGENTS.md`, CI skeleton) must land before any feature code.
