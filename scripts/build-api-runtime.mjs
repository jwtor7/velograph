#!/usr/bin/env node
/**
 * Build the authoritative web artifact and API runtime without recursively
 * resolving a package-manager shim. Lifecycle scripts can call this module
 * directly through the already-running Node executable.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function buildApiRuntime({ stdio = 'inherit' } = {}) {
  const commands = [
    [join(REPOSITORY_ROOT, 'scripts', 'package-web.mjs')],
    [
      join(REPOSITORY_ROOT, 'scripts', 'third-party-license-gate.mjs'),
      '--stage-artifact',
      'apps/web/dist',
    ],
    [join(REPOSITORY_ROOT, 'apps', 'api', 'scripts', 'build.mjs')],
  ];

  for (const [script, ...args] of commands) {
    execFileSync(process.execPath, [script, ...args], {
      cwd: REPOSITORY_ROOT,
      stdio,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildApiRuntime();
}
