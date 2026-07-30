import type { ProviderId } from './types.ts';

export type InsightGenerationErrorCode =
  | 'invalid_request'
  | 'generation_cancelled'
  | 'prompt_too_large'
  | 'provider_not_configured'
  | 'provider_unreachable'
  | 'provider_timeout'
  | 'provider_output_too_large'
  | 'provider_response_invalid'
  | 'provider_model_unavailable'
  | 'provider_failed'
  | 'provider_cleanup_failed'
  | 'output_parse_failed'
  | 'output_schema_invalid'
  | 'output_prompt_version_mismatch'
  | 'output_disclaimer_invalid'
  | 'output_finding_invalid';

const ERROR_MESSAGES: Record<InsightGenerationErrorCode, string> = {
  invalid_request: 'The insight generation request is invalid.',
  generation_cancelled: 'Insight generation was cancelled.',
  prompt_too_large: 'The minimized insight prompt exceeds the allowed size.',
  provider_not_configured: 'The selected insight provider is not configured.',
  provider_unreachable: 'The selected insight provider is unavailable.',
  provider_timeout: 'The selected insight provider timed out.',
  provider_output_too_large: 'The selected insight provider returned too much data.',
  provider_response_invalid: 'The selected insight provider returned an invalid response.',
  provider_model_unavailable: 'The configured insight model is not installed or available.',
  provider_failed: 'The selected insight provider failed.',
  provider_cleanup_failed: 'The insight provider could not securely clean up temporary output.',
  output_parse_failed: 'The insight provider did not return one valid JSON object.',
  output_schema_invalid: 'The insight provider output failed schema validation.',
  output_prompt_version_mismatch: 'The insight provider output used the wrong prompt version.',
  output_disclaimer_invalid: 'The insight provider output omitted the required safety disclaimer.',
  output_finding_invalid: 'The insight provider output contained an unsupported finding.',
};

const PROVIDER_BOUNDARY_CODES = new Set<InsightGenerationErrorCode>([
  'generation_cancelled',
  'prompt_too_large',
  'provider_not_configured',
  'provider_unreachable',
  'provider_timeout',
  'provider_output_too_large',
  'provider_response_invalid',
  'provider_model_unavailable',
  'provider_failed',
  'provider_cleanup_failed',
]);

/**
 * Stable, value-free error surfaced by provider and validation boundaries.
 * `diagnostics` may contain only stable validation reason codes; it must
 * never contain provider output, prompts, metric values, paths, or stderr.
 */
export class InsightGenerationError extends Error {
  readonly code: InsightGenerationErrorCode;
  readonly providerId: ProviderId | null;
  readonly diagnostics: readonly string[];

  constructor(
    code: InsightGenerationErrorCode,
    providerId: ProviderId | null = null,
    diagnostics: readonly string[] = [],
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'InsightGenerationError';
    this.code = code;
    this.providerId = providerId;
    this.diagnostics = [...diagnostics];
  }
}

/**
 * Rebuilds an error crossing an injected provider/runtime boundary. This
 * drops untrusted messages, provider IDs, subclasses, and diagnostics.
 */
export function stableProviderError(
  error: unknown,
  providerId: ProviderId,
): InsightGenerationError {
  if (
    error instanceof InsightGenerationError &&
    PROVIDER_BOUNDARY_CODES.has(error.code as InsightGenerationErrorCode)
  ) {
    return new InsightGenerationError(error.code as InsightGenerationErrorCode, providerId);
  }
  return new InsightGenerationError('provider_failed', providerId);
}

/**
 * Kept for source compatibility with the earlier provider-stub API. Runtime
 * providers no longer throw this error.
 */
export class ProviderNotImplementedError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super(`Provider "${providerId}" is not implemented yet (Phase 3 stub).`);
    this.name = 'ProviderNotImplementedError';
    this.providerId = providerId;
  }
}
