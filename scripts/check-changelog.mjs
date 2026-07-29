#!/usr/bin/env node
/**
 * CHANGELOG enforcement (issue #39, see docs/releasing.md).
 *
 * Fails when a PR modifies source (`packages/**`, `apps/**`, `scripts/**`)
 * without also touching `CHANGELOG.md`, unless a commit in the PR carries a
 * `Changelog-Exempt: <reason>` trailer for genuinely non-behavioural changes
 * (docs typos, formatting, comment/test-only edits).
 *
 * Usage: node scripts/check-changelog.mjs <base-sha> <head-sha>
 */
import { execFileSync } from 'node:child_process';

const SOURCE_PATH = /^(packages|apps|scripts)\//;
const EXEMPT_TRAILER = /^Changelog-Exempt:\s*\S.+$/im;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Files that differ between base and head (merge-base diff, like a PR diff on GitHub). */
export function changedFiles(base, head) {
  return git(['diff', '--name-only', `${base}...${head}`])
    .split('\n')
    .filter(Boolean);
}

/** Every commit message (subject + body) reachable from head but not base. */
export function commitMessages(base, head) {
  return git(['log', '--pretty=%B%x00', `${base}..${head}`])
    .split('\0')
    .filter((s) => s.trim() !== '');
}

export function hasExemptTrailer(messages) {
  return messages.some((m) => EXEMPT_TRAILER.test(m));
}

export function evaluate(files, messages) {
  const touchesSource = files.some((f) => SOURCE_PATH.test(f));
  if (!touchesSource) {
    return { ok: true, reason: 'no changes under packages/**, apps/**, or scripts/**' };
  }
  if (files.includes('CHANGELOG.md')) {
    return { ok: true, reason: 'CHANGELOG.md was updated' };
  }
  if (hasExemptTrailer(messages)) {
    return { ok: true, reason: 'a commit carries a Changelog-Exempt trailer' };
  }
  return {
    ok: false,
    reason:
      'source changed under packages/**, apps/**, or scripts/** but CHANGELOG.md was not ' +
      'updated, and no commit carries a "Changelog-Exempt: <reason>" trailer',
  };
}

export function run(argv) {
  const [base, head] = argv;
  if (!base || !head) {
    console.error('Usage: node scripts/check-changelog.mjs <base-sha> <head-sha>');
    return 2;
  }
  const files = changedFiles(base, head);
  const messages = commitMessages(base, head);
  const result = evaluate(files, messages);
  if (result.ok) {
    console.log(`check-changelog: OK — ${result.reason}`);
    return 0;
  }
  console.error(`CHANGELOG CHECK FAILED — ${result.reason}`);
  console.error(
    '\nAdd an entry under "## [Unreleased]" in CHANGELOG.md in this PR. If this change has ' +
      'no user-visible behaviour (docs, formatting, comment/test-only), add a trailer to a ' +
      'commit message instead:\n\n  Changelog-Exempt: <reason>\n\nSee docs/releasing.md.',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(run(process.argv.slice(2)));
}
