import { describe, expect, it } from 'vitest';
import { evaluate, hasExemptTrailer } from './check-changelog.mjs';

describe('check-changelog (issue #39)', () => {
  it('passes when no source paths changed', () => {
    const result = evaluate(['README.md', 'docs/formulas.md'], []);
    expect(result.ok).toBe(true);
  });

  it('passes when source changed and CHANGELOG.md was updated in the same diff', () => {
    const result = evaluate(['packages/analytics/src/engine.ts', 'CHANGELOG.md'], []);
    expect(result.ok).toBe(true);
  });

  it('fails when source changed and CHANGELOG.md was not touched', () => {
    const result = evaluate(['apps/api/src/server.ts'], []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/CHANGELOG\.md was not/);
  });

  it('fails for scripts/** changes with no changelog and no exemption', () => {
    const result = evaluate(['scripts/generate-fixtures.mjs'], ['Tweak fixture seed comment']);
    expect(result.ok).toBe(false);
  });

  it('passes when a commit carries a Changelog-Exempt trailer', () => {
    const messages = ['Fix typo in comment\n\nChangelog-Exempt: comment-only, no behaviour change'];
    const result = evaluate(['packages/shared/src/index.ts'], messages);
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/Changelog-Exempt/);
  });

  it('does not accept an exemption trailer with no reason text', () => {
    expect(hasExemptTrailer(['Changelog-Exempt:'])).toBe(false);
    expect(hasExemptTrailer(['Changelog-Exempt:   '])).toBe(false);
  });

  it('accepts the trailer case-insensitively and anywhere in the message body', () => {
    const messages = ['docs: fix broken link\n\nSome body text\nchangelog-exempt: docs only'];
    expect(hasExemptTrailer(messages)).toBe(true);
  });

  it('ignores unrelated top-level directories (fixtures, docs) as non-source', () => {
    const result = evaluate(['fixtures/synthetic/rides/x.csv', 'docs/releasing.md'], []);
    expect(result.ok).toBe(true);
  });
});
