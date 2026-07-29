import { ProviderNotImplementedError } from '../errors.ts';
import type { InsightProvider } from '../types.ts';

/**
 * Codex CLI provider — STUB (Phase 3). Deliberately does not: probe the
 * filesystem for a `codex` binary, spawn a child process, invoke
 * `codex exec`, or read/copy/log any credential/auth cache. This module
 * imports nothing beyond its own sibling files; see codex.test.ts for a
 * contract test asserting that stays true.
 */
export const codexProvider: InsightProvider = {
  id: 'codex',
  describe() {
    return {
      id: 'codex',
      name: 'Codex CLI (OpenAI)',
      destination: 'remote',
      destinationDetail:
        'Remote provider. When implemented, the minimized payload would be sent to OpenAI via ' +
        'the local Codex CLI. Not yet implemented.',
    };
  },
  availability() {
    return { available: false, reason: 'not_implemented' };
  },
  async generate() {
    throw new ProviderNotImplementedError('codex');
  },
};
