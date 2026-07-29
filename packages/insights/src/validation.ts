import { evidenceIdsForPayload, zoneMetricId } from './payload.ts';
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
  | 'no_evidence'
  | 'unknown_evidence_metric'
  | 'diagnostic_phrasing'
  | 'unsupported_numeric_value'
  | 'unsupported_numeric_unit';

export interface FindingValidationResult {
  status: FindingValidationStatus;
  /** null only when status is 'valid'. */
  reasonCode: FindingValidationReasonCode | null;
}

export interface NumericFact {
  /** Evidence ID that authorizes this numeric representation. */
  evidenceId: string;
  value: number;
  /** Payload unit or explicitly approved display representation. */
  unit: string;
  representation: 'payload' | 'percent';
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
    if (m.value !== null) {
      facts.push({
        evidenceId: m.id,
        value: m.value,
        unit: m.unit,
        representation: 'payload',
      });
    }
  }
  for (const z of payload.zones ?? []) {
    const evidenceId = zoneMetricId(z.zone);
    facts.push({
      evidenceId,
      value: z.shareOfTime,
      unit: 'ratio',
      representation: 'payload',
    });
    facts.push({
      evidenceId,
      value: z.shareOfTime * 100,
      unit: '%',
      representation: 'percent',
    });
  }
  return facts;
}

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;

interface NumericClaim {
  value: number;
  /** Canonical unit only when the text explicitly labels this number. */
  unit: string | null;
}

const CLAIM_UNIT_ALIASES: readonly { pattern: RegExp; unit: string }[] = [
  {
    pattern: /^\s*(?:kilomet(?:er|re)s?\s+per\s+hour\s+per\s+bpm|km\/h\/bpm)\b/i,
    unit: 'km/h/bpm',
  },
  {
    pattern: /^\s*(?:met(?:er|re)s?\s+per\s+second|m\/s)\b/i,
    unit: 'm/s',
  },
  {
    pattern: /^\s*(?:kilomet(?:er|re)s?\s+per\s+hour|km\/h)\b/i,
    unit: 'km/h',
  },
  {
    pattern: /^\s*(?:beats?\s+per\s+minute|bpm)\b/i,
    unit: 'bpm',
  },
  {
    pattern: /^\s*(?:revolutions?\s+per\s+minute|rpm)\b/i,
    unit: 'rpm',
  },
  {
    pattern: /^\s*(?:milliseconds?|msecs?|ms)\b/i,
    unit: 'ms',
  },
  {
    pattern: /^\s*(?:seconds?|secs?|s)\b/i,
    unit: 's',
  },
  {
    pattern: /^\s*(?:minutes?|mins?|min)\b/i,
    unit: 'min',
  },
  {
    pattern: /^\s*(?:hours?|hrs?|hr)\b/i,
    unit: 'h',
  },
  {
    pattern: /^\s*(?:kilomet(?:er|re)s?|kms?|km)\b/i,
    unit: 'km',
  },
  {
    pattern: /^\s*(?:met(?:er|re)s?|m)\b/i,
    unit: 'm',
  },
  {
    pattern: /^\s*(?:kilojoules?|kJ)\b/i,
    unit: 'kJ',
  },
  {
    pattern: /^\s*(?:joules?|J)\b/i,
    unit: 'J',
  },
  {
    pattern: /^\s*(?:percent(?:age)?|pct)\b/i,
    unit: '%',
  },
  {
    pattern: /^\s*%/,
    unit: '%',
  },
  {
    pattern: /^\s*ratio\b/i,
    unit: 'ratio',
  },
];

function explicitClaimUnit(textAfterNumber: string): string | null {
  return CLAIM_UNIT_ALIASES.find(({ pattern }) => pattern.test(textAfterNumber))?.unit ?? null;
}

function extractNumericClaims(text: string): NumericClaim[] {
  return [...text.matchAll(NUMBER_PATTERN)]
    .map((match) => ({
      value: Number(match[0]),
      unit: explicitClaimUnit(text.slice((match.index ?? 0) + match[0].length)),
    }))
    .filter((claim) => Number.isFinite(claim.value));
}

/** Extracts numeric tokens from free text (percentages counted by their leading number). */
export function extractNumbers(text: string): number[] {
  return extractNumericClaims(text).map((claim) => claim.value);
}

function withinTolerance(n: number, fact: NumericFact, options: NumericToleranceOptions): boolean {
  const allowed = Math.max(options.toleranceAbs, Math.abs(fact.value) * options.toleranceRel);
  return Math.abs(n - fact.value) <= allowed;
}

function matchingFacts(
  claim: NumericClaim,
  facts: NumericFact[],
  options: NumericToleranceOptions,
): NumericFact[] {
  return facts.filter((fact) => withinTolerance(claim.value, fact, options));
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

  const citedEvidenceIds = new Set(finding.evidence);
  const facts = deriveFactsFromPayload(payload).filter((fact) =>
    citedEvidenceIds.has(fact.evidenceId),
  );
  const claims = extractNumericClaims(finding.text);
  for (const claim of claims) {
    const matches = matchingFacts(claim, facts, options);
    if (matches.length === 0) {
      return { status: 'flagged', reasonCode: 'unsupported_numeric_value' };
    }
    if (claim.unit !== null && !matches.some((fact) => fact.unit === claim.unit)) {
      return { status: 'flagged', reasonCode: 'unsupported_numeric_unit' };
    }
  }

  return { status: 'valid', reasonCode: null };
}
