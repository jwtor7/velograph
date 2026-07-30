import { describe, expect, it } from 'vitest';
import { validateZoneBoundsDraft } from './settings-form.ts';

describe('validateZoneBoundsDraft', () => {
  it('uses five blank fields as an explicit request to disable zones', () => {
    expect(validateZoneBoundsDraft(['', ' ', '', '', ''])).toEqual({
      value: null,
      error: null,
    });
  });

  it('accepts five plausible strictly ascending integer boundaries', () => {
    expect(validateZoneBoundsDraft(['90', '110', '130', '150', '170'])).toEqual({
      value: [90, 110, 130, 150, 170],
      error: null,
    });
  });

  it.each([
    [['90', '', '130', '150', '170'], 'Enter all five boundaries'],
    [['39', '110', '130', '150', '170'], 'whole number from 40 to 230'],
    [['90.5', '110', '130', '150', '170'], 'whole number from 40 to 230'],
    [['90', '130', '130', '150', '170'], 'increase strictly'],
    [['90', '140', '130', '150', '170'], 'increase strictly'],
  ])('rejects an invalid draft without silently disabling zones', (bounds, message) => {
    const result = validateZoneBoundsDraft(bounds);
    expect(result.value).toBeNull();
    expect(result.error).toContain(message);
  });
});
