import { evidenceIdsForPayload } from './payload.ts';
import type { InsightPayload } from './payload.ts';
import { containsDiagnosticPhrasing } from './guidance.ts';
import type { InsightFinding } from './schema.ts';

/**
 * Evidence + numeric validation (AI-006, AI-007). Every finding must cite an
 * evidence metric ID that exists in the payload it was generated from, and
 * every numeric statement in its text must match a supplied fact within
 * tolerance. Reason codes are value-free by design — never echo the
 * offending value, per log-hygiene and privacy-scanner rules.
 */

export type FindingValidationStatus = 'valid' | 'flagged' | 'removed';

export type FindingValidationReasonCode =
  'no_evidence' | 'unknown_evidence_metric' | 'diagnostic_phrasing' | 'unsupported_numeric_value';

export interface FindingValidationResult {
  status: FindingValidationStatus;
  /** null only when status is 'valid'. */
  reasonCode: FindingValidationReasonCode | null;
}

export interface NumericFact {
  metricId: string;
  value: number;
}

export interface NumericToleranceOptions {
  /** Relative tolerance, e.g. 0.01 = 1%. Applied in addition to toleranceAbs. */
  toleranceRel: number;
  /** Absolute tolerance floor, so near-zero facts aren't impossibly strict. */
  toleranceAbs: number;
}

export const DEFAULT_NUMERIC_TOLERANCE: NumericToleranceOptions = {
  toleranceRel: 0.01,
  toleranceAbs: 0.05,
};

/** Every non-null metric (and zone share) in the payload, as a matchable numeric fact. */
export function deriveFactsFromPayload(payload: InsightPayload): NumericFact[] {
  const facts: NumericFact[] = [];
  for (const m of payload.metrics) {
    if (m.value !== null) facts.push({ metricId: m.id, value: m.value });
  }
  for (const z of payload.zones ?? []) {
    facts.push({ metricId: `hr_zone_${z.zone}_share`, value: z.shareOfTime });
    facts.push({ metricId: `hr_zone_${z.zone}_share_pct`, value: z.shareOfTime * 100 });
  }
  return facts;
}

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;

/** Extracts numeric tokens from free text (percentages counted by their leading number). */
export function extractNumbers(text: string): number[] {
  const matches = text.match(NUMBER_PATTERN) ?? [];
  return matches.map(Number).filter((n) => Number.isFinite(n));
}

function withinTolerance(n: number, fact: NumericFact, options: NumericToleranceOptions): boolean {
  const allowed = Math.max(options.toleranceAbs, Math.abs(fact.value) * options.toleranceRel);
  return Math.abs(n - fact.value) <= allowed;
}

function isNumberSupported(
  n: number,
  facts: NumericFact[],
  options: NumericToleranceOptions,
): boolean {
  return facts.some((fact) => withinTolerance(n, fact, options));
}

/**
 * Validates a single finding against the payload it was purportedly
 * generated from. Pure function; no I/O.
 */
export function validateFinding(
  finding: InsightFinding,
  payload: InsightPayload,
  options: NumericToleranceOptions = DEFAULT_NUMERIC_TOLERANCE,
): FindingValidationResult {
  if (finding.evidence.length === 0) {
    return { status: 'removed', reasonCode: 'no_evidence' };
  }

  const knownIds = evidenceIdsForPayload(payload);
  const hasUnknownEvidence = finding.evidence.some((id) => !knownIds.has(id));
  if (hasUnknownEvidence) {
    return { status: 'removed', reasonCode: 'unknown_evidence_metric' };
  }

  if (containsDiagnosticPhrasing(finding.text)) {
    return { status: 'removed', reasonCode: 'diagnostic_phrasing' };
  }

  const facts = deriveFactsFromPayload(payload);
  const numbers = extractNumbers(finding.text);
  const hasUnsupportedNumber = numbers.some((n) => !isNumberSupported(n, facts, options));
  if (hasUnsupportedNumber) {
    return { status: 'flagged', reasonCode: 'unsupported_numeric_value' };
  }

  return { status: 'valid', reasonCode: null };
}
