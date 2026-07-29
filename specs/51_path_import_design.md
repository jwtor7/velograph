# Issue #51: Bounded path import and reliable foreground lifecycle

## Requirements

- While a user previews an export directory, when Velograph walks the tree, the system shall
  collect only bounded metadata through incremental directory iteration and shall not read source
  contents.
- While a user confirms that preview, when Velograph imports the directory, the system shall
  reproduce the exact private preview manifest, require its opaque digest, read one deterministic
  workout-association group at a time, and commit the complete confirmed import as one database
  transaction (IMP-001, IMP-007).
- While any traversal or group limit truncates a preview, the UI and API shall refuse
  confirmation; partial previews are never import plans.
- While an import plan is being consumed, when the root or a planned file changes identity,
  canonical location, type, or size, the system shall fail closed with a value-free error before
  importing bytes from the changed entry.
- While `pnpm app:dev` is running, when the operating-system browser launcher cannot be spawned,
  the system shall print the loopback URL and keep owning the API child until normal shutdown.
- While either workflow reports an error, the system shall not log file contents, coordinates,
  source strings, or local paths.

## Architecture

### Frontend

- The preview response carries an opaque confirmation digest. The client returns it unchanged on
  confirmation and never renders or interprets it.
- A truncated preview shows a stable limit message and disables confirmation. A `path_changed`
  response clears the stale preview and asks the user to preview again.
- Preview ordering remains stable so the user sees the same ride/file order that confirmation
  consumes.

### Backend

- `walkImportFolder` consumes `opendir` handles incrementally and produces a metadata-only
  manifest with canonical root and entry identities. Explicit visited-entry, opened-directory,
  recursion-depth, importable-file, and aggregate-byte limits count unsupported entries too.
- A shared grouping function orders association groups by workout type/timestamp key, then orders
  files by relative path. ZIPs and unrecognized files each form deterministic standalone groups.
- Preview hashes the complete private manifest, grouping result, skips, limits, and root identity.
  Confirmation repeats the walk, compares the digest, and refuses a mismatch or any truncation
  before source reads or database writes.
- A lazy group-loader iterator revalidates the canonical root and opens each planned file by
  descriptor. It checks descriptor identity and size before and after an exact-size bounded read.
- `runImportGroups` consumes that iterator inside one existing SQLite transaction. The previous
  `runImport` API delegates to one group, preserving loose-file and CLI behavior.
- ZIP extraction parses the central directory and matching local headers before inflation,
  enforcing entry names/counts and declared per-entry/aggregate sizes. Hidden/resource entries are
  excluded before inflation. Included entries are decoded with a maximum output length configured
  before inflation starts, bounded by the remaining per-entry and aggregate allowance, with
  declared/actual mismatches rejected.
- `openBrowser` attaches an `error` listener to the spawned launcher before detaching it. Browser
  launch remains best-effort and cannot terminate the foreground owner.

### Security

- Authentication/authorization: not applicable to this single-user loopback app. Existing strict
  Host/Origin checks and the custom CSRF header remain server-side requirements.
- Input: path body cap, checkout guard, traversal/file/byte caps, extension allow-list,
  canonical-root containment, preview-digest binding, root/file identity checks, regular-file
  checks, and two-phase ZIP validation all fail closed.
- Output: API responses remain allow-listed metadata and stable error codes. No source bytes or
  absolute planned-file paths or identity values are returned; the digest is opaque.
- Rate limiting: incremental traversal bounds, ZIP preflight/output limits, and request-body limits
  are the applicable resource controls; the endpoint is loopback-only and has no network exposure.
- Logging: no filesystem path or source value is added to logs. Launcher fallback prints only the
  fixed loopback URL supplied by the lifecycle command.
- SQL: no new SQL is introduced; the importer continues through the parameterized repository
  layer and one atomic transaction.
- XSS/encoding: filenames remain data in JSON and React text rendering, protected by the existing
  CSP. Stable errors are fixed application strings rather than filesystem values.

## Implementation plan

- [x] Capture acceptance criteria and complete the per-feature security checkpoint.
- [x] Add deterministic metadata grouping and lazy, identity-checked group reads.
- [x] Bind confirmation to the exact bounded preview manifest and reject truncated previews.
- [x] Replace recursive directory materialization with bounded incremental iteration.
- [x] Replace eager ZIP inflation with preflight plus a decoder-enforced maximum output length.
- [x] Add grouped importer consumption while preserving one atomic batch.
- [x] Switch the path endpoint to the lazy grouped pipeline.
- [x] Handle asynchronous browser-launch failure before `unref`.
- [x] Add synthetic ordering, laziness, memory-bound, TOCTOU, atomicity, and lifecycle tests.
- [x] Update the changelog and run focused plus repository-wide quality/privacy gates.

## Security checkpoint

- [x] Auth/authz model unchanged and explicitly scoped to loopback + CSRF.
- [x] Path and filesystem input validated at both request and read boundaries.
- [x] API output excludes contents and newly captured identity metadata.
- [x] Resource exhaustion is bounded by visited entries, directories, depth, importable files,
      total planned bytes, declared and actual ZIP output, and one association group resident at a
      time.
- [x] No credentials, personal data, raw exports, local paths, or sample values enter fixtures,
      errors, logs, docs, or tests.
- [x] Existing parameterized database access, security headers, CSP, and response encoding remain
      in force.

## Verification

- `pnpm test`: 32 test files and 228 tests pass, including synthetic traversal bounds,
  exact-manifest confirmation, mutation/addition/replacement rejection with no writes, ZIP
  preflight/decoder limits, complete metric/route coverage, transaction rollback, and
  browser-launch lifecycle cases.
- `pnpm typecheck`, `pnpm lint`, `pnpm format`, and the web production build: pass.
- `node scripts/privacy-scan.mjs --all`, `--staged`, and changed-file `--files` scans: pass.
- Frontend/accessibility: confirmation remains keyboard-operable; disabled and text states make a
  truncated preview non-confirmable, and no sensitive manifest field is rendered.
- Deployment/migration: no dependency, schema, migration, port, or environment change.
