import { describe, expect, it } from 'vitest';
import { resolveProvider } from './registry.ts';
import { disabledProvider } from './providers/disabled.ts';
import { codexProvider } from './providers/codex.ts';
import { ollamaProvider } from './providers/ollama.ts';

describe('resolveProvider (AI-001)', () => {
  it('defaults to the disabled provider when called with no argument', () => {
    expect(resolveProvider()).toBe(disabledProvider);
  });

  it('defaults to disabled for null/undefined', () => {
    expect(resolveProvider(null)).toBe(disabledProvider);
    expect(resolveProvider(undefined)).toBe(disabledProvider);
  });

  it('defaults to disabled for an unrecognized id rather than failing open', () => {
    expect(resolveProvider('not-a-real-provider')).toBe(disabledProvider);
  });

  it('resolves known provider ids to their instances', () => {
    expect(resolveProvider('codex')).toBe(codexProvider);
    expect(resolveProvider('ollama')).toBe(ollamaProvider);
    expect(resolveProvider('disabled')).toBe(disabledProvider);
  });
});
