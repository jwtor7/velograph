import { describe, expect, it } from 'vitest';
import { containsDiagnosticPhrasing, NON_CLINICAL_DISCLAIMER } from './guidance.ts';

describe('non-clinical guidance (AI-011)', () => {
  it('exports a non-empty disclaimer that frames output as informational, not medical', () => {
    expect(NON_CLINICAL_DISCLAIMER.length).toBeGreaterThan(0);
    expect(NON_CLINICAL_DISCLAIMER.toLowerCase()).toContain('not medical advice');
  });

  it('flags diagnostic phrasing', () => {
    expect(containsDiagnosticPhrasing('This pattern may diagnose an underlying issue.')).toBe(true);
    expect(containsDiagnosticPhrasing('You have a heart condition based on this data.')).toBe(true);
    expect(containsDiagnosticPhrasing('You should stop taking your medication.')).toBe(true);
    expect(
      containsDiagnosticPhrasing(
        'This pattern strongly indicates atrial fibrillation; seek emergency care.',
      ),
    ).toBe(true);
    expect(containsDiagnosticPhrasing('This ride guarantees fat loss.')).toBe(true);
  });

  it('does not flag ordinary training commentary', () => {
    expect(containsDiagnosticPhrasing('Your pacing was even across the ride.')).toBe(false);
    expect(containsDiagnosticPhrasing('Consider an easier recovery ride tomorrow.')).toBe(false);
  });
});
