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

### Where your data lives

All persistent state — the SQLite database, quarantined import files — lives in
`VELO_DATA_DIR`, never inside this checkout. It's optional: left unset, Velograph picks an
OS-appropriate application-data directory (e.g. `~/Library/Application Support/velograph` on
macOS, `%APPDATA%\velograph` on Windows, `$XDG_DATA_HOME/velograph` on Linux). Either way, a
`VELO_DATA_DIR` that resolves inside a git checkout is refused at startup — set one
explicitly if you'd rather choose the location yourself:

```bash
export VELO_DATA_DIR=~/velograph-data   # anywhere outside this repo; optional
```

Import some rides. Use the committed synthetic fixtures to try it without any real data, or
point at a real [Health Auto Export](https://www.healthyapps.dev/) folder/ZIP:

```bash
node apps/cli/src/index.ts import fixtures/synthetic/rides
```

Start the API — it binds `127.0.0.1:5123` by default and serves the built web client from
that same origin:

```bash
node apps/api/src/main.ts
```

Then open `http://127.0.0.1:5123` in your browser.

Run the test suite and the other checks CI runs:

```bash
pnpm test         # unit, parser, migration, and analytics golden tests
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit across every workspace package
pnpm format       # prettier --check
node scripts/privacy-scan.mjs --all   # privacy/data-leak scan
```

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
- [AI insight privacy](docs/ai-privacy.md) — what would leave the machine per provider, and why AI is a stub today
- [CI supply-chain policy](docs/ci-supply-chain.md) — pinned-SHA GitHub Actions and how to update them

## License

License to be determined (Apache-2.0 recommended; see PRD §20). Until a license is published, all rights reserved.
