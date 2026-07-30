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
  | 'unsupported_context_claim'
  | 'unsupported_qualitative_claim'
  | 'unsupported_numeric_format'
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
const MAX_PLAIN_DECIMAL_TOKEN_CHARACTERS = 64;
const UNSUPPORTED_NUMBER_WORD =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|quarter)\b/i;
const UNSUPPORTED_NUMBER_NOTATION =
  /(?:^|[^\d])[-+]?\.\d|\d(?:,\d{3})+|\d(?:_\d)+|\d+(?:\.\d+)?[eE][+-]?\d+|\d+\s*\/\s*\d+|(?:^|[^\d])\+\d|[−–—]\s*\d|[０-９]/;
const LIMITATION_LANGUAGE =
  /\b(?:(?:not|wasn't|isn't|aren't|weren't)\s+(?:available|provided|supplied|known)|unavailable|unknown|cannot|can't|could not|insufficient)\b|\bno\b.{0,24}\bdata\b/i;
const CONTEXT_TERM_PATTERNS = {
  sleep: /\b(?:sleep|slept)\b/i,
  stress: /\b(?:stress|stressed)\b/i,
  nutrition: /\b(?:nutrition|diet|fuel(?:ing|led)?|hydration|hydrated)\b/i,
  weather: /\b(?:weather|temperature|wind|rain|heat|cold)\b/i,
  soreness: /\b(?:sore|soreness)\b/i,
  goals: /\b(?:goal|goals|target)\b/i,
  recovery: /\b(?:recovery|recovered|recovering)\b/i,
} as const;
/** Fixed labels accepted by the complete finding grammar and included in the prompt. */
export const METRIC_EVIDENCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  duration_s: 'Duration',
  moving_time_s: 'Moving time',
  distance_m: 'Distance',
  avg_speed_ms: 'Average speed',
  max_speed_ms: 'Maximum speed',
  heart_rate_avg_bpm: 'Average heart rate',
  heart_rate_max_bpm: 'Maximum heart rate',
  heart_rate_min_bpm: 'Minimum heart rate',
  heart_rate_coverage_ratio: 'Heart-rate coverage',
  cadence_avg_rpm: 'Average cadence',
  cadence_max_rpm: 'Maximum cadence',
  cadence_coverage_ratio: 'Cadence coverage',
  energy_kj: 'Energy',
  elevation_gain_m: 'Elevation gain',
  elevation_loss_m: 'Elevation loss',
  efficiency_kmh_per_bpm: 'Efficiency',
  decoupling_pct: 'Decoupling',
  pacing_variability_ratio: 'Pacing variability',
});

const UNIT_GRAMMAR: Readonly<Record<string, string>> = {
  s: '(?:s|seconds?|secs?)',
  m: '(?:m|met(?:er|re)s?)',
  'm/s': '(?:m\\/s|met(?:er|re)s? per second)',
  bpm: '(?:bpm|beats? per minute)',
  rpm: '(?:rpm|revolutions? per minute)',
  ratio: 'ratio',
  kJ: '(?:kJ|kilojoules?)',
  '%': '(?:%|percent(?:age)?|pct)',
  'km/h/bpm': '(?:km\\/h\\/bpm|kilomet(?:er|re)s? per hour per bpm)',
};
const PLAIN_DECIMAL_GRAMMAR = '-?\\d+(?:\\.\\d+)?';
const APPROXIMATION_GRAMMAR = '(?:(?:about|approximately|roughly)\\s+)?';

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

const CLAIM_UNIT_PREFIX_ALIASES: readonly { pattern: RegExp; unit: string }[] = [
  {
    pattern: /\b(?:kilomet(?:er|re)s?\s+per\s+hour\s+per\s+bpm|km\/h\/bpm)\s*$/i,
    unit: 'km/h/bpm',
  },
  {
    pattern: /\b(?:met(?:er|re)s?\s+per\s+second|m\/s)\s*$/i,
    unit: 'm/s',
  },
  {
    pattern: /\b(?:kilomet(?:er|re)s?\s+per\s+hour|km\/h)\s*$/i,
    unit: 'km/h',
  },
  {
    pattern: /\b(?:beats?\s+per\s+minute|bpm)\s*$/i,
    unit: 'bpm',
  },
  {
    pattern: /\b(?:revolutions?\s+per\s+minute|rpm)\s*$/i,
    unit: 'rpm',
  },
  { pattern: /\b(?:milliseconds?|msecs?|ms)\s*$/i, unit: 'ms' },
  { pattern: /\b(?:seconds?|secs?|s)\s*$/i, unit: 's' },
  { pattern: /\b(?:minutes?|mins?|min)\s*$/i, unit: 'min' },
  { pattern: /\b(?:hours?|hrs?|hr)\s*$/i, unit: 'h' },
  { pattern: /\b(?:kilomet(?:er|re)s?|kms?|km)\s*$/i, unit: 'km' },
  { pattern: /\b(?:met(?:er|re)s?|m)\s*$/i, unit: 'm' },
  { pattern: /\b(?:kilojoules?|kJ)\s*$/i, unit: 'kJ' },
  { pattern: /\b(?:joules?|J)\s*$/i, unit: 'J' },
  { pattern: /(?:\bpercent(?:age)?|\bpct|%)\s*$/i, unit: '%' },
  { pattern: /\bratio\s*$/i, unit: 'ratio' },
];

function explicitClaimUnit(textAfterNumber: string): string | null {
  return CLAIM_UNIT_ALIASES.find(({ pattern }) => pattern.test(textAfterNumber))?.unit ?? null;
}

function explicitClaimPrefixUnit(textBeforeNumber: string): string | null {
  return (
    CLAIM_UNIT_PREFIX_ALIASES.find(({ pattern }) => pattern.test(textBeforeNumber))?.unit ?? null
  );
}

function extractNumericClaims(text: string): NumericClaim[] {
  return [...text.matchAll(NUMBER_PATTERN)]
    .map((match) => {
      const index = match.index ?? 0;
      const suffixUnit = explicitClaimUnit(text.slice(index + match[0].length));
      const prefixUnit = explicitClaimPrefixUnit(text.slice(0, index));
      return {
        value: Number(match[0]),
        unit:
          suffixUnit !== null && prefixUnit !== null && suffixUnit !== prefixUnit
            ? '__conflicting_unit__'
            : (suffixUnit ?? prefixUnit),
      };
    })
    .filter((claim) => Number.isFinite(claim.value));
}

function containsInvalidPlainDecimalToken(text: string): boolean {
  return [...text.matchAll(NUMBER_PATTERN)].some(
    (match) =>
      match[0].length > MAX_PLAIN_DECIMAL_TOKEN_CHARACTERS || !Number.isFinite(Number(match[0])),
  );
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

function containsUnsupportedContextClaim(text: string, payload: InsightPayload): boolean {
  const clauses = text.split(/[.!?;]+/);
  return clauses.some((clause) => {
    if (LIMITATION_LANGUAGE.test(clause)) return false;
    return Object.entries(CONTEXT_TERM_PATTERNS).some(
      ([field, pattern]) =>
        payload.context[field as keyof InsightPayload['context']] === 'not_available' &&
        pattern.test(clause),
    );
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesNumericObservation(text: string, label: string, unit: string): boolean {
  const unitGrammar = UNIT_GRAMMAR[unit];
  if (unitGrammar === undefined) return false;
  const valueAndUnit = `${APPROXIMATION_GRAMMAR}${PLAIN_DECIMAL_GRAMMAR}\\s*${unitGrammar}`;
  const unitAndValue = `${unitGrammar}\\s+${PLAIN_DECIMAL_GRAMMAR}`;
  return new RegExp(
    `^${escapeRegExp(label)} was (?:${valueAndUnit}|${unitAndValue})\\.$`,
    'i',
  ).test(text);
}

function matchesCompleteFindingGrammar(
  finding: InsightFinding,
  payload: InsightPayload,
  numericClaimCount: number,
): boolean {
  if (finding.evidence.length !== 1) return false;
  const evidenceId = finding.evidence[0]!;

  const metric = payload.metrics.find((candidate) => candidate.id === evidenceId);
  if (metric !== undefined) {
    const label = METRIC_EVIDENCE_LABELS[evidenceId];
    if (label === undefined) return false;
    if (metric.value === null) {
      return (
        numericClaimCount === 0 &&
        new RegExp(`^${escapeRegExp(label)} was not available\\.$`, 'i').test(finding.text)
      );
    }
    return numericClaimCount === 1 && matchesNumericObservation(finding.text, label, metric.unit);
  }

  const zone = (payload.zones ?? []).find(
    (candidate) => zoneMetricId(candidate.zone) === evidenceId,
  );
  if (zone === undefined) return false;
  const label = `Time in Zone ${zone.zone}`;
  return (
    numericClaimCount === 1 &&
    (matchesNumericObservation(finding.text, label, 'ratio') ||
      matchesNumericObservation(finding.text, label, '%'))
  );
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

  if (containsUnsupportedContextClaim(finding.text, payload)) {
    return { status: 'removed', reasonCode: 'unsupported_context_claim' };
  }

  if (
    UNSUPPORTED_NUMBER_WORD.test(finding.text) ||
    UNSUPPORTED_NUMBER_NOTATION.test(finding.text) ||
    containsInvalidPlainDecimalToken(finding.text)
  ) {
    return { status: 'flagged', reasonCode: 'unsupported_numeric_format' };
  }

  const citedEvidenceIds = new Set(finding.evidence);
  const facts = deriveFactsFromPayload(payload).filter((fact) =>
    citedEvidenceIds.has(fact.evidenceId),
  );
  const claimText = finding.text.replace(/^Time in Zone \d+\b/i, 'Time in Zone');
  const claims = extractNumericClaims(claimText);
  for (const claim of claims) {
    const matches = matchingFacts(claim, facts, options);
    if (matches.length === 0) {
      return { status: 'flagged', reasonCode: 'unsupported_numeric_value' };
    }
    if (claim.unit === null || !matches.some((fact) => fact.unit === claim.unit)) {
      return { status: 'flagged', reasonCode: 'unsupported_numeric_unit' };
    }
  }

  if (!matchesCompleteFindingGrammar(finding, payload, claims.length)) {
    return { status: 'removed', reasonCode: 'unsupported_qualitative_claim' };
  }

  return { status: 'valid', reasonCode: null };
}
