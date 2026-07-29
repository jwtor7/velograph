import type { ProviderId } from './types.ts';

/**
 * Thrown by stub providers (`codex`, `ollama`) — no parameter properties
 * (erasable-syntax constraint), so the field is assigned in the body.
 */
export class ProviderNotImplementedError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super(`Provider "${providerId}" is not implemented yet (Phase 3 stub).`);
    this.name = 'ProviderNotImplementedError';
    this.providerId = providerId;
  }
}
