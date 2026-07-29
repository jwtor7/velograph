# Feature: Node-compatible CLI and API runtimes

## Requirements

- While Velograph is installed on Node 20 through Node 26, when a user invokes the
  `velograph-import` package binary, the system shall execute JavaScript without a
  TypeScript loader or workspace packages.
- While Velograph is installed on Node 20 through Node 26, when a user starts the API
  package binary, the system shall bind to loopback and answer its health endpoint without
  a TypeScript loader or workspace packages.
- While the CLI executable is loading, when module resolution or evaluation fails, the
  system shall return a stable value-free error without a stack, local path, or imported
  value.
- While CLI arguments are being validated, when `--data-dir` has no non-empty value, the
  system shall return usage before resolving or opening any data directory.
- While a direct file path is imported on any supported operating system, the system shall
  pass only its base name to the import adapter.

## Architecture

### Frontend

- No UI behavior changes.
- The supported `pnpm app:start` lifecycle continues to build the web client before
  starting the loopback API.

### Backend

- Each executable has a minimal JavaScript wrapper that dynamically imports a separately
  bundled runtime. Keeping the wrapper outside the bundle ensures module-load failures occur
  inside its `try` boundary.
- esbuild bundles Velograph workspace code for Node 20. `better-sqlite3` and `fflate`
  remain direct runtime dependencies so native loading works normally and their upstream
  license files ship with their packages.
- Both packages carry an ordered `migrations/` directory beside `dist/`; bundled database
  code resolves it relative to `import.meta.url`.
- The app lifecycle builds and launches `apps/api/dist/velograph-api.mjs`.

### Security

- Package verification creates only invented CSV values and throwaway data directories
  beneath the operating-system temp directory.
- Invalid `--data-dir` syntax is rejected before `resolveDataDir()` can fall back to a
  user's real application-data directory.
- Subprocess assertions reject native stacks, local temp paths, and invented sample values
  in failure output.
- Runtime output remains local-only; neither package adds network clients, telemetry,
  credentials, or data logging.

## Implementation Plan

- [x] Define separate wrapper/runtime artifacts for CLI and API.
- [x] Build and package both artifacts with their migrations and direct dependencies.
- [x] Harden CLI argument and cross-platform path handling.
- [x] Add clean-install, health-start, module-load failure, and no-default-data regressions.
- [x] Make CI exercise both packages on Node 20 and Node 26.
- [x] Update lifecycle scripts and public documentation.
- [x] Run the complete test, static-analysis, artifact, and privacy gates.
