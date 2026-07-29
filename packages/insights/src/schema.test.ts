import { describe, expect, it } from 'vitest';
import {
  INSIGHT_OUTPUT_SCHEMA_VERSION,
  INSIGHT_SECTION_ORDER,
  validateInsightOutputShape,
} from './schema.ts';
import type { InsightOutput } from './schema.ts';

function validOutput(): InsightOutput {
  return {
    schemaVersion: INSIGHT_OUTPUT_SCHEMA_VERSION,
    promptVersion: 'insight-prompt-v1',
    disclaimer: 'Informational only, not medical advice.',
    sections: INSIGHT_SECTION_ORDER.map((s) => ({
      id: s.id,
      title: s.title,
      findings: [{ text: 'Average speed was steady across the ride.', evidence: ['avg_speed_ms'] }],
    })),
  };
}

describe('validateInsightOutputShape (AI-005)', () => {
  it('accepts a well-formed output with all eight sections in order', () => {
    expect(validateInsightOutputShape(validOutput())).toEqual({ valid: true, errors: [] });
  });

  it('covers the eight PRD sections in the documented order', () => {
    expect(INSIGHT_SECTION_ORDER.map((s) => s.id)).toEqual([
      'ride_execution',
      'heart_rate_dynamics',
      'comparative_conditioning',
      'strengths',
      'fatigue_indicators',
      'training_considerations',
      'data_limitations',
      'bottom_line',
    ]);
  });

  it('rejects non-object input', () => {
    expect(validateInsightOutputShape(null).valid).toBe(false);
    expect(validateInsightOutputShape('nope').valid).toBe(false);
  });

  it('rejects a schema version mismatch', () => {
    const bad = { ...validOutput(), schemaVersion: 'insight-output-v0' };
    const result = validateInsightOutputShape(bad);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('schema_version_mismatch');
  });

  it('rejects sections out of order', () => {
    const output = validOutput();
    const reordered = { ...output, sections: [...output.sections].reverse() };
    const result = validateInsightOutputShape(reordered);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('id_mismatch'))).toBe(true);
  });

  it('rejects a missing section', () => {
    const output = validOutput();
    const truncated = { ...output, sections: output.sections.slice(0, 7) };
    const result = validateInsightOutputShape(truncated);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('section_count_mismatch');
  });

  it('rejects a finding with no evidence', () => {
    const output = validOutput();
    output.sections[0]!.findings = [{ text: 'Unsupported claim.', evidence: [] }];
    const result = validateInsightOutputShape(output);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid_evidence'))).toBe(true);
  });

  it('error codes never include finding text (value-free)', () => {
    const output = validOutput();
    output.sections[0]!.findings = [{ text: 'SECRET_CANARY_TEXT', evidence: [] }];
    const result = validateInsightOutputShape(output);
    expect(result.errors.join(' ')).not.toContain('SECRET_CANARY_TEXT');
  });
});
