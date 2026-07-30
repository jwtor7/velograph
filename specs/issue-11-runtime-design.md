# Feature: production API and CLI runtimes

## Requirements

- On Node `^20.19.0 || >=22.12.0 <27`, the API and CLI execute built JavaScript
  without a TypeScript loader or an installed Velograph workspace.
- `pnpm dev`, `pnpm app:start`, and `pnpm app:dev` build and execute
  `apps/api/dist/velograph-api.mjs`.
- API host and port syntax is rejected before resolving a data directory or opening
  SQLite. Port `0` is accepted by the API for isolated verification; lifecycle commands
  require a fixed port from 1 through 65535.
- API startup either reaches a listening loopback server or closes every HTTP, basemap,
  and database resource it acquired.
- Packaged API and CLI migrations are byte-identical copies of every canonical ordered
  migration. The released filename-only `0001_init.sql` history remains upgradeable to the
  complete current migration sequence.
- The packaged API serves its copied production web client, health/version response, and
  offline-basemap manifest.
- The packaged CLI preserves import, repair, backup, delete, and confirmed restore. It
  rejects missing, blank, or repeated `--data-dir` options before default-path resolution.

## Architecture

### Frontend

- Vite remains the web compiler. The API package build copies `apps/web/dist` to
  `apps/api/dist/web`; runtime resolution prefers that packaged directory and uses
  `apps/web/dist` only as a source-checkout fallback.
- No browser behavior or API contract changes.

### Backend

- Each executable has a minimal JavaScript launcher that dynamically imports a separately
  bundled runtime. Module resolution and native-addon failures therefore remain inside a
  value-free `try` boundary.
- esbuild bundles all Velograph workspace source. Only Node built-ins,
  `better-sqlite3`, and `fflate` may remain external. The build records a metafile and
  fails if any `node_modules` input was bundled or any `@velograph/*` import stayed
  external.
- `better-sqlite3` and `fflate` are direct runtime dependencies. Workspace packages and
  esbuild are private development inputs; the resulting tarballs are local release
  artifacts, not independently published workspace libraries.
- API startup keeps the existing restore-aware request drain, WAL checkpoint, signal
  coordinator, parent watchdog, and basemap service. Startup failure uses that same
  cleanup boundary.
- The app supervisor proves readiness from the health response, the listening PID, and
  the exact built entrypoint command. It never identifies or signals an arbitrary port
  listener as Velograph.

### Security checkpoint

- Authentication and authorization remain intentionally out of scope because the server
  accepts only lexical loopback hosts and does not add a remote bind mode.
- Host, port, parent PID, and CLI `--data-dir` syntax are validated before the relevant
  filesystem or process operation.
- Runtime output contains stable codes and operational state only; module-load errors do
  not expose stack traces, paths, filenames, database values, or imported sample values.
- Package verification creates only invented fixtures and private throwaway directories
  beneath the operating-system temp directory.
- Build and CI checks scan generated runtime/web artifacts even when a future ignore-rule
  change would otherwise hide them from a tracked-file scan.
- A repository `THIRD_PARTY_NOTICES.md` is copied when present. The project license is
  never substituted for third-party notices.

## Implementation plan

- [x] Add guarded API/CLI launchers and validated API startup lifecycle.
- [x] Add deterministic esbuild, migration, web, and notice packaging.
- [x] Harden lifecycle supervision and CLI option/path handling.
- [x] Add clean-install API and CLI package verifiers.
- [x] Add Node 20.19/current-26 CI package coverage and artifact privacy checks.
- [x] Update contributor, runtime, release, and user documentation.
- [x] Run all static, test, privacy, build, and installed-package gates.
