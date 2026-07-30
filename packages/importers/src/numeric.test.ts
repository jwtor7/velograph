import { describe, expect, it } from 'vitest';
import { parseStrictNumber } from './numeric.ts';

describe('strict imported number parsing', () => {
  it('never coerces blank cells to zero', () => {
    expect(parseStrictNumber('')).toBeNull();
    expect(parseStrictNumber('   ')).toBeNull();
    expect(parseStrictNumber(undefined)).toBeNull();
  });

  it('rejects non-finite and bounded values', () => {
    expect(parseStrictNumber('Infinity')).toBeNull();
    expect(parseStrictNumber('1e999')).toBeNull();
    expect(parseStrictNumber('0x10')).toBeNull();
    expect(parseStrictNumber('-1', { min: 0 })).toBeNull();
    expect(parseStrictNumber('360', { min: 0, maxExclusive: 360 })).toBeNull();
  });

  it('preserves an explicit valid zero', () => {
    expect(parseStrictNumber('0', { min: 0 })).toBe(0);
  });
});
