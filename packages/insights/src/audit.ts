import { sha256Hex, stableStringify } from '@velograph/shared';
import type { InsightPayload } from './payload.ts';
import type { InsightOutput } from './schema.ts';
import type { ProviderId } from './types.ts';

/**
 * Local audit record (AI-009): provider, model-reported identifier, prompt
 * version, SHA-256 input hash, output, validation status, and creation
 * time. Deliberately has no field for provider credentials — see
 * audit.test.ts, which asserts the record's key set contains nothing
 * credential-shaped.
 */

export type AuditValidationStatus = 'valid' | 'flagged' | 'removed' | 'refused' | 'error';

export interface InsightAuditRecord {
  providerId: ProviderId;
  /** Model-reported identifier, when the provider supplies one; null otherwise. */
  modelId: string | null;
  promptVersion: string;
  /** SHA-256 hex of the stable-stringified sanitized payload (never raw provider input). */
  inputHash: string;
  output: InsightOutput | null;
  validationStatus: AuditValidationStatus;
  /** Epoch ms, injected by the caller — kept out of this pure function for determinism/testability. */
  createdAt: number;
}

export interface CreateAuditRecordParams {
  providerId: ProviderId;
  modelId: string | null;
  promptVersion: string;
  payload: InsightPayload;
  output: InsightOutput | null;
  validationStatus: AuditValidationStatus;
  createdAt: number;
}

/** Pure constructor: same inputs always produce the same record, including hash. */
export function createAuditRecord(params: CreateAuditRecordParams): InsightAuditRecord {
  return {
    providerId: params.providerId,
    modelId: params.modelId,
    promptVersion: params.promptVersion,
    inputHash: sha256Hex(stableStringify(params.payload)),
    output: params.output,
    validationStatus: params.validationStatus,
    createdAt: params.createdAt,
  };
}
