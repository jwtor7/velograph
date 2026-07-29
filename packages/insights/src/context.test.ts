import { describe, expect, it } from 'vitest';
import {
  buildContextAvailability,
  CONTEXT_FIELDS,
  DEFAULT_CONTEXT_AVAILABILITY,
} from './context.ts';

describe('context availability (AI-008)', () => {
  it('defaults every field to not_available with no input', () => {
    const ctx = buildContextAvailability();
    for (const field of CONTEXT_FIELDS) {
      expect(ctx[field]).toBe('not_available');
    }
    expect(ctx).toEqual(DEFAULT_CONTEXT_AVAILABILITY);
  });

  it('defaults every field to not_available with an empty object', () => {
    expect(buildContextAvailability({})).toEqual(DEFAULT_CONTEXT_AVAILABILITY);
  });

  it('only flips explicitly-supplied fields to available', () => {
    const ctx = buildContextAvailability({ sleep: true, recovery: true });
    expect(ctx.sleep).toBe('available');
    expect(ctx.recovery).toBe('available');
    expect(ctx.stress).toBe('not_available');
    expect(ctx.nutrition).toBe('not_available');
    expect(ctx.weather).toBe('not_available');
    expect(ctx.soreness).toBe('not_available');
    expect(ctx.goals).toBe('not_available');
  });

  it('a false or omitted flag never flips a field to available', () => {
    const ctx = buildContextAvailability({ sleep: false });
    expect(ctx.sleep).toBe('not_available');
  });
});
