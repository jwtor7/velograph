import { disabledProvider } from './providers/disabled.ts';
import { codexProvider } from './providers/codex.ts';
import { ollamaProvider } from './providers/ollama.ts';
import type { InsightProvider, ProviderId } from './types.ts';

const PROVIDERS: Record<ProviderId, InsightProvider> = {
  disabled: disabledProvider,
  codex: codexProvider,
  ollama: ollamaProvider,
};

function isProviderId(id: string): id is ProviderId {
  return id === 'disabled' || id === 'codex' || id === 'ollama';
}

/**
 * Resolves a provider id to its instance, defaulting to `disabled` (AI-001)
 * for `undefined`/`null`/unrecognized ids — AI is opt-in, never fails open
 * into an unknown provider. Accepts a loose string since provider ids are
 * often round-tripped through persisted settings/JSON.
 */
export function resolveProvider(id?: string | null): InsightProvider {
  if (id != null && isProviderId(id)) return PROVIDERS[id];
  return PROVIDERS.disabled;
}

export const ALL_PROVIDER_IDS: readonly ProviderId[] = ['disabled', 'codex', 'ollama'];
