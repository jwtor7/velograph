import type { InsightPayload } from './payload.ts';
import type { InsightOutput } from './schema.ts';

/**
 * Provider interface (AI-002). `disabled` is fully implemented and is the
 * default (AI-001). `codex` and `ollama` are stubs in this phase: no
 * network call, no child-process spawn, no filesystem probing for a binary,
 * no credential access — see packages/insights/src/providers/.
 */
export type ProviderId = 'codex' | 'ollama' | 'disabled';

/** Where the minimized payload would travel if this provider ran. */
export type DestinationKind = 'none' | 'local-loopback' | 'remote';

export interface ProviderDescription {
  id: ProviderId;
  /** Human-readable provider name for UI display. */
  name: string;
  destination: DestinationKind;
  /** One-sentence, human-readable explanation of the destination classification. */
  destinationDetail: string;
}

export type AvailabilityReason =
  'disabled_by_default' | 'not_implemented' | 'not_configured' | 'unreachable';

export type AvailabilityResult =
  { available: true } | { available: false; reason: AvailabilityReason };

export interface GenerateRequest {
  payload: InsightPayload;
  promptVersion: string;
}

export type RefusalReasonCode = 'ai_disabled';

export interface GenerateRefusal {
  ok: false;
  reason: RefusalReasonCode;
  message: string;
}

export interface GenerateSuccess {
  ok: true;
  output: InsightOutput;
  /** Model-reported identifier, when the provider supplies one (AI-009). */
  modelId: string | null;
}

export type GenerateResult = GenerateSuccess | GenerateRefusal;

export interface InsightProvider {
  readonly id: ProviderId;
  describe(): ProviderDescription;
  availability(): AvailabilityResult;
  /**
   * Disabled resolves to a typed refusal (never throws). Unimplemented
   * providers (codex, ollama) reject with `ProviderNotImplementedError`.
   */
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
