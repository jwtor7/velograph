# Feature: Strict, Evidence-Scoped Insight Validation

## Requirements

- While untrusted model output crosses the insight boundary, when an object contains a root,
  section, or finding key outside the versioned schema, the system shall reject it with a
  value-free structural error.
- While a finding contains numeric text, when the finding cites deterministic evidence, the
  system shall validate each number only against facts represented by those cited evidence IDs.
- While a heart-rate zone share is supplied as a ratio, when a finding expresses that share as
  a percentage, the system shall accept the explicit ratio-to-percent representation.
- While validation fails, the system shall not include model-supplied keys, text, or numeric
  values in its reason codes.

## Architecture

### Frontend

- No UI or client contract changes. Downstream views continue to receive only validated insight
  output.

### Backend

- `schema.ts` enforces the same closed object shapes declared by
  `INSIGHT_OUTPUT_JSON_SCHEMA`.
- `validation.ts` associates every numeric representation with its legal evidence ID and filters
  candidate facts to the finding's citations before tolerance checks.
- Pure synthetic unit tests cover every object level, unrelated-metric collisions, and the
  approved zone percentage representation.

### Security

- Authentication and authorization are not applicable to this pure package.
- Untrusted model output is validated at the runtime boundary.
- Errors remain stable and value-free; no supplied keys, prose, metric values, or payload data are
  logged or returned.
- No network, persistence, shell, or rate-limited surface is introduced.

## Implementation Plan

- [x] Define exact allowed keys for root, section, and finding objects.
- [x] Reject unexpected properties with value-free location codes.
- [x] Associate numeric facts with their evidence IDs and display representation.
- [x] Restrict numeric support checks to cited evidence.
- [x] Add synthetic regression tests.
- [ ] Update the Unreleased changelog and run package/repository quality gates.
