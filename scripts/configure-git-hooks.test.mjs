import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureGitHooks } from './configure-git-hooks.mjs';

const temporaryDirectories = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('Git hook prepare helper', () => {
  it('is a successful no-op outside a Git checkout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'velograph-prepare-'));
    temporaryDirectories.push(directory);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(configureGitHooks(directory)).toBe(0);
  });

  it('configures the required hook in a Git checkout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'velograph-prepare-repository-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '--quiet', directory]);
    mkdirSync(join(directory, '.githooks'));
    writeFileSync(join(directory, '.githooks', 'pre-commit'), '#!/bin/sh\n');

    expect(configureGitHooks(directory)).toBe(0);
    expect(
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: directory,
        encoding: 'utf8',
      }).trim(),
    ).toBe('.githooks');
  });
});
