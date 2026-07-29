import { describe, expect, it } from 'vitest';
import { disabledProvider } from './disabled.ts';

describe('disabledProvider (AI-001)', () => {
  it('reports destination none', () => {
    const description = disabledProvider.describe();
    expect(description.id).toBe('disabled');
    expect(description.destination).toBe('none');
  });

  it('reports itself unavailable with a stable reason code', () => {
    expect(disabledProvider.availability()).toEqual({
      available: false,
      reason: 'disabled_by_default',
    });
  });

  it('generate() resolves (never throws) with a typed refusal explaining AI is off', async () => {
    const result = await disabledProvider.generate({
      payload: {
        payloadVersion: 'insight-payload-v1',
        formulaVersion: 'analytics-v1',
        metrics: [],
        zones: null,
        unavailableMetricIds: [],
        context: {
          sleep: 'not_available',
          stress: 'not_available',
          nutrition: 'not_available',
          weather: 'not_available',
          soreness: 'not_available',
          goals: 'not_available',
          recovery: 'not_available',
        },
      },
      promptVersion: 'test-prompt-v1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ai_disabled');
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
