/**
 * Versioned structured-output contract for AI insight generation (AI-005).
 * The eight sections below are fixed, ordered, and required — this mirrors
 * PRD §8.5's default insight structure. No ajv: `validateInsightOutputShape`
 * is a small hand-rolled structural validator (errors are value-free
 * location codes, never the offending content).
 */

export const INSIGHT_OUTPUT_SCHEMA_VERSION = 'insight-output-v1';

export type InsightSectionId =
  | 'ride_execution'
  | 'heart_rate_dynamics'
  | 'comparative_conditioning'
  | 'strengths'
  | 'fatigue_indicators'
  | 'training_considerations'
  | 'data_limitations'
  | 'bottom_line';

export interface InsightSectionSpec {
  id: InsightSectionId;
  title: string;
}

/** Fixed PRD §8.5 order. Output sections must appear in exactly this order. */
export const INSIGHT_SECTION_ORDER: readonly InsightSectionSpec[] = [
  { id: 'ride_execution', title: 'Ride execution' },
  { id: 'heart_rate_dynamics', title: 'Heart-rate dynamics and recovery' },
  { id: 'comparative_conditioning', title: 'Comparative conditioning signal' },
  { id: 'strengths', title: 'Strengths' },
  { id: 'fatigue_indicators', title: 'Fatigue indicators' },
  { id: 'training_considerations', title: 'Training considerations' },
  { id: 'data_limitations', title: 'Data limitations' },
  { id: 'bottom_line', title: 'Bottom line' },
] as const;

export interface InsightFinding {
  text: string;
  /** Deterministic metric IDs (from the payload) this finding is grounded in (AI-007). */
  evidence: string[];
}

export interface InsightSection {
  id: InsightSectionId;
  title: string;
  findings: InsightFinding[];
}

export interface InsightOutput {
  schemaVersion: typeof INSIGHT_OUTPUT_SCHEMA_VERSION;
  promptVersion: string;
  sections: InsightSection[];
  disclaimer: string;
}

const SECTION_ID_ENUM = INSIGHT_SECTION_ORDER.map((s) => s.id);

/** Plain-object JSON Schema, exported for documentation/tooling — not evaluated by ajv. */
export const INSIGHT_OUTPUT_JSON_SCHEMA = {
  $id: 'https://velograph.local/schema/insight-output-v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'promptVersion', 'sections', 'disclaimer'],
  properties: {
    schemaVersion: { const: INSIGHT_OUTPUT_SCHEMA_VERSION },
    promptVersion: { type: 'string', minLength: 1 },
    disclaimer: { type: 'string', minLength: 1 },
    sections: {
      type: 'array',
      minItems: INSIGHT_SECTION_ORDER.length,
      maxItems: INSIGHT_SECTION_ORDER.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'findings'],
        properties: {
          id: { enum: SECTION_ID_ENUM },
          title: { type: 'string', minLength: 1 },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'evidence'],
              properties: {
                text: { type: 'string', minLength: 1 },
                evidence: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface SchemaValidationResult {
  valid: boolean;
  /** Value-free structural error codes, e.g. "section_2_id_mismatch" — never finding content. */
  errors: string[];
}

const ROOT_KEYS = new Set(['schemaVersion', 'promptVersion', 'sections', 'disclaimer']);
const SECTION_KEYS = new Set(['id', 'title', 'findings']);
const FINDING_KEYS = new Set(['text', 'evidence']);

function hasUnexpectedKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

/** Hand-rolled structural validator matching INSIGHT_OUTPUT_JSON_SCHEMA (no ajv dependency). */
export function validateInsightOutputShape(value: unknown): SchemaValidationResult {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return { valid: false, errors: ['root_not_object'] };
  }
  const root = value as Record<string, unknown>;

  if (hasUnexpectedKey(root, ROOT_KEYS)) errors.push('root_unexpected_property');
  if (root['schemaVersion'] !== INSIGHT_OUTPUT_SCHEMA_VERSION)
    errors.push('schema_version_mismatch');
  if (typeof root['promptVersion'] !== 'string' || root['promptVersion'].length === 0) {
    errors.push('missing_prompt_version');
  }
  if (typeof root['disclaimer'] !== 'string' || root['disclaimer'].length === 0) {
    errors.push('missing_disclaimer');
  }

  const sections = root['sections'];
  if (!Array.isArray(sections)) {
    errors.push('sections_not_array');
    return { valid: false, errors };
  }
  if (sections.length !== INSIGHT_SECTION_ORDER.length) {
    errors.push('section_count_mismatch');
  }

  sections.forEach((rawSection, i) => {
    const expected = INSIGHT_SECTION_ORDER[i];
    if (typeof rawSection !== 'object' || rawSection === null) {
      errors.push(`section_${i}_not_object`);
      return;
    }
    const section = rawSection as Record<string, unknown>;
    if (!expected) {
      errors.push(`section_${i}_unexpected`);
      return;
    }
    if (hasUnexpectedKey(section, SECTION_KEYS)) {
      errors.push(`section_${i}_unexpected_property`);
    }
    if (section['id'] !== expected.id) errors.push(`section_${i}_id_mismatch`);
    if (typeof section['title'] !== 'string' || section['title'].length === 0) {
      errors.push(`section_${i}_missing_title`);
    }
    const findings = section['findings'];
    if (!Array.isArray(findings)) {
      errors.push(`section_${i}_findings_not_array`);
      return;
    }
    findings.forEach((rawFinding, j) => {
      if (typeof rawFinding !== 'object' || rawFinding === null) {
        errors.push(`section_${i}_finding_${j}_not_object`);
        return;
      }
      const finding = rawFinding as Record<string, unknown>;
      if (hasUnexpectedKey(finding, FINDING_KEYS)) {
        errors.push(`section_${i}_finding_${j}_unexpected_property`);
      }
      if (typeof finding['text'] !== 'string' || finding['text'].length === 0) {
        errors.push(`section_${i}_finding_${j}_missing_text`);
      }
      const evidence = finding['evidence'];
      const evidenceValid =
        Array.isArray(evidence) &&
        evidence.length > 0 &&
        evidence.every((e) => typeof e === 'string' && e.length > 0);
      if (!evidenceValid) errors.push(`section_${i}_finding_${j}_invalid_evidence`);
    });
  });

  return { valid: errors.length === 0, errors };
}
