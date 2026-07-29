<p align="center">
  <img src="velograph_cover_art.png" alt="Velograph — turn Apple Health cycling data into clear visuals and AI-powered insights" width="100%">
</p>

# Velograph

**Turn Apple Health cycling data into clear visuals and AI-powered insights that help you understand every ride.**

Velograph is an open-source, local-first web app for cyclists. It imports Apple Health cycling exports (via [Health Auto Export](https://www.healthyapps.dev/) CSV/GPX/ZIP), stores them in a local SQLite database, calculates deterministic ride and conditioning metrics, reconstructs your routes entirely offline, and — optionally — generates evidence-linked AI narratives through a locally installed Codex CLI or Ollama.

## Privacy stance

Your health data never leaves your machine unless you explicitly send it somewhere.

- **Local first.** All data lives in a local data directory (`VELO_DATA_DIR`) outside the source checkout, in SQLite you can inspect, back up, and delete.
- **Offline by default.** No telemetry, CDNs, remote fonts, map tiles, or geocoding. The app binds to `127.0.0.1` and renders every chart and route view without a network connection.
- **AI explains; it does not calculate.** Every number comes from the deterministic analytics engine. AI is disabled by default, never required, and receives only a versioned, minimized JSON payload — never raw time-series, coordinates, or source files.
- **Public repo, zero personal data.** Only synthetic fixtures (invented values, invented dates, invented routes) may enter this repository, enforced by a default-deny `.gitignore`, a pre-commit privacy scanner, and blocking CI checks.

## Quick start

The build system has landed: a pnpm/TypeScript monorepo with a working import pipeline,
analytics engine, loopback API, and web client. There is no `pnpm dev` script — the web
client is built once and served by the API, as below.

```bash
pnpm install                            # install workspace dependencies
pnpm --filter @velograph/web build      # build the web client (required before the API can serve it)
```

Velograph supports Node 20 through Node 26. The repository includes the same built
JavaScript CLI artifact that ships in the package; CI clean-installs and invokes it on Node
20 and Node 26.

### Try it with the synthetic fixtures

**Do not import the synthetic fixtures into a data directory that holds real rides.**
There is no way to remove a ride yet (deletion is unimplemented, tracked in issue #38) — the
only way to undo an accidental import today is deleting the whole database. Point this
walkthrough at an explicit throwaway directory instead, so it can't touch real data:

```bash
export VELO_DATA_DIR=$(mktemp -d)                        # throwaway directory for this demo
pnpm velograph-import import fixtures/synthetic/rides
pnpm app:start
```

Then open `http://127.0.0.1:5123` in your browser. `VELO_DATA_DIR` stays set for the rest of
this shell session, so the API command above serves the same fixture rides you just
imported. Close the shell (or `unset VELO_DATA_DIR`) when you're done, and delete the
temporary directory if you want to reclaim the space.

### Import your own data

When you're ready to use a real [Health Auto Export](https://www.healthyapps.dev/) export,
start a fresh shell (so the throwaway `VELO_DATA_DIR` above is gone) and either set
`VELO_DATA_DIR` explicitly to where your real database should live, or leave it unset —
Velograph then picks an OS-appropriate application-data directory: `~/Library/Application
Support/velograph` on macOS, `%APPDATA%\velograph` on Windows, or
`$XDG_DATA_HOME/velograph` (falling back to `~/.local/share/velograph`) on Linux. Either way,
all persistent state — the SQLite database, quarantined import files — lives there, never
inside this checkout; a `VELO_DATA_DIR` that resolves inside a git checkout is refused at
startup.

```bash
pnpm velograph-import import /path/to/your/health-auto-export
pnpm app:start
```

Import the **whole export folder**, not individual files. Health Auto Export writes one CSV
per metric — heart rate, cadence, distance, and energy each arrive in their own file, with
the route as a separate GPX. Importing a single CSV produces a ride with only that one
metric. Files are associated into a single workout by type and overlapping sample range, so
companion files still join correctly if they arrive in a later import.

### Managing the local server

`pnpm app:start` builds the web client and starts the API in the background, then waits until
it actually answers before reporting success. The other three tell you what's happening
rather than leaving you to guess:

```bash
pnpm app:status    # running? which pid, port, data directory, and how many rides
pnpm app:restart   # pick up code changes
pnpm app:stop      # clean no-op if nothing is running
```

`app:status` is safe to run at any time, and `app:start` refuses to start a second server on
a port that is already held — which otherwise produces a stale API serving a freshly built
web client. Server output goes to a log file whose path `app:start` and `app:status` print.
(Process lookup uses `lsof`; on Windows use Task Manager to stop a stray server.)

Run the test suite and the other checks CI runs:

```bash
pnpm test         # unit, parser, migration, and analytics golden tests
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit across every workspace package
pnpm format       # prettier --check
node scripts/privacy-scan.mjs --all   # privacy/data-leak scan
pnpm cli:verify-package               # clean-install and invoke the packaged CLI
```

`pnpm cli:build` regenerates `apps/cli/dist/velograph-import.mjs` and its packaged migration
files. CI fails if the committed executable artifact is stale.

## Project layout

```
apps/
  api/      loopback HTTP API (workouts, analytics, trends, import, settings)
  cli/      velograph-import — CSV/GPX/ZIP importer CLI
  web/      React client, built with Vite
packages/
  analytics/  deterministic ride/conditioning metrics (pure, versioned formulas)
  db/         SQLite schema, migrations, data-dir resolution
  importers/  CSV/GPX/ZIP parsing, normalization, workout association
  insights/   AI provider interface, minimized payload, schema, validation (stub — see docs/ai-privacy.md)
  shared/     types and utilities shared across packages
fixtures/synthetic/   invented data used by tests and this quickstart
```

## Documentation

- [Product requirements (PRD)](Velograph-PRD.md) — the source of truth for all requirements
- [Repository guidelines](AGENTS.md) — structure, workflow, and privacy boundaries for contributors
- [Changelog](CHANGELOG.md) — what shipped, release by release
- [Release procedure](docs/releasing.md) — versioning scheme and how a release is cut
- [Design system](docs/design-system.md) — palette, typography, and visual language
- [Analytics formulas](docs/formulas.md) — every metric definition, versioned
- [Data management](docs/data-management.md) — delete, backup, restore, and repair: cascade behaviour and the delete/re-import idempotency decision
- [AI insight privacy](docs/ai-privacy.md) — what would leave the machine per provider, and why AI is a stub today
- [CI supply-chain policy](docs/ci-supply-chain.md) — pinned-SHA GitHub Actions and how to update them

## License

License to be determined (Apache-2.0 recommended; see PRD §20). Until a license is published, all rights reserved.
