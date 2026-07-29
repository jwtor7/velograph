# Runtime packaging

Velograph's production entry points are checked-in Node.js packages:

- `apps/api/dist/velograph-api.mjs`
- `apps/cli/dist/velograph-import.mjs`

They support Node.js `^20.19.0 || >=22.12.0 <27` and are built with the repository-pinned
pnpm `10.34.5`. `pnpm app:start`, `pnpm app:dev`, and `pnpm dev` always execute the packaged
API entry point. The CLI wrapper is available through `pnpm velograph-import` after
`pnpm cli:build`.

## What the bundles contain

esbuild bundles every local `@velograph/*` workspace into each runtime. Only Node built-ins,
`better-sqlite3`, and `fflate` remain external dependencies. The build emits a metafile and
fails if an input came from `node_modules`, if a workspace import remained external, or if
anything outside that external allowlist survived.

Both packages include an exact copy of every ordered SQL migration. The build requires the
canonical `0001` through `0004` files, rejects extra or missing output migrations, and verifies
byte parity with `packages/db/migrations`. If `THIRD_PARTY_NOTICES.md` exists at the repository
root, it is copied byte-for-byte into each package. The project `LICENSE` is never selected as
a substitute.

The API build first builds the web client, then copies its complete `dist` tree into
`apps/api/dist/web`. At runtime the API prefers that packaged directory and falls back to
`apps/web/dist` only for source-tree development compatibility.

## Build and inspect

```bash
pnpm runtime:build
pnpm runtime:verify-artifacts
```

The artifact verifier checks entry points, esbuild metadata, migration and notice parity,
packaged web assets, symlinks, ignore-rule visibility, and privacy for every generated file,
including assets that are not yet tracked.

Generated API and CLI package files are committed. After changing runtime code, migrations,
the web client, dependency versions, or notices, rebuild them in the same change. CI rebuilds
the artifacts and rejects a dirty result.

## Clean-install verification

```bash
pnpm api:verify-package
pnpm cli:verify-package
```

Each verifier packs the corresponding workspace, installs that tarball into a fresh temporary
project, and runs only synthetic data in temporary directories.

The API verifier checks the root document and every hashed web asset byte-for-byte, health and
package-version parity, the offline map manifest, clean `SIGTERM` exit, value-free module
failure, and migration of the released legacy schema shape before applying all current
migrations.

The CLI verifier checks import, repair, backup, delete, refusal to restore without explicit
confirmation, confirmed restore, cross-platform source basenames, strict single non-empty
`--data-dir` parsing without fallback, and value-free module failure.

CI executes both verifiers on Node `20.19.0` and the current Node 26 line. Native macOS runs
do not prove Windows/Linux process inspection or binary compatibility; those platforms need
their own CI runners before being claimed as verified.

## Supervisor identity and cleanup

The app lifecycle script validates a lexical numeric port and forces the child to
`127.0.0.1`. Readiness requires all three of:

1. a healthy API response with the expected package version;
2. the expected child PID owning the listener;
3. that PID running the packaged API command.

An arbitrary process on the port is reported as unverified and is never labeled or signaled as
Velograph. Startup errors, early exits, and timeouts terminate the exact child process and wait
up to 12 seconds before a forced kill.
