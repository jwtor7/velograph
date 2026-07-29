import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ollamaProvider } from './ollama.ts';
import { ProviderNotImplementedError } from '../errors.ts';

describe('ollamaProvider (stub, AI-002/AI-012)', () => {
  it('reports local-loopback destination and not_implemented availability', () => {
    const description = ollamaProvider.describe();
    expect(description.destination).toBe('local-loopback');
    expect(ollamaProvider.availability()).toEqual({ available: false, reason: 'not_implemented' });
  });

  it('generate() rejects with a typed ProviderNotImplementedError', async () => {
    await expect(
      ollamaProvider.generate({
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

  it('does not open any HTTP connection, not even to loopback', () => {
    const path = fileURLToPath(new URL('./ollama.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    for (const forbidden of [
      'node:http',
      'node:https',
      'fetch(',
      'node:fs',
      'node:child_process',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
