import { describe, expect, it } from 'vitest';
import { buildInsightPayload } from './payload.ts';
import {
  deriveFactsFromPayload,
  extractNumbers,
  METRIC_EVIDENCE_LABELS,
  validateFinding,
} from './validation.ts';
import { buildAnalyticsFixture } from './test-fixtures.ts';

describe('validateFinding (AI-006, AI-007)', () => {
  const payload = buildInsightPayload(buildAnalyticsFixture());

  it('keeps the complete-grammar label map immutable at runtime', () => {
    expect(Object.isFrozen(METRIC_EVIDENCE_LABELS)).toBe(true);
  });

  it('marks a well-grounded, numerically-supported finding valid', () => {
    const result = validateFinding(
      {
        text: `Average heart rate was about ${payload.metrics.find((m) => m.id === 'heart_rate_avg_bpm')!.value} bpm.`,
        evidence: ['heart_rate_avg_bpm'],
      },
      payload,
    );
    expect(result).toEqual({ status: 'valid', reasonCode: null });
  });

  it('removes a finding with no evidence at all (AI-007)', () => {
    const result = validateFinding({ text: 'The ride went well.', evidence: [] }, payload);
    expect(result.status).toBe('removed');
    expect(result.reasonCode).toBe('no_evidence');
  });

  it('removes a finding citing a fabricated metric ID not present in the payload (AI-007)', () => {
    const result = validateFinding(
      { text: 'Ride was strong.', evidence: ['made_up_metric_that_does_not_exist'] },
      payload,
    );
    expect(result.status).toBe('removed');
    expect(result.reasonCode).toBe('unknown_evidence_metric');
    // Reason codes must never echo the offending value.
    expect(result.reasonCode).not.toContain('made_up_metric_that_does_not_exist');
  });

  it('flags a finding whose numeric claim matches no supplied fact (AI-006)', () => {
    const result = validateFinding(
      { text: 'Average speed reached an implausible 999.9 units.', evidence: ['avg_speed_ms'] },
      payload,
    );
    expect(result.status).toBe('flagged');
    expect(result.reasonCode).toBe('unsupported_numeric_value');
    // Value-free: reason code carries no trace of "999.9".
    expect(result.reasonCode).not.toContain('999');
  });

  it('removes a finding using diagnostic phrasing (AI-011)', () => {
    const result = validateFinding(
      { text: 'You have a cardiac disease based on this ride.', evidence: ['heart_rate_avg_bpm'] },
      payload,
    );
    expect(result.status).toBe('removed');
    expect(result.reasonCode).toBe('diagnostic_phrasing');
  });

  it('removes positive claims about context explicitly marked unavailable', () => {
    expect(
      validateFinding(
        {
          text: 'Excellent sleep explains the pacing pattern.',
          evidence: ['pacing_variability_ratio'],
        },
        payload,
      ),
    ).toEqual({
      status: 'removed',
      reasonCode: 'unsupported_context_claim',
    });
  });

  it('fails closed on free-form context limitations that cannot use the metric grammar', () => {
    expect(
      validateFinding(
        {
          text: 'Sleep context was not available.',
          evidence: ['pacing_variability_ratio'],
        },
        payload,
      ),
    ).toEqual({
      status: 'removed',
      reasonCode: 'unsupported_qualitative_claim',
    });
  });

  it('removes qualitative claims that are not explicitly grounded to a cited numeric fact', () => {
    expect(
      validateFinding(
        {
          text: 'The rider is elite.',
          evidence: ['heart_rate_avg_bpm'],
        },
        payload,
      ),
    ).toEqual({
      status: 'removed',
      reasonCode: 'unsupported_qualitative_claim',
    });
    expect(
      validateFinding(
        {
          text: 'Average heart rate was 142.5 bpm, and the rider is elite.',
          evidence: ['heart_rate_avg_bpm'],
        },
        payload,
      ),
    ).toEqual({
      status: 'removed',
      reasonCode: 'unsupported_qualitative_claim',
    });
  });

  it.each([
    'Average heart rate was 142.5 bpm suggesting cancer.',
    'Sleep was not available yet average heart rate was 142.5 bpm suggesting cancer.',
    'Average heart rate was an excellent 142.5 bpm.',
  ])('rejects unsupported prose outside the complete finding grammar: %s', (text) => {
    expect(
      validateFinding(
        {
          text,
          evidence: ['heart_rate_avg_bpm'],
        },
        payload,
      ),
    ).toEqual({
      status: 'removed',
      reasonCode: 'unsupported_qualitative_claim',
    });
  });

  it('accepts only the exact limitation grammar for a cited null metric', () => {
    const unavailablePayload = {
      ...payload,
      metrics: payload.metrics.map((metric) =>
        metric.id === 'heart_rate_avg_bpm' ? { ...metric, value: null } : metric,
      ),
      unavailableMetricIds: ['heart_rate_avg_bpm'],
    };
    expect(
      validateFinding(
        {
          text: 'Average heart rate was not available.',
          evidence: ['heart_rate_avg_bpm'],
        },
        unavailablePayload,
      ),
    ).toEqual({ status: 'valid', reasonCode: null });
  });

  it('rejects findings that cite more than one metric', () => {
    expect(
      validateFinding(
        {
          text: 'Average heart rate was 142.5 bpm.',
          evidence: ['heart_rate_avg_bpm', 'heart_rate_max_bpm'],
        },
        payload,
      ),
    ).toEqual({
      status: 'removed',
      reasonCode: 'unsupported_qualitative_claim',
    });
  });

  it('extractNumbers pulls numeric tokens out of free text', () => {
    expect(extractNumbers('Distance was 30.5 km at 8.8 m/s, up from -2 last time.')).toEqual([
      30.5, 8.8, -2,
    ]);
  });

  it('deriveFactsFromPayload includes zone shares as both ratio and percent facts', () => {
    const facts = deriveFactsFromPayload(payload);
    const zoneFacts = facts.filter((f) => f.evidenceId === 'hr_zone_2_share');
    expect(zoneFacts.map((fact) => fact.representation)).toEqual(['payload', 'percent']);
  });

  it('tolerates small rounding differences without flagging', () => {
    const avg = payload.metrics.find((m) => m.id === 'heart_rate_avg_bpm')!.value as number;
    const result = validateFinding(
      {
        text: `Average heart rate was roughly ${(avg + 0.01).toFixed(2)} bpm.`,
        evidence: ['heart_rate_avg_bpm'],
      },
      payload,
    );
    expect(result.status).toBe('valid');
  });

  it('does not support a number from an unrelated uncited metric', () => {
    const duration = payload.metrics.find((metric) => metric.id === 'duration_s')!.value;
    const result = validateFinding(
      {
        text: `Maximum heart rate was ${duration} bpm.`,
        evidence: ['heart_rate_max_bpm'],
      },
      payload,
    );
    expect(result).toEqual({
      status: 'flagged',
      reasonCode: 'unsupported_numeric_value',
    });
  });

  it('keeps equal-valued metrics isolated by cited evidence ID', () => {
    const collidingPayload = {
      ...payload,
      metrics: payload.metrics.map((metric) =>
        metric.id === 'duration_s' || metric.id === 'heart_rate_max_bpm'
          ? { ...metric, value: 180 }
          : metric,
      ),
    };
    const supported = validateFinding(
      {
        text: 'Maximum heart rate was 180 bpm.',
        evidence: ['heart_rate_max_bpm'],
      },
      collidingPayload,
    );
    const unrelated = validateFinding(
      {
        text: 'Average speed was 180 m/s.',
        evidence: ['avg_speed_ms'],
      },
      collidingPayload,
    );
    expect(supported).toEqual({ status: 'valid', reasonCode: null });
    expect(unrelated).toEqual({
      status: 'flagged',
      reasonCode: 'unsupported_numeric_value',
    });
  });

  it('rejects an equal numeric value labelled with the wrong unit', () => {
    const collidingPayload = {
      ...payload,
      metrics: payload.metrics.map((metric) =>
        metric.id === 'duration_s' || metric.id === 'heart_rate_max_bpm'
          ? { ...metric, value: 180 }
          : metric,
      ),
    };
    const result = validateFinding(
      {
        text: 'Maximum heart rate was 180 seconds.',
        evidence: ['heart_rate_max_bpm'],
      },
      collidingPayload,
    );
    expect(result).toEqual({
      status: 'flagged',
      reasonCode: 'unsupported_numeric_unit',
    });
    expect(result.reasonCode).not.toContain('180');
    expect(result.reasonCode).not.toContain('seconds');
  });

  it('keeps textual unit aliases tied to the cited metric unit', () => {
    const maximum = payload.metrics.find((metric) => metric.id === 'heart_rate_max_bpm')!
      .value as number;
    expect(
      validateFinding(
        {
          text: `Maximum heart rate was ${maximum} beats per minute.`,
          evidence: ['heart_rate_max_bpm'],
        },
        payload,
      ),
    ).toEqual({ status: 'valid', reasonCode: null });
    expect(
      validateFinding(
        {
          text: `Maximum heart rate was ${maximum} metres.`,
          evidence: ['heart_rate_max_bpm'],
        },
        payload,
      ),
    ).toEqual({
      status: 'flagged',
      reasonCode: 'unsupported_numeric_unit',
    });
  });

  it('requires every supported numeric claim to name its unit', () => {
    const maximum = payload.metrics.find((metric) => metric.id === 'heart_rate_max_bpm')!
      .value as number;
    expect(
      validateFinding(
        {
          text: `Maximum heart rate was ${maximum}.`,
          evidence: ['heart_rate_max_bpm'],
        },
        payload,
      ),
    ).toEqual({
      status: 'flagged',
      reasonCode: 'unsupported_numeric_unit',
    });
  });

  it('validates units written before a number and rejects conflicting prefix/suffix units', () => {
    const maximum = payload.metrics.find((metric) => metric.id === 'heart_rate_max_bpm')!
      .value as number;
    expect(
      validateFinding(
        {
          text: `Maximum heart rate was bpm ${maximum}.`,
          evidence: ['heart_rate_max_bpm'],
        },
        payload,
      ),
    ).toEqual({ status: 'valid', reasonCode: null });
    expect(
      validateFinding(
        {
          text: `Maximum heart rate was seconds ${maximum} bpm.`,
          evidence: ['heart_rate_max_bpm'],
        },
        payload,
      ),
    ).toEqual({
      status: 'flagged',
      reasonCode: 'unsupported_numeric_unit',
    });
  });

  it.each([
    'Average heart rate was one hundred forty-two bpm.',
    'Pacing variability was .12 ratio.',
    'Average heart rate was 1.425e2 bpm.',
    'Distance was 30,000 m.',
    'Zone share was 1/2 ratio.',
  ])('rejects non-canonical numeric notation: %s', (text) => {
    const evidence = text.startsWith('Distance')
      ? ['distance_m']
      : text.startsWith('Pacing')
        ? ['pacing_variability_ratio']
        : text.startsWith('Zone')
          ? ['hr_zone_2_share']
          : ['heart_rate_avg_bpm'];
    expect(validateFinding({ text, evidence }, payload)).toEqual({
      status: 'flagged',
      reasonCode: 'unsupported_numeric_format',
    });
  });

  it('rejects oversized positive and negative plain-decimal tokens', () => {
    const oversized = '9'.repeat(400);
    for (const token of [oversized, `-${oversized}`]) {
      expect(
        validateFinding(
          {
            text: `Average heart rate was ${token} bpm.`,
            evidence: ['heart_rate_avg_bpm'],
          },
          payload,
        ),
      ).toEqual({
        status: 'flagged',
        reasonCode: 'unsupported_numeric_format',
      });
    }
  });

  it('accepts an explicitly represented zone share percentage only when that zone is cited', () => {
    const zone = payload.zones?.[1];
    expect(zone).toBeDefined();
    const percent = (zone!.shareOfTime * 100).toFixed(1);
    expect(
      validateFinding(
        {
          text: `Time in Zone ${zone!.zone} was ${percent}%.`,
          evidence: [`hr_zone_${zone!.zone}_share`],
        },
        payload,
      ),
    ).toEqual({ status: 'valid', reasonCode: null });
    expect(
      validateFinding(
        {
          text: `Time in Zone ${zone!.zone} was ${percent}%.`,
          evidence: ['hr_zone_1_share'],
        },
        payload,
      ),
    ).toEqual({
      status: 'flagged',
      reasonCode: 'unsupported_numeric_value',
    });
  });
});
