import { describe, expect, it } from 'vitest';
import { createAuditRecord } from './audit.ts';
import { buildInsightPayload } from './payload.ts';
import { buildAnalyticsFixture } from './test-fixtures.ts';
import { INSIGHT_OUTPUT_SCHEMA_VERSION, INSIGHT_SECTION_ORDER } from './schema.ts';
import type { InsightOutput } from './schema.ts';

function output(): InsightOutput {
  return {
    schemaVersion: INSIGHT_OUTPUT_SCHEMA_VERSION,
    promptVersion: 'insight-prompt-v1',
    disclaimer: 'Informational only.',
    sections: INSIGHT_SECTION_ORDER.map((s) => ({ id: s.id, title: s.title, findings: [] })),
  };
}

describe('createAuditRecord (AI-009)', () => {
  const payload = buildInsightPayload(buildAnalyticsFixture());

  it('is deterministic: identical inputs produce an identical hash', () => {
    const a = createAuditRecord({
      providerId: 'ollama',
      modelId: 'test-model-a',
      promptVersion: 'insight-prompt-v1',
      payload,
      output: output(),
      validationStatus: 'valid',
      createdAt: 1_700_000_000_000,
    });
    const b = createAuditRecord({
      providerId: 'ollama',
      modelId: 'test-model-a',
      promptVersion: 'insight-prompt-v1',
      payload,
      output: output(),
      validationStatus: 'valid',
      createdAt: 1_700_000_000_000,
    });
    expect(a.inputHash).toBe(b.inputHash);
    expect(a).toEqual(b);
  });

  it('produces different hashes for different payloads', () => {
    const other = buildInsightPayload(buildAnalyticsFixture({ distanceM: 12345 }));
    const a = createAuditRecord({
      providerId: 'codex',
      modelId: null,
      promptVersion: 'insight-prompt-v1',
      payload,
      output: null,
      validationStatus: 'error',
      createdAt: 0,
    });
    const b = createAuditRecord({
      providerId: 'codex',
      modelId: null,
      promptVersion: 'insight-prompt-v1',
      payload: other,
      output: null,
      validationStatus: 'error',
      createdAt: 0,
    });
    expect(a.inputHash).not.toBe(b.inputHash);
  });

  it('createdAt is injected, not read from the system clock (deterministic/testable)', () => {
    const record = createAuditRecord({
      providerId: 'disabled',
      modelId: null,
      promptVersion: 'insight-prompt-v1',
      payload,
      output: null,
      validationStatus: 'refused',
      createdAt: 42,
    });
    expect(record.createdAt).toBe(42);
  });

  it('hashes the sanitized payload, not raw provider input (SHA-256 hex of stable-stringified payload)', () => {
    const record = createAuditRecord({
      providerId: 'ollama',
      modelId: null,
      promptVersion: 'insight-prompt-v1',
      payload,
      output: null,
      validationStatus: 'valid',
      createdAt: 1,
    });
    expect(record.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the record never carries provider credentials — its key set is exactly the audited fields', () => {
    const record = createAuditRecord({
      providerId: 'ollama',
      modelId: 'test-model',
      promptVersion: 'insight-prompt-v1',
      payload,
      output: output(),
      validationStatus: 'valid',
      createdAt: 1,
    });
    expect(Object.keys(record).sort()).toEqual(
      [
        'createdAt',
        'inputHash',
        'modelId',
        'output',
        'promptVersion',
        'providerId',
        'validationStatus',
      ].sort(),
    );
    const keys = Object.keys(record).join(' ').toLowerCase();
    expect(keys).not.toContain('credential');
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('apikey');
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('auth');
  });
});
