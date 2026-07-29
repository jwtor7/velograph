# AI insight privacy — `@velograph/insights` (Phase 3 stub)

AI narrative generation implements PRD §8.5 (AI-001..AI-012). This phase ships the provider
interface, the minimized-payload builder, the versioned output schema, and evidence/numeric
validation — **no provider actually calls out anywhere yet**. `codex` and `ollama` are typed
stubs that reject with `ProviderNotImplementedError`; they contain no filesystem probing, no
child-process spawn, no HTTP client, and no `codex exec` invocation.

## AI is off by default, and never required

`resolveProvider()` defaults to `disabled` for a missing, `null`, or unrecognized provider id
(AI-001). The `disabled` provider never contacts anything; `generate()` always resolves — it
never throws — with a typed refusal explaining AI is off. **Import, analytics, comparisons,
and visualization all function completely without AI enabled**, in this phase and always.

## What would leave the machine, per provider (once implemented)

| Provider   | Destination                                                     | Data classification (`DestinationKind`) |
| ---------- | --------------------------------------------------------------- | --------------------------------------- |
| `disabled` | Nowhere — nothing is sent.                                      | `none`                                  |
| `ollama`   | A user-configured **loopback** Ollama endpoint on this machine. | `local-loopback`                        |
| `codex`    | The local Codex CLI, which talks to OpenAI.                     | `remote`                                |

`InsightProvider.describe()` returns this classification plus a one-sentence human-readable
explanation, so the app can render it before every first use and whenever the privacy policy
changes (AI-004) — see `POLICY_VERSION` in `packages/insights/src/preview.ts`.

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

## What's explicitly out of scope in this phase

No network call, no child-process spawn, no `codex exec` invocation, no Ollama HTTP client, no
API route wiring, and no web UI. `packages/insights` depends only on `@velograph/shared` and
`@velograph/analytics` — no new runtime dependencies. Real provider implementations (host
`codex` detection/login flow, sandboxed `codex exec` child process, loopback Ollama HTTP calls)
land in a later phase, built strictly on top of this interface and payload boundary.
