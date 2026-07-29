import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codexProvider } from './codex.ts';
import { ProviderNotImplementedError } from '../errors.ts';

describe('codexProvider (stub, AI-002/AI-012)', () => {
  it('reports remote destination and not_implemented availability without probing anything', () => {
    const description = codexProvider.describe();
    expect(description.destination).toBe('remote');
    expect(codexProvider.availability()).toEqual({ available: false, reason: 'not_implemented' });
  });

  it('generate() rejects with a typed ProviderNotImplementedError', async () => {
    await expect(
      codexProvider.generate({
        payload: {
          payloadVersion: 'insight-payload-v1',
          formulaVersion: 'analytics-v1',
          metrics: [],
          zones: null,
          unavailableMetricIds: [],
          context: {
            sleep: 'not_available',
            stress: 'not_available',
            nutrition: 'not_available',
            weather: 'not_available',
            soreness: 'not_available',
            goals: 'not_available',
            recovery: 'not_available',
          },
        },
        promptVersion: 'test-prompt-v1',
      }),
    ).rejects.toBeInstanceOf(ProviderNotImplementedError);
  });

  it('does not import filesystem, child-process, or network modules (no binary probing, no exec)', () => {
    const path = fileURLToPath(new URL('./codex.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    for (const forbidden of [
      'node:fs',
      'node:child_process',
      'node:http',
      'node:https',
      'fetch(',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
