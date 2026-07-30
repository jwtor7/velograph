import type { InsightPayload } from './payload.ts';
import type { InsightOutput } from './schema.ts';

/**
 * Provider interface (AI-002). `disabled` is fully implemented and is the
 * default (AI-001). Provider implementations must route model output through
 * the shared all-or-nothing orchestrator before returning it.
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
  /** Cancels provider I/O/process work and discards any partial output. */
  signal?: AbortSignal;
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
   * Disabled resolves to a typed refusal (never throws). Configured providers
   * either return a fully validated output or reject with an
   * `InsightGenerationError`; partial/unvalidated model output is never
   * returned.
   */
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
