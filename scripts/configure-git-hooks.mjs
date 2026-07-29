#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function configureGitHooks(cwd = process.cwd()) {
  let repositoryRoot;
  try {
    repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    console.log('prepare: outside a Git checkout; hook configuration skipped');
    return 0;
  }

  if (!existsSync(join(repositoryRoot, '.githooks', 'pre-commit'))) {
    console.error('prepare: Git checkout is missing the required pre-commit hook');
    return 1;
  }

  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    console.error('prepare: unable to configure the required pre-commit hook');
    return 1;
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(configureGitHooks());
}
