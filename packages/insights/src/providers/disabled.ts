import type { GenerateRefusal, InsightProvider } from '../types.ts';

/**
 * The default provider (AI-001). Fully implemented: it never contacts
 * anything and always resolves with a typed refusal explaining AI is off.
 */
const REFUSAL: GenerateRefusal = {
  ok: false,
  reason: 'ai_disabled',
  message:
    'AI insight generation is disabled. Enable a provider in settings to generate narrative ' +
    'insights — import, analytics, comparison, and visualization all work fully without it.',
};

export const disabledProvider: InsightProvider = {
  id: 'disabled',
  describe() {
    return {
      id: 'disabled',
      name: 'Disabled',
      destination: 'none',
      destinationDetail: 'AI is turned off. No data leaves this machine.',
    };
  },
  availability() {
    return { available: false, reason: 'disabled_by_default' };
  },
  async generate() {
    return REFUSAL;
  },
};
