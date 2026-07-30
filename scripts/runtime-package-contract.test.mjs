import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRuntimeDependencyContract } from './runtime-package-contract.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const exactDependencies = {
  'better-sqlite3': '12.11.1',
  fflate: '0.8.3',
};

// This read is intentionally immediate and fail-closed. The root test script
// runs the dist-mutating dev-proxy suite only after every checked-in artifact
// contract has passed, so a rebuild can neither race this read nor repair a
// missing committed artifact before it is detected.
async function readCoherentProductionJavascript(webRoot) {
  const evidence = JSON.parse(
    await readFile(join(webRoot, 'third-party-module-evidence.json'), 'utf8'),
  );
  const javascriptEntries = evidence.files.filter((file) => file.file.endsWith('.js'));
  if (javascriptEntries.length === 0) throw new Error('runtime_web_javascript_missing');
  return Promise.all(
    javascriptEntries.map(async (entry) => {
      const bytes = await readFile(join(webRoot, entry.file));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== entry.bytes || digest !== entry.sha256) {
        throw new Error('runtime_web_artifact_incomplete');
      }
      return { file: entry.file, javascript: bytes.toString('utf8') };
    }),
  );
}

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

  it('checks in only production web JavaScript without local source paths', async () => {
    const webRoot = join(repositoryRoot, 'apps', 'api', 'dist', 'web');
    const javascriptFiles = await readCoherentProductionJavascript(webRoot);

    expect(javascriptFiles.length).toBeGreaterThan(0);
    for (const { javascript } of javascriptFiles) {
      expect(javascript).not.toContain('jsxDEV');
      expect(javascript).not.toContain('Each child in a list should have a unique');
      expect(javascript.replaceAll(String.fromCharCode(92), '/')).not.toContain('/apps/web/src/');
    }
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
