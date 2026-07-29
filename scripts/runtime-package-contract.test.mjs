import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRuntimeDependencyContract } from './runtime-package-contract.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const exactDependencies = {
  'better-sqlite3': '12.11.1',
  fflate: '0.8.3',
};

describe('runtime package dependency contract', () => {
  it('routes every declared API build and prepack through the canonical Node orchestrator', () => {
    const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
    const apiManifest = JSON.parse(
      readFileSync(join(repositoryRoot, 'apps', 'api', 'package.json'), 'utf8'),
    );
    expect(rootManifest.scripts['api:build']).toBe('node scripts/build-api-runtime.mjs');
    expect(apiManifest.scripts.build).toBe('node ../../scripts/build-api-runtime.mjs');
    expect(apiManifest.scripts.prepack).toBe('node ../../scripts/build-api-runtime.mjs');
  });

  it('accepts only the exact audited external dependency set', () => {
    expect(() =>
      assertRuntimeDependencyContract({ dependencies: exactDependencies }),
    ).not.toThrow();
  });

  it.each([
    {},
    { dependencies: { ...exactDependencies, 'synthetic-extra': '1.0.0' } },
    { dependencies: { 'better-sqlite3': '12.11.1' } },
    { dependencies: { ...exactDependencies, fflate: '^0.8.3' } },
    { dependencies: { ...exactDependencies, 'better-sqlite3': '^12.11.1' } },
  ])('rejects missing, extra, or ranged runtime dependencies', (manifest) => {
    expect(() => assertRuntimeDependencyContract(manifest)).toThrow(/runtime_dependency_/);
  });
});
