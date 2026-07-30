# Import Hardening for Issues 12–15

## Scope

This change hardens the existing Health Auto Export import path without adding
new formats or changing Velograph's local-only architecture. It covers:

- filename-timestamp corroboration and deterministic workout association;
- strict required numeric and timestamp validation;
- per-outer-archive quarantine for malformed ZIP inputs; and
- structurally correct GPX closing-tag validation.

All fixtures and test values are invented. No real health, route, filename, or
account data is used.

## Requirements

- While a supported filename contains a timestamp, when a file is associated,
  the system shall use that timestamp as a corroborating signal together with
  workout type, internal sample times, and the configured tolerance.
- While filename and internal timestamps disagree, when import runs, the
  system shall quarantine the file with `association_conflict` and shall not
  persist any samples or route points from it.
- While more than one workout remains viable, when import runs, the system
  shall quarantine the file with `association_ambiguous` rather than selecting
  an arbitrary workout.
- While a required CSV timestamp or numeric cell is blank, malformed,
  non-finite, or outside its supported range, when its adapter runs, the system
  shall quarantine the whole file with a stable value-free code.
- While an optional numeric field is blank or invalid, when its adapter runs,
  the system shall omit only that optional value and shall never synthesize
  zero.
- While a GPX point has no `<time>` element, when GPX import runs, the system
  shall retain the geometry with a null stored timestamp.
- While a GPX point has a present but malformed `<time>` element, when GPX
  import runs, the system shall quarantine the file with `timestamps_invalid`.
- While one selected outer ZIP is malformed, when a mixed import runs, the
  system shall record a quarantine row for that outer ZIP and continue
  processing valid sibling inputs within the same committed batch.
- While ZIP inputs are preflighted, hidden/system entries shall be skipped
  before inflation; declared and actual per-entry and aggregate sizes shall be
  bounded, and all selected archives shall share one decoded-byte budget.
- While GPX XML is mismatched, misnested, prematurely closed, or unclosed, when
  parsing runs, the system shall reject it with `malformed_xml`.
- While GPX uses namespaces, opening and closing qualified names shall match
  exactly and every prefix shall be declared. Closing-tag attributes, multiple
  roots, unknown entities, and trailing non-XML content shall fail closed.
- While a source hash has an older parser version, when replacement parsing or
  validation fails, the system shall preserve its canonical source row,
  normalized workout data, stable workout ID, and user-authored notes/tags, and
  shall append only a value-free failed-attempt record.
- While one stale source owns one workout, when replacement succeeds, the
  system shall replace only that source's normalized rows on the same workout.
  While ownership spans multiple workouts, replacement shall fail closed with
  `association_ambiguous` without detaching any data.
- While GPX bytes exceed the configured cap, when import begins, the system
  shall reject them before allocating a decoded string. The default document
  attribute budget shall accommodate the two required attributes for every
  point allowed by the default point-count cap.

## Architecture

### Frontend

- No new component or request contract is required.
- The existing import result already renders `quarantinedFiles` entries. New
  codes remain value-free and can travel through that response unchanged.
- API integration coverage proves a mixed valid-file/malformed-ZIP request
  returns the safe per-file code instead of collapsing to `invalid_body`.

### Backend

- `@velograph/shared` round-trip-validates all parsed calendar fields before
  converting them to epoch milliseconds.
- `@velograph/importers` centralizes strict numeric parsing and uses it for
  every metric, route CSV, and GPX numeric field.
- Filename stamps are interpreted as configured local wall time and UTC because
  HAE exports exist in both shapes; internal sample times must corroborate at
  least one interpretation, so neither can associate a workout alone.
- The association module returns one of `matched`, `none`, `ambiguous`, or
  `conflict`; the importer handles every state explicitly.
- Repository candidate lookup returns every viable candidate in deterministic
  order and never uses `LIMIT 1`.
- ZIP expansion first reads and validates the central directory, reserves from
  the import run's decoded-byte budget, and then inflates each selected entry
  with a hard output cap. Declared and actual sizes and CRCs must agree.
  Hidden entries are never inflated. Expansion yields either extracted files
  or an outer-file quarantine item; valid siblings still commit through the
  existing database transaction.
- GPX parsing scans the complete XML document without recovery. It compares
  exact qualified opening and closing names, maintains namespace scope, accepts
  unprefixed GPX and declared GPX namespaces, and rejects content outside the
  single document root.
- Parser-version replacement parses and validates before any destructive
  operation. A unique existing source-to-workout relationship is the stable
  replacement target even when corrected timestamps change its span. The
  additive `0002_source_file_reprocessing_failures.sql` migration records only
  source ID, batch ID, attempted parser version, stable error code, and attempt
  time; it stores no filename, sample, coordinate, raw content, or error text.

### Security

- Authentication/authorization: unchanged. The import API remains a same-origin
  loopback mutation protected by existing request headers and origin checks.
- Input validation: required timestamps and numbers fail closed; ZIP central
  metadata, bounded inflation output, aggregate decoded bytes, and GPX
  structure are independently enforced; GPX raw bytes are capped before UTF-8
  decoding; filename timestamps never establish a workout by themselves.
- Data ownership: parser code may replace only normalized rows owned by one
  uniquely identified source/workout relationship. Failed or shared-ownership
  attempts cannot delete user-authored workout children.
- Output filtering: responses contain sanitized base filenames and stable error
  codes only. Error messages, sample values, coordinates, and raw content are
  not returned or logged.
- SQL safety: candidate queries remain parameterized.
- Rate limiting: no new endpoint or increased request surface is introduced;
  existing request-size limits remain authoritative.
- Privacy: ride-shaped test inputs live only under `fixtures/synthetic/`; no raw
  imported payload is committed.

## Error Contract

| Condition                                                              | Stable code                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Required numeric value missing, malformed, non-finite, or out of range | `numeric_value_invalid`                                             |
| Required timestamp missing or invalid                                  | `timestamps_invalid`                                                |
| Filename and internal times disagree, or no candidate satisfies both   | `association_conflict`                                              |
| Multiple candidates satisfy all available signals                      | `association_ambiguous`                                             |
| Malformed/misnested GPX XML                                            | `malformed_xml`                                                     |
| Unsafe/oversized/unreadable ZIP                                        | existing `zip_entry_rejected`, `zip_limits_exceeded`, or `io_error` |

For a new source, these codes remain on its quarantined `source_files` row. For
a stale existing source, the same code is appended to
`source_file_reprocessing_failures`; the canonical row and last-known-good data
remain unchanged.

## Security Checklist

- [x] Auth: no new endpoint; existing loopback import guard remains in force.
- [x] Authz: no user/resource ownership model is introduced.
- [x] Input: every required field is validated before persistence.
- [x] Output: only sanitized filenames and value-free codes leave the importer.
- [x] SQL injection: all candidate lookups use bound parameters.
- [x] XSS: filenames remain data and are base-name sanitized before storage.
- [x] CSRF: existing `x-velograph-request` and Origin/Host checks are unchanged.
- [x] Resource abuse: ZIP preflight, bounded output, shared decoded-byte budget,
      and GPX byte/size/depth/point/attribute caps fail closed before unsafe
      allocation.
- [x] Data ownership: failed or ambiguously owned parser upgrades preserve
      canonical source, workout, normalized, and user-authored data.
- [x] Logging/privacy: no sample value, coordinate, source content, or path is
      added to errors or diagnostics.

## Implementation Plan

- [x] Add strict calendar and numeric validation helpers.
- [x] Bump importer, adapter, and GPX parser versions.
- [x] Add discriminated association and all-candidate repository lookup.
- [x] Convert per-outer-ZIP failures into quarantine inventory items.
- [x] Enforce exact QName/namespace GPX closing-tag equality and one root.
- [x] Preflight ZIP metadata and bound per-entry, per-archive, and per-run
      decoded bytes before retaining inflated output.
- [x] Add an ordered, additive failed-reprocessing migration and preserve stable
      workout ownership until a replacement has fully validated.
- [x] Enforce the GPX raw-byte cap before decoding and align the default
      attribute budget with the point contract.
- [x] Add focused unit, repository, importer, and API regression tests.
- [x] Run format, lint, typecheck, tests, and the all-files privacy scan.
