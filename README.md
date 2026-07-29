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

The build system is a pnpm/TypeScript monorepo with a working import pipeline, analytics
engine, loopback API, and web client.

```bash
pnpm install   # install workspace dependencies
pnpm dev       # API on 127.0.0.1:5123 + live Vite UI on 127.0.0.1:5124
```

`pnpm dev` owns both foreground processes: press Ctrl-C once to stop both. Its proxy rewrites
only the configured loopback development Origin and Host, so the API's DNS-rebinding and
cross-origin protections remain strict. For the built background app on port 5123, use
`pnpm app:start` as documented below.

### Try it with the synthetic fixtures

**Do not import the synthetic fixtures into a data directory that holds real rides.**
Ride deletion exists, but a fixture import can still create several linked workouts. Point this
walkthrough at an explicit throwaway directory so the demo never touches real data:

```bash
export VELO_DATA_DIR=$(mktemp -d)                        # throwaway directory for this demo
node apps/cli/src/index.ts import fixtures/synthetic/rides
pnpm dev
```

Then open `http://127.0.0.1:5124` in your browser. `VELO_DATA_DIR` stays set for the rest of
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
node apps/cli/src/index.ts import /path/to/your/health-auto-export
pnpm app:start
```

Import the **whole export folder**, not individual files. Health Auto Export writes one CSV
per metric — heart rate, cadence, distance, and energy each arrive in their own file, with
the route as a separate GPX. Importing a single CSV produces a ride with only that one
metric. Files are associated into a single workout by type and overlapping sample range, so
companion files still join correctly if they arrive in a later import.

The web client's Import page can do the same thing without the CLI: paste the export folder's
path into the "Import from a folder path" field and preview it before confirming. The API
reads the folder directly from disk — the same way the CLI does, recursively, bounded by a
file-count/total-size cap — rather than uploading every file through the browser as base64,
which does not scale to a real export (a single route GPX alone runs a couple of megabytes,
and a folder holds dozens of files across many rides). Confirmation revalidates the selected
tree and reads one bounded ride group at a time while keeping the whole confirmed import
atomic; it never holds the entire folder in memory. The preview groups files by ride (workout
type + the filename's trailing timestamp) so it's obvious which companion files belong
together before anything is imported. The preview response contains relative entry metadata and
an opaque confirmation token, never the requested or canonical absolute folder path. The
multi-file picker and loose-file drag-and-drop
remain useful for small selections: each exact file is reviewed by the local API before the
Confirm button appears, duplicate/unsupported/out-of-scope status is shown, and files with the
same name and size remain distinct. Browser uploads enforce count, per-file, aggregate decoded,
and encoded-request limits and encode one file at a time; use folder path import when a selection
exceeds them. Compressed ZIP contents inherit those same per-file and aggregate decoded-byte
limits. Dropping a folder (where the browser supports `webkitGetAsEntry`) reads its files
into that same picker, since browsers do not expose a dropped folder's real filesystem path to a
web page — only pasting the path does that.

The versioned CSV adapter accepts units only when the header states them explicitly. Distance
supports `km` and `m`; energy supports `kJ`, `J`, and `kcal`; route altitude and accuracy support
`m` and `ft`; route speed supports `m/s` and `km/h`; and route course supports `deg`. Values are
converted to canonical metres, joules, metres per second, and degrees before storage. A generic
`Distance`, `Energy`, `Altitude`, or `Speed` header — or any unsupported unit — is quarantined
with the value-free `unit_unsupported` code rather than guessed.
The filename metric label must also agree with those headers before rows are normalized. CSVs
are capped at 32 MiB and 500,000 samples and are parsed without retaining a second full row
matrix; bound failures use the value-free `csv_limits_exceeded` code. GPX is accepted only when
its canonical cycling filename identifies it as `Route`.

Every web review, folder scan, and confirmed import has a visible Cancel action. Cancellation
stops browser file encoding or aborts the loopback request; the API propagates request/response
disconnects into the importer. The importer observes that signal at bounded file/group, CSV
parse/normalization, and 2,048-row database-insert checkpoints as well as before commit; an
observed cancellation rolls the complete SQLite transaction back.

### Managing the local server

Two ways to run it, background or foreground:

```bash
pnpm app:dev       # foreground: build, start, open the browser; Ctrl-C stops everything
```

`app:dev` is the everyday workflow — one command builds the web client, starts the API in the
foreground of your terminal, and opens it in your browser once it answers. Ctrl-C (or a
`kill`) tears it down cleanly: the API child is signaled, waited on, and force-killed if it
doesn't exit in time, so nothing is ever left holding the port after you stop it.

```bash
pnpm app:start     # background: same build+wait-for-ready, but detached
pnpm app:status    # running? which pid, port, data directory, and how many rides
pnpm app:restart   # pick up code changes
pnpm app:stop      # clean no-op if nothing is running
```

Use the background commands when you want a server that outlives the current shell (or a
session that needs to run something else in the same terminal). `app:status` is safe to run
at any time, and `app:start` refuses to start a second server on a port that is already
held — which otherwise produces a stale API serving a freshly built web client. Server output
goes to a log file whose path `app:start` and `app:status` print. (Process lookup uses `lsof`;
on Windows use Task Manager to stop a stray server.)

Run the test suite and the other checks CI runs:

```bash
pnpm test         # unit, parser, migration, and analytics golden tests
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit across every workspace package
pnpm format       # prettier --check
node scripts/privacy-scan.mjs --all   # privacy/data-leak scan
```

Backups are self-contained SQLite files with an app/schema manifest and deterministic table
checksums. Restore is destructive and therefore requires explicit confirmation:

```bash
node apps/cli/src/index.ts backup /safe/path/velograph.sqlite3
node apps/cli/src/index.ts restore /safe/path/velograph.sqlite3 --confirm-replace
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
- [Offline route maps](docs/offline-basemap.md) — interactive route controls and optional local raster MBTiles setup
- [Analytics formulas](docs/formulas.md) — every metric definition, versioned
- [Data management](docs/data-management.md) — delete, backup, restore, and repair: cascade behaviour and the delete/re-import idempotency decision
- [AI insight privacy](docs/ai-privacy.md) — what would leave the machine per provider, and why AI is a stub today
- [CI supply-chain policy](docs/ci-supply-chain.md) — pinned-SHA GitHub Actions and how to update them
- [Third-party notices](THIRD_PARTY_NOTICES.md) — bundled dependency licences and notices

## License

License to be determined (Apache-2.0 recommended; see PRD §20). Until a license is published, all rights reserved.
