# Issue #51: Bounded path import and reliable foreground lifecycle

## Requirements

- While a user previews an export directory, when Velograph walks the tree, the system shall
  collect only bounded metadata and shall not read source contents.
- While a user confirms that preview, when Velograph imports the directory, the system shall
  read one deterministic workout-association group at a time and commit the complete confirmed
  import as one database transaction (IMP-001, IMP-007).
- While an import plan is being consumed, when the root or a planned file changes identity,
  canonical location, type, or size, the system shall fail closed with a value-free error before
  importing bytes from the changed entry.
- While `pnpm app:dev` is running, when the operating-system browser launcher cannot be spawned,
  the system shall print the loopback URL and keep owning the API child until normal shutdown.
- While either workflow reports an error, the system shall not log file contents, coordinates,
  source strings, or local paths.

## Architecture

### Frontend

- No component or wire-format change. The existing preview/confirm UI remains the client-side
  gate and keeps its current loading and value-free error states.
- Preview ordering remains stable so the user sees the same ride/file order that confirmation
  consumes.

### Backend

- `walkImportFolder` produces a metadata-only manifest with canonical root and file identities.
- A shared grouping function orders association groups by workout type/timestamp key, then orders
  files by relative path. ZIPs and unrecognized files each form deterministic standalone groups.
- A lazy group-loader iterator revalidates the canonical root and opens each planned file by
  descriptor. It checks descriptor identity and size before and after an exact-size bounded read.
- `runImportGroups` consumes that iterator inside one existing SQLite transaction. The previous
  `runImport` API delegates to one group, preserving loose-file and CLI behavior.
- `openBrowser` attaches an `error` listener to the spawned launcher before detaching it. Browser
  launch remains best-effort and cannot terminate the foreground owner.

### Security

- Authentication/authorization: not applicable to this single-user loopback app. Existing strict
  Host/Origin checks and the custom CSRF header remain server-side requirements.
- Input: path body cap, checkout guard, file-count/byte caps, extension allow-list, canonical-root
  containment, root/file identity checks, and regular-file checks all fail closed.
- Output: API responses remain allow-listed metadata and stable error codes. No source bytes or
  absolute planned-file paths are returned.
- Rate limiting: bounded traversal and request-body limits are the applicable resource controls;
  the endpoint is loopback-only and has no network exposure.
- Logging: no filesystem path or source value is added to logs. Launcher fallback prints only the
  fixed loopback URL supplied by the lifecycle command.
- SQL: no new SQL is introduced; the importer continues through the parameterized repository
  layer and one atomic transaction.
- XSS/encoding: no new rendered content is introduced; filenames remain data in JSON and React
  text rendering, protected by the existing CSP.

## Implementation plan

- [x] Capture acceptance criteria and complete the per-feature security checkpoint.
- [x] Add deterministic metadata grouping and lazy, identity-checked group reads.
- [x] Add grouped importer consumption while preserving one atomic batch.
- [x] Switch the path endpoint to the lazy grouped pipeline.
- [x] Handle asynchronous browser-launch failure before `unref`.
- [x] Add synthetic ordering, laziness, memory-bound, TOCTOU, atomicity, and lifecycle tests.
- [x] Update the changelog and run focused plus repository-wide quality/privacy gates.

## Security checkpoint

- [x] Auth/authz model unchanged and explicitly scoped to loopback + CSRF.
- [x] Path and filesystem input validated at both request and read boundaries.
- [x] API output excludes contents and newly captured identity metadata.
- [x] Resource exhaustion is bounded by file count, total planned bytes, ZIP limits, and one
      association group resident at a time.
- [x] No credentials, personal data, raw exports, local paths, or sample values enter fixtures,
      errors, logs, docs, or tests.
- [x] Existing parameterized database access, security headers, CSP, and response encoding remain
  in force.

## Verification

- `pnpm test`: 32 test files and 217 tests pass, including synthetic folder ordering,
  group-bound, laziness, same-size replacement, root-retarget, transaction rollback, complete
  metric/route coverage, and asynchronous browser-launch failure cases.
- `pnpm typecheck`, `pnpm lint`, and `pnpm format`: pass.
- `node scripts/privacy-scan.mjs --all`: all scanned repository files clean.
- Frontend/accessibility: no UI or response-contract field was removed; the existing preview and
  confirmation flow is unchanged.
- Deployment/migration: no dependency, schema, migration, port, or environment change.
