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
- While GPX XML is mismatched, misnested, prematurely closed, or unclosed, when
  parsing runs, the system shall reject it with `malformed_xml`.

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
- ZIP expansion yields either extracted files or an outer-file quarantine item.
  The entire import, including that quarantine record and valid siblings, still
  commits through the existing database transaction.
- GPX parsing compares normalized opening and closing names at every close
  event while preserving namespace tolerance and existing resource limits.

### Security

- Authentication/authorization: unchanged. The import API remains a same-origin
  loopback mutation protected by existing request headers and origin checks.
- Input validation: required timestamps and numbers fail closed; ZIP and GPX
  resource limits remain enforced; filename timestamps never establish a
  workout by themselves.
- Output filtering: responses contain sanitized base filenames and stable error
  codes only. Error messages, sample values, coordinates, and raw content are
  not returned or logged.
- SQL safety: candidate queries remain parameterized.
- Rate limiting: no new endpoint or increased request surface is introduced;
  existing request-size limits remain authoritative.
- Privacy: tests use invented inline values or files under
  `fixtures/synthetic/`; no raw imported payload is committed.

## Error Contract

| Condition                                                              | Stable code                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Required numeric value missing, malformed, non-finite, or out of range | `numeric_value_invalid`                                             |
| Required timestamp missing or invalid                                  | `timestamps_invalid`                                                |
| Filename and internal times disagree, or no candidate satisfies both   | `association_conflict`                                              |
| Multiple candidates satisfy all available signals                      | `association_ambiguous`                                             |
| Malformed/misnested GPX XML                                            | `malformed_xml`                                                     |
| Unsafe/oversized/unreadable ZIP                                        | existing `zip_entry_rejected`, `zip_limits_exceeded`, or `io_error` |

## Security Checklist

- [x] Auth: no new endpoint; existing loopback import guard remains in force.
- [x] Authz: no user/resource ownership model is introduced.
- [x] Input: every required field is validated before persistence.
- [x] Output: only sanitized filenames and value-free codes leave the importer.
- [x] SQL injection: all candidate lookups use bound parameters.
- [x] XSS: filenames remain data and are base-name sanitized before storage.
- [x] CSRF: existing `x-velograph-request` and Origin/Host checks are unchanged.
- [x] Resource abuse: existing API, ZIP, GPX, and decompression limits remain.
- [x] Logging/privacy: no sample value, coordinate, source content, or path is
      added to errors or diagnostics.

## Implementation Plan

- [x] Add strict calendar and numeric validation helpers.
- [x] Bump importer, adapter, and GPX parser versions.
- [x] Add discriminated association and all-candidate repository lookup.
- [x] Convert per-outer-ZIP failures into quarantine inventory items.
- [x] Enforce normalized GPX closing-tag equality.
- [x] Add focused unit, repository, importer, and API regression tests.
- [x] Run format, lint, typecheck, tests, and the all-files privacy scan.
