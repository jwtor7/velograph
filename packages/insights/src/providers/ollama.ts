import { ProviderNotImplementedError } from '../errors.ts';
import type { InsightProvider } from '../types.ts';

/**
 * Ollama provider — STUB (Phase 3). Deliberately does not open any HTTP
 * connection, not even to the loopback Ollama endpoint. This module
 * imports nothing beyond its own sibling files; see ollama.test.ts for a
 * contract test asserting that stays true.
 */
export const ollamaProvider: InsightProvider = {
  id: 'ollama',
  describe() {
    return {
      id: 'ollama',
      name: 'Ollama (local)',
      destination: 'local-loopback',
      destinationDetail:
        'Local loopback only. When implemented, the minimized payload would be sent to a ' +
        'user-configured local Ollama endpoint. Not yet implemented.',
    };
  },
  availability() {
    return { available: false, reason: 'not_implemented' };
  },
  async generate() {
    throw new ProviderNotImplementedError('ollama');
  },
};
