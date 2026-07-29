import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneDeployedApi } from './prune-deployed-api.mjs';

const temporaryDirectories = [];

function makeDeployment() {
  const root = mkdtempSync(join(tmpdir(), 'velograph-production-deploy-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'node_modules', '.pnpm'), { recursive: true });
  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('production API deployment pruning', () => {
  it('removes only the reviewed tar-fs install fixture', () => {
    const root = makeDeployment();
    const fixture = join(
      root,
      'node_modules',
      '.pnpm',
      'tar-fs@2.1.5',
      'node_modules',
      'tar-fs',
      'test',
      'fixtures',
      'invalid.tar',
    );
    mkdirSync(dirname(fixture), { recursive: true });
    writeFileSync(fixture, 'synthetic invalid archive fixture');

    expect(pruneDeployedApi(root)).toBe(1);
  });

  it('fails closed for an unreviewed archive', () => {
    const root = makeDeployment();
    const archive = join(root, 'node_modules', '.pnpm', 'new-package@1.0.0', 'payload.zip');
    mkdirSync(dirname(archive), { recursive: true });
    writeFileSync(archive, 'synthetic unreviewed archive');

    expect(() => pruneDeployedApi(root)).toThrow('unexpected_archive_in_production_deploy');
  });

  it('fails closed when a development package enters the deployment', () => {
    const root = makeDeployment();
    mkdirSync(join(root, 'node_modules', '.pnpm', 'vitest@3.2.4'));

    expect(() => pruneDeployedApi(root)).toThrow('development_dependency_in_production_deploy');
  });
});
