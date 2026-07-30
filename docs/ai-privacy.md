# AI insight privacy — `@velograph/insights`

The insights package implements the PRD §8.5 privacy and validation boundary plus opt-in Codex
CLI and Ollama runtimes. AI remains disabled by default. The loopback API and web client do not
yet expose provider configuration or generation, so no provider runs merely by starting or using
the Velograph app. A caller must explicitly select and invoke a configured package provider.

## AI is off by default, and never required

`resolveProvider()` defaults to `disabled` for a missing, `null`, or unrecognized provider id
(AI-001). The `disabled` provider never contacts anything; `generate()` always resolves — it
never throws — with a typed refusal explaining AI is off. **Import, analytics, comparisons,
and visualization all function completely without AI enabled**, in this phase and always.

## What leaves the machine, per provider

| Provider   | Destination                                                     | Data classification (`DestinationKind`) |
| ---------- | --------------------------------------------------------------- | --------------------------------------- |
| `disabled` | Nowhere — nothing is sent.                                      | `none`                                  |
| `ollama`   | A user-configured **loopback** Ollama endpoint on this machine. | `local-loopback`                        |
| `codex`    | The local Codex CLI, which talks to OpenAI.                     | `remote`                                |

`InsightProvider.describe()` returns this classification plus a one-sentence human-readable
explanation, so the app can render it before every first use and whenever the privacy policy
changes (AI-004) — see `POLICY_VERSION` in `packages/insights/src/preview.ts`.

The Codex runtime launches the user-installed `codex` executable directly with `shell: false`,
sends the bounded prompt over stdin, supplies a private temporary output-schema directory, and
removes that directory on every success or failure path. Velograph does not open Codex credential
files; the CLI owns its own authentication. The Ollama runtime accepts only IP-literal loopback
origins, checks the configured model without pulling one, and bounds request/response bytes and
time. Both runtimes support cancellation and convert failures to stable value-free error codes.

## The payload allow-list (AI-003)

`buildInsightPayload()` in `packages/insights/src/payload.ts` builds the _only_ JSON object any
provider ever sees. The allow-list is structural, not a filter bolted on afterward:
`METRIC_ALLOW_LIST` is a single array of `{ id, unit, extract }` entries, each pulling exactly
one derived scalar out of `RideAnalytics` (from `@velograph/analytics`). A reviewer can read
that one array top to bottom and see the complete set of numbers a provider could ever receive:

- Ride totals: duration, moving time, distance, average/max speed.
- Heart rate: average, max, min, coverage ratio.
- Cadence: average, max, coverage ratio.
- Energy (kJ), elevation gain/loss.
- Efficiency, decoupling percentage, pacing variability.
- Heart-rate zone time shares (zone number, label, share of time only).
- Personal-context availability flags (see below) — states only, never values.

The payload **never** carries, structurally (there is no code path that could attach them):

- Route coordinates or any route geometry.
- Raw time-series rows / individual samples.
- Source file names or paths.
- Device/source strings (e.g. exporter or wearable identifiers).
- Route names.
- Local notes or tags.

`packages/insights/src/payload.test.ts` proves this by attaching exactly these kinds of fields
to a `RideAnalytics` object and asserting the built payload's JSON contains none of them —
because the builder only ever reads through the allow-list, not by post-hoc stripping.

## Personal context defaults to "not available" (AI-008)

Sleep, stress, nutrition, weather, soreness, goals, and recovery each default to
`'not_available'` (`DEFAULT_CONTEXT_AVAILABILITY` in `context.ts`) and only flip to
`'available'` when the caller explicitly supplies that flag. The model is told the state, never
left to assume — a provider is never handed silence and allowed to guess.

## Structured output, evidence, and numeric grounding (AI-005, AI-006, AI-007)

Every provider response must match the versioned `INSIGHT_OUTPUT_JSON_SCHEMA`
(`insight-output-v1`, `packages/insights/src/schema.ts`) — the eight PRD §8.5 sections, in
order: ride execution; heart-rate dynamics and recovery; comparative conditioning signal;
strengths; fatigue indicators; training considerations; data limitations; bottom line.
`validateInsightOutputShape()` is a small hand-rolled structural validator (no `ajv`
dependency).

Each finding must cite `evidence: string[]` — deterministic metric IDs that exist in the
payload it was generated from. `validateFinding()` in `validation.ts`:

- **removes** a finding with no evidence, or evidence citing an unknown/fabricated metric ID;
- **removes** a finding using diagnostic/prescriptive phrasing (AI-011);
- **flags** a finding whose numeric claims don't match any supplied fact within tolerance
  (default ±1% relative / ±0.05 absolute floor);
- otherwise marks it **valid**.

Reason codes (`no_evidence`, `unknown_evidence_metric`, `diagnostic_phrasing`,
`unsupported_numeric_value`) are deliberately value-free — they never echo the fabricated
metric ID or the unsupported number back into logs or UI, matching the repo's log-hygiene and
privacy-scanner rules.

Provider output passes through one all-or-nothing orchestrator before it can be returned. The
orchestrator reprojects the minimized payload at runtime, builds a bounded deterministic prompt,
requires one JSON object with the exact schema, prompt version, and non-clinical disclaimer, and
requires every finding to validate as supported. Partial or merely flagged model output is never
returned as a successful generated insight.

## Non-clinical guidance (AI-011)

`NON_CLINICAL_DISCLAIMER` (in `guidance.ts`) frames every insight as informational training
commentary, not medical advice. `containsDiagnosticPhrasing()` rejects diagnostic/prescriptive
language (e.g. "you have a [...] disease", "you should stop taking your medication") before it
ever reaches display.

## Local audit trail, never credentials (AI-009)

`createAuditRecord()` (in `audit.ts`) is a pure constructor: given a provider id, a
model-reported identifier (nullable), a prompt version, the sanitized payload, the output, a
validation status, and an **injected** creation timestamp, it returns a record whose
`inputHash` is the SHA-256 hex digest (via `@velograph/shared/hash.ts`) of the
stable-stringified payload. The record's field set is fixed and audited by test
(`audit.test.ts`) to contain nothing credential-, token-, or secret-shaped — there is no field
for a provider credential anywhere in this type, so there is nothing to accidentally persist or
leak.

## Current application integration boundary

`packages/insights` depends only on `@velograph/shared` and `@velograph/analytics`; it adds no
third-party runtime dependency. Provider selection, first-use disclosure acknowledgement,
generation API routes, local audit persistence, and a web insight view remain outside the current
loopback app surface. Until those pieces are implemented and tested together, the app stays on
the `disabled` provider even though the package runtimes are functional.
