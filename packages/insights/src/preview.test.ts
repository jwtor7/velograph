import { describe, expect, it } from 'vitest';
import { buildInsightPayload } from './payload.ts';
import { POLICY_VERSION, renderPayloadPreview } from './preview.ts';
import { buildAnalyticsFixture } from './test-fixtures.ts';

describe('renderPayloadPreview (AI-004)', () => {
  const payload = buildInsightPayload(buildAnalyticsFixture());

  it('names the destination and policy version', () => {
    const text = renderPayloadPreview(payload, 'remote');
    expect(text).toContain(POLICY_VERSION);
    expect(text).toContain('Remote provider');
  });

  it('lists every metric id included in the payload', () => {
    const text = renderPayloadPreview(payload, 'none');
    for (const metric of payload.metrics) {
      expect(text).toContain(metric.id);
    }
  });

  it('states what is never sent', () => {
    const text = renderPayloadPreview(payload, 'local-loopback');
    expect(text.toLowerCase()).toContain('not sent');
    expect(text.toLowerCase()).toContain('coordinates');
  });

  it('is pure — identical payload and destination produce identical text', () => {
    const a = renderPayloadPreview(payload, 'remote');
    const b = renderPayloadPreview(payload, 'remote');
    expect(a).toBe(b);
  });
});
