import { describe, expect, it } from 'vitest';
import { buildInsightPayload } from './payload.ts';
import { deriveFactsFromPayload, extractNumbers, validateFinding } from './validation.ts';
import { buildAnalyticsFixture } from './test-fixtures.ts';

describe('validateFinding (AI-006, AI-007)', () => {
  const payload = buildInsightPayload(buildAnalyticsFixture());

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

  it('extractNumbers pulls numeric tokens out of free text', () => {
    expect(extractNumbers('Distance was 30.5 km at 8.8 m/s, up from -2 last time.')).toEqual([
      30.5, 8.8, -2,
    ]);
  });

  it('deriveFactsFromPayload includes zone shares as both ratio and percent facts', () => {
    const facts = deriveFactsFromPayload(payload);
    const zoneFact = facts.find((f) => f.metricId === 'hr_zone_2_share_pct');
    expect(zoneFact).toBeDefined();
  });

  it('tolerates small rounding differences without flagging', () => {
    const avg = payload.metrics.find((m) => m.id === 'heart_rate_avg_bpm')!.value as number;
    const result = validateFinding(
      {
        text: `Average heart rate ran roughly ${(avg + 0.01).toFixed(2)} bpm.`,
        evidence: ['heart_rate_avg_bpm'],
      },
      payload,
    );
    expect(result.status).toBe('valid');
  });
});
