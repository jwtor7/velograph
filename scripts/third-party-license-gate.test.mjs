import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractEmbeddedLicenseText,
  normalizeLicenseText,
  PROJECT_COPYRIGHT_FILE,
  PROJECT_LICENSE_FILE,
  PROJECT_LICENSE_SPDX,
  PROJECT_MANIFEST_PATHS,
  renderNotices,
  stageAndVerifyArtifact,
  validateManifest,
  verifyArtifact,
  verifyPackageLicense,
  verifyProjectLicensePolicy,
  verifyProductionDeployment,
  verifyScopeCoverage,
  verifySqliteRuntimeVersion,
} from './third-party-license-gate.mjs';

const temporaryDirectories = [];
const canonicalProjectLicense = readFileSync(join(process.cwd(), PROJECT_LICENSE_FILE));
const canonicalProjectCopyright = readFileSync(join(process.cwd(), PROJECT_COPYRIGHT_FILE));

function makeDirectory(prefix = 'velograph-license-gate-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function textEvidence(value) {
  const text = normalizeLicenseText(value);
  return {
    text,
    licenseSha256: createHash('sha256').update(text).digest('hex'),
    licenseBytes: Buffer.byteLength(text),
  };
}

function packageEntry({
  name = 'synthetic-runtime',
  version = '1.0.0',
  declaredLicense = 'MIT',
  selectedLicense = 'MIT',
  scopes = ['api'],
  text = 'Synthetic permissive licence text.',
} = {}) {
  const evidence = textEvidence(text);
  const entry = {
    name,
    version,
    declaredLicense,
    selectedLicense,
    scopes,
    licenseFile: 'LICENSE',
    licenseSha256: evidence.licenseSha256,
    licenseBytes: evidence.licenseBytes,
  };
  if (scopes.includes('web')) entry.artifactPresence = 'required';
  return entry;
}

function manifestWith(packages = [], embeddedComponents = []) {
  return { schemaVersion: 1, packages, embeddedComponents };
}

function writeCanonicalEvidence(repositoryRoot, manifest, texts) {
  const directory = join(repositoryRoot, 'third_party_licenses');
  mkdirSync(directory, { recursive: true });
  for (const [hash, text] of texts) {
    writeFileSync(join(directory, `${hash}.txt`), text);
  }
  writeJson(join(repositoryRoot, 'third-party-licenses.json'), manifest);
  writeFileSync(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), renderNotices(manifest, texts));
  writeFileSync(join(repositoryRoot, PROJECT_LICENSE_FILE), canonicalProjectLicense);
  writeFileSync(join(repositoryRoot, PROJECT_COPYRIGHT_FILE), canonicalProjectCopyright);
}

function writeProjectPolicy(repositoryRoot, manifestLicense = PROJECT_LICENSE_SPDX) {
  writeFileSync(join(repositoryRoot, PROJECT_LICENSE_FILE), canonicalProjectLicense);
  writeFileSync(join(repositoryRoot, PROJECT_COPYRIGHT_FILE), canonicalProjectCopyright);
  for (const [index, manifestPath] of PROJECT_MANIFEST_PATHS.entries()) {
    const path = join(repositoryRoot, manifestPath);
    mkdirSync(dirname(path), { recursive: true });
    writeJson(path, {
      name: index === 0 ? 'synthetic-project' : `@synthetic/workspace-${index}`,
      version: '1.0.0',
      private: true,
      license: manifestLicense,
    });
  }
}

function writeDeploymentProjectFiles(deploymentRoot) {
  mkdirSync(join(deploymentRoot, 'dist'), { recursive: true });
  for (const [filename, content] of [
    [PROJECT_LICENSE_FILE, canonicalProjectLicense],
    [PROJECT_COPYRIGHT_FILE, canonicalProjectCopyright],
  ]) {
    writeFileSync(join(deploymentRoot, filename), content);
    writeFileSync(join(deploymentRoot, 'dist', filename), content);
  }
}

function makePackage(root, entry, text) {
  mkdirSync(root, { recursive: true });
  writeJson(join(root, 'package.json'), {
    name: entry.name,
    version: entry.version,
    license: entry.declaredLicense,
  });
  writeFileSync(join(root, entry.licenseFile), text);
  return {
    id: `${entry.name}@${entry.version}`,
    root,
    packageJson: {
      name: entry.name,
      version: entry.version,
      license: entry.declaredLicense,
    },
  };
}

function writeWebArtifactEvidence(
  artifactRoot,
  {
    packageIds,
    injectedModules = ['vite-modulepreload-polyfill'],
    script = 'const relList = {}; relList.supports("modulepreload");\n',
  },
) {
  const html = '<main>Synthetic artifact</main>\n';
  mkdirSync(join(artifactRoot, 'assets'), { recursive: true });
  writeFileSync(join(artifactRoot, 'assets', 'index.js'), script);
  writeFileSync(join(artifactRoot, 'index.html'), html);
  writeFileSync(join(artifactRoot, PROJECT_LICENSE_FILE), canonicalProjectLicense);
  writeFileSync(join(artifactRoot, PROJECT_COPYRIGHT_FILE), canonicalProjectCopyright);
  const fileEvidence = [
    {
      file: 'assets/index.js',
      sha256: createHash('sha256').update(script).digest('hex'),
      bytes: Buffer.byteLength(script),
      generatedBy: 'rollup-chunk',
      packages: packageIds,
    },
    {
      file: 'index.html',
      sha256: createHash('sha256').update(html).digest('hex'),
      bytes: Buffer.byteLength(html),
      generatedBy: 'vite-html-entry',
      packages: ['@synthetic/web@1.0.0'],
    },
  ];
  writeJson(join(artifactRoot, 'third-party-module-evidence.json'), {
    schemaVersion: 1,
    packages: packageIds.map((id) => ({ id, moduleCount: 1 })),
    injectedModules,
    files: fileEvidence,
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('third-party licence manifest', () => {
  it('accepts reviewed exact SPDX evidence', () => {
    const entry = packageEntry();
    expect(validateManifest(manifestWith([entry]))).toEqual(manifestWith([entry]));
  });

  it('rejects forbidden selected licences', () => {
    const entry = packageEntry({
      declaredLicense: 'GPL-3.0-only',
      selectedLicense: 'GPL-3.0-only',
    });
    expect(() => validateManifest(manifestWith([entry]))).toThrow('forbidden_selected_license');
  });

  it('requires an exact SPDX token instead of a substring match', () => {
    const entry = packageEntry({ declaredLicense: 'Permissive-MIT-like' });
    expect(() => validateManifest(manifestWith([entry]))).toThrow('selected_license_not_declared');
  });

  it.each([
    'MIT AND BSD-3-Clause',
    'MIT and BSD-3-Clause',
    'MIT BSD-3-Clause',
    'MIT WITH LLVM-exception',
  ])('rejects unsupported SPDX expression syntax: %s', (declaredLicense) => {
    const entry = packageEntry({ declaredLicense });
    expect(() => validateManifest(manifestWith([entry]))).toThrow('unsupported_spdx_expression');
  });

  it('requires the canonical project licence, ownership notice, and workspace declarations', () => {
    const repositoryRoot = makeDirectory();
    writeProjectPolicy(repositoryRoot);
    expect(verifyProjectLicensePolicy(repositoryRoot)).toEqual(canonicalProjectLicense);

    writeFileSync(join(repositoryRoot, PROJECT_LICENSE_FILE), 'Changed project licence.\n');
    expect(() => verifyProjectLicensePolicy(repositoryRoot)).toThrow(
      'project_license_content_mismatch',
    );
    writeFileSync(join(repositoryRoot, PROJECT_LICENSE_FILE), canonicalProjectLicense);

    rmSync(join(repositoryRoot, PROJECT_COPYRIGHT_FILE));
    expect(() => verifyProjectLicensePolicy(repositoryRoot)).toThrow(
      'project_copyright_missing_or_invalid',
    );
    writeFileSync(join(repositoryRoot, PROJECT_COPYRIGHT_FILE), canonicalProjectCopyright);

    writeFileSync(join(repositoryRoot, PROJECT_COPYRIGHT_FILE), 'Changed ownership notice.\n');
    expect(() => verifyProjectLicensePolicy(repositoryRoot)).toThrow(
      'project_copyright_content_mismatch',
    );
    writeFileSync(join(repositoryRoot, PROJECT_COPYRIGHT_FILE), canonicalProjectCopyright);

    writeJson(join(repositoryRoot, 'apps', 'web', 'package.json'), {
      name: '@synthetic/web',
      version: '1.0.0',
      license: 'MIT',
    });
    expect(() => verifyProjectLicensePolicy(repositoryRoot)).toThrow(
      'project_package_license_mismatch:apps/web/package.json',
    );
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'MIT'],
  ])('discovers an added workspace with a %s licence declaration', (_label, license) => {
    const repositoryRoot = makeDirectory();
    writeProjectPolicy(repositoryRoot);
    const manifest = {
      name: '@synthetic/added-workspace',
      version: '1.0.0',
      private: true,
    };
    if (license !== undefined) manifest.license = license;
    const manifestPath = join(repositoryRoot, 'packages', 'added-workspace', 'package.json');
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeJson(manifestPath, manifest);

    expect(() => verifyProjectLicensePolicy(repositoryRoot)).toThrow(
      'project_package_license_mismatch:packages/added-workspace/package.json',
    );
  });
});

describe('third-party package evidence', () => {
  it('verifies installed identity, SPDX, file hash, and checked text', () => {
    const directory = makeDirectory();
    const entry = packageEntry();
    const text = normalizeLicenseText('Synthetic permissive licence text.');
    const record = makePackage(join(directory, 'synthetic-runtime'), entry, text);
    expect(() => verifyPackageLicense(record, entry, text)).not.toThrow();

    writeFileSync(join(record.root, 'LICENSE'), 'Changed synthetic text.\n');
    expect(() => verifyPackageLicense(record, entry, text)).toThrow(
      'package_license_text_mismatch',
    );
  });

  it('fails when an installed package has an unreviewed NOTICE file', () => {
    const directory = makeDirectory();
    const entry = packageEntry();
    const text = normalizeLicenseText('Synthetic permissive licence text.');
    const record = makePackage(join(directory, 'synthetic-runtime'), entry, text);
    writeFileSync(join(record.root, 'NOTICE'), 'Synthetic additional terms.\n');
    expect(() => verifyPackageLicense(record, entry, text)).toThrow(
      'unreviewed_package_notice_file',
    );
  });

  it('fails on unreviewed and missing runtime dependencies', () => {
    const reviewed = packageEntry();
    const actual = new Map([
      [
        'synthetic-extra@1.0.0',
        {
          packageJson: { name: 'synthetic-extra', version: '1.0.0' },
        },
      ],
    ]);
    expect(() =>
      verifyScopeCoverage({
        actualRecords: actual,
        manifest: manifestWith([reviewed]),
        scope: 'api',
      }),
    ).toThrow('unreviewed_runtime_dependency');

    expect(() =>
      verifyScopeCoverage({
        actualRecords: new Map(),
        manifest: manifestWith([reviewed]),
        scope: 'api',
      }),
    ).toThrow('reviewed_runtime_dependency_missing');

    expect(() =>
      verifyScopeCoverage({
        actualRecords: new Map([
          [
            '@velograph/untrusted@1.0.0',
            {
              packageJson: {
                name: '@velograph/untrusted',
                version: '1.0.0',
              },
            },
          ],
        ]),
        manifest: manifestWith(),
        scope: 'api',
      }),
    ).toThrow('unreviewed_runtime_dependency');
  });

  it('extracts and versions an embedded SQLite blessing deterministically', () => {
    const directory = makeDirectory();
    const sourceFile = join(directory, 'deps', 'sqlite3', 'sqlite3.h');
    mkdirSync(join(directory, 'deps', 'sqlite3'), { recursive: true });
    writeFileSync(
      sourceFile,
      [
        '#define SQLITE_VERSION "9.8.7"',
        '** The author disclaims copyright to this source code.  In place of',
        '** a legal notice, here is a blessing:',
        '**',
        '**    May you do good and not evil.',
        '**    May you find forgiveness for yourself and forgive others.',
        '**    May you share freely, never taking more than you give.',
        '',
      ].join('\n'),
    );
    const entry = {
      ...textEvidence(
        [
          'The author disclaims copyright to this source code.  In place of',
          'a legal notice, here is a blessing:',
          '',
          '   May you do good and not evil.',
          '   May you find forgiveness for yourself and forgive others.',
          '   May you share freely, never taking more than you give.',
        ].join('\n'),
      ),
      name: 'synthetic-embedded-db',
      version: '9.8.7',
      declaredLicense: 'blessing',
      selectedLicense: 'blessing',
      scopes: ['api'],
      evidenceKind: 'sqlite-amalgamation-blessing',
      sourcePackage: 'synthetic-parent@1.0.0',
      sourceFile: 'deps/sqlite3/sqlite3.h',
      productionEvidenceFile: 'build/Release/synthetic.node',
    };
    const record = {
      id: 'synthetic-parent@1.0.0',
      root: directory,
      packageJson: { name: 'synthetic-parent', version: '1.0.0' },
    };

    expect(extractEmbeddedLicenseText(entry, record)).toBe(
      textEvidence(
        [
          'The author disclaims copyright to this source code.  In place of',
          'a legal notice, here is a blessing:',
          '',
          '   May you do good and not evil.',
          '   May you find forgiveness for yourself and forgive others.',
          '   May you share freely, never taking more than you give.',
        ].join('\n'),
      ).text,
    );
  });

  it('queries the loaded native database for the exact SQLite version', () => {
    const entry = { name: 'synthetic-embedded-db', version: '9.8.7' };
    class MatchingDatabase {
      prepare() {
        return { get: () => ({ version: '9.8.7' }) };
      }
      close() {}
    }
    class WrongDatabase {
      prepare() {
        return { get: () => ({ version: '9.8.8' }) };
      }
      close() {}
    }
    expect(() => verifySqliteRuntimeVersion(entry, MatchingDatabase)).not.toThrow();
    expect(() => verifySqliteRuntimeVersion(entry, WrongDatabase)).toThrow(
      'production_embedded_component_version_mismatch',
    );
  });
});

describe('third-party licence artifact gates', () => {
  it('requires the exact canonical notice and complete web module evidence', () => {
    const repositoryRoot = makeDirectory();
    const artifactRoot = makeDirectory();
    mkdirSync(join(repositoryRoot, 'apps', 'web'), { recursive: true });
    mkdirSync(join(repositoryRoot, 'packages'), { recursive: true });
    writeJson(join(repositoryRoot, 'package.json'), {
      name: 'synthetic-project',
      version: '1.0.0',
    });
    writeJson(join(repositoryRoot, 'apps', 'web', 'package.json'), {
      name: '@synthetic/web',
      version: '1.0.0',
      dependencies: {
        'synthetic-runtime': '1.0.0',
      },
    });
    const runtime = packageEntry({
      name: 'synthetic-runtime',
      scopes: ['web'],
    });
    const evidence = textEvidence('Synthetic build-tool licence.');
    const embedded = {
      name: 'synthetic-build-tool',
      version: '1.0.0',
      declaredLicense: 'MIT',
      selectedLicense: 'MIT',
      scopes: ['web'],
      evidenceKind: 'package-license',
      sourcePackage: 'synthetic-build-tool@1.0.0',
      sourceFile: 'LICENSE',
      artifactEvidence: 'vite-modulepreload-polyfill',
      licenseSha256: evidence.licenseSha256,
      licenseBytes: evidence.licenseBytes,
    };
    const manifest = manifestWith([runtime], [embedded]);
    const texts = new Map([
      [runtime.licenseSha256, normalizeLicenseText('Synthetic permissive licence text.')],
      [evidence.licenseSha256, evidence.text],
    ]);
    writeCanonicalEvidence(repositoryRoot, manifest, texts);
    writeWebArtifactEvidence(artifactRoot, {
      packageIds: ['@synthetic/web@1.0.0', 'synthetic-runtime@1.0.0'],
    });
    rmSync(join(artifactRoot, PROJECT_LICENSE_FILE));
    rmSync(join(artifactRoot, PROJECT_COPYRIGHT_FILE));
    expect(stageAndVerifyArtifact(artifactRoot, repositoryRoot)).toBe(0);
    writeFileSync(join(artifactRoot, 'assets', 'index.js'), 'tampered\n');
    expect(() => verifyArtifact(artifactRoot, repositoryRoot)).toThrow(
      /^artifact_file_evidence_mismatch$/,
    );
    writeWebArtifactEvidence(artifactRoot, {
      packageIds: ['@synthetic/web@1.0.0', 'synthetic-runtime@1.0.0'],
    });
    writeFileSync(join(artifactRoot, 'THIRD_PARTY_NOTICES.md'), 'stale\n');
    expect(() => verifyArtifact(artifactRoot, repositoryRoot)).toThrow(
      'artifact_third_party_notices_mismatch',
    );
    writeFileSync(join(artifactRoot, 'THIRD_PARTY_NOTICES.md'), renderNotices(manifest, texts));
    writeFileSync(join(artifactRoot, PROJECT_COPYRIGHT_FILE), 'Changed ownership notice.\n');
    expect(() => verifyArtifact(artifactRoot, repositoryRoot)).toThrow(
      'artifact_project_copyright_mismatch',
    );
  });

  it('rejects an unreviewed package named in web build evidence', () => {
    const repositoryRoot = makeDirectory();
    const artifactRoot = makeDirectory();
    mkdirSync(join(repositoryRoot, 'apps', 'web'), { recursive: true });
    mkdirSync(join(repositoryRoot, 'packages'), { recursive: true });
    writeJson(join(repositoryRoot, 'package.json'), {
      name: 'synthetic-project',
      version: '1.0.0',
    });
    writeJson(join(repositoryRoot, 'apps', 'web', 'package.json'), {
      name: '@synthetic/web',
      version: '1.0.0',
    });
    const buildEvidence = textEvidence('Synthetic build-tool licence.');
    const embedded = {
      name: 'synthetic-build-tool',
      version: '1.0.0',
      declaredLicense: 'MIT',
      selectedLicense: 'MIT',
      scopes: ['web'],
      evidenceKind: 'package-license',
      sourcePackage: 'synthetic-build-tool@1.0.0',
      sourceFile: 'LICENSE',
      artifactEvidence: 'vite-modulepreload-polyfill',
      licenseSha256: buildEvidence.licenseSha256,
      licenseBytes: buildEvidence.licenseBytes,
    };
    const manifest = manifestWith([], [embedded]);
    const texts = new Map([[buildEvidence.licenseSha256, buildEvidence.text]]);
    writeCanonicalEvidence(repositoryRoot, manifest, texts);
    writeWebArtifactEvidence(artifactRoot, {
      packageIds: ['@synthetic/web@1.0.0', 'synthetic-unreviewed@1.0.0'],
    });
    writeFileSync(join(artifactRoot, 'THIRD_PARTY_NOTICES.md'), renderNotices(manifest, texts));

    expect(() => verifyArtifact(artifactRoot, repositoryRoot)).toThrow(
      'artifact_unreviewed_runtime_dependency',
    );
  });

  it('fails when an unreviewed package is retained in a production deploy', () => {
    const repositoryRoot = makeDirectory();
    const deploymentRoot = makeDirectory();
    const entry = packageEntry();
    const text = normalizeLicenseText('Synthetic permissive licence text.');
    const manifest = manifestWith([entry]);
    const texts = new Map([[entry.licenseSha256, text]]);
    writeCanonicalEvidence(repositoryRoot, manifest, texts);
    writeFileSync(join(deploymentRoot, 'THIRD_PARTY_NOTICES.md'), renderNotices(manifest, texts));
    mkdirSync(join(repositoryRoot, 'apps', 'web'), { recursive: true });
    mkdirSync(join(repositoryRoot, 'packages'), { recursive: true });
    writeJson(join(repositoryRoot, 'package.json'), {
      name: 'synthetic-project',
      version: '1.0.0',
    });
    writeJson(join(repositoryRoot, 'apps', 'web', 'package.json'), {
      name: '@synthetic/web',
      version: '1.0.0',
    });
    const deployedWeb = join(deploymentRoot, 'dist', 'web');
    writeDeploymentProjectFiles(deploymentRoot);
    writeWebArtifactEvidence(deployedWeb, {
      packageIds: ['@synthetic/web@1.0.0'],
      injectedModules: [],
    });
    writeFileSync(join(deployedWeb, 'THIRD_PARTY_NOTICES.md'), renderNotices(manifest, texts));

    const packageRoot = join(
      deploymentRoot,
      'node_modules',
      '.pnpm',
      'synthetic-runtime@1.0.0',
      'node_modules',
      'synthetic-runtime',
    );
    makePackage(packageRoot, entry, text);
    expect(verifyProductionDeployment(deploymentRoot, repositoryRoot)).toBe(0);

    writeFileSync(join(deploymentRoot, 'dist', PROJECT_LICENSE_FILE), 'Changed licence.\n');
    expect(() => verifyProductionDeployment(deploymentRoot, repositoryRoot)).toThrow(
      'artifact_project_license_mismatch',
    );
    writeFileSync(join(deploymentRoot, 'dist', PROJECT_LICENSE_FILE), canonicalProjectLicense);

    const extra = packageEntry({ name: 'synthetic-unreviewed' });
    makePackage(
      join(
        deploymentRoot,
        'node_modules',
        '.pnpm',
        'synthetic-unreviewed@1.0.0',
        'node_modules',
        'synthetic-unreviewed',
      ),
      extra,
      normalizeLicenseText('Synthetic permissive licence text.'),
    );
    expect(() => verifyProductionDeployment(deploymentRoot, repositoryRoot)).toThrow(
      'unreviewed_runtime_dependency',
    );
  });

  it.each([
    ['top-level', ['node_modules', '@velograph', 'untrusted']],
    ['virtual-store alias', ['node_modules', '.pnpm', 'node_modules', '@velograph', 'untrusted']],
  ])('rejects an unreviewed %s package layout', (_label, pathParts) => {
    const repositoryRoot = makeDirectory();
    const deploymentRoot = makeDirectory();
    const manifest = manifestWith();
    writeCanonicalEvidence(repositoryRoot, manifest, new Map());
    writeFileSync(
      join(deploymentRoot, 'THIRD_PARTY_NOTICES.md'),
      renderNotices(manifest, new Map()),
    );
    mkdirSync(join(deploymentRoot, 'node_modules', '.pnpm'), { recursive: true });
    const rogueRoot = join(deploymentRoot, ...pathParts);
    mkdirSync(rogueRoot, { recursive: true });
    writeJson(join(rogueRoot, 'package.json'), {
      name: '@velograph/untrusted',
      version: '1.0.0',
      license: 'GPL-3.0-only',
    });
    writeFileSync(join(rogueRoot, 'LICENSE'), 'Synthetic forbidden licence.\n');

    expect(() => verifyProductionDeployment(deploymentRoot, repositoryRoot)).toThrow(
      'unreviewed_runtime_dependency',
    );
  });

  it('rejects an unreviewed package reachable through a nested deployment symlink', () => {
    const repositoryRoot = makeDirectory();
    const deploymentRoot = makeDirectory();
    const entry = packageEntry();
    const text = normalizeLicenseText('Synthetic permissive licence text.');
    const manifest = manifestWith([entry]);
    const texts = new Map([[entry.licenseSha256, text]]);
    writeCanonicalEvidence(repositoryRoot, manifest, texts);
    writeFileSync(join(deploymentRoot, 'THIRD_PARTY_NOTICES.md'), renderNotices(manifest, texts));

    const reviewedRoot = join(
      deploymentRoot,
      'node_modules',
      '.pnpm',
      'synthetic-runtime@1.0.0',
      'node_modules',
      'synthetic-runtime',
    );
    makePackage(reviewedRoot, entry, text);
    const rogue = packageEntry({ name: 'synthetic-unreviewed' });
    const rogueRoot = join(deploymentRoot, 'internal-packages', 'synthetic-unreviewed');
    makePackage(rogueRoot, rogue, normalizeLicenseText('Synthetic permissive licence text.'));
    mkdirSync(join(reviewedRoot, 'node_modules'), { recursive: true });
    symlinkSync(rogueRoot, join(reviewedRoot, 'node_modules', 'synthetic-unreviewed'), 'dir');

    expect(() => verifyProductionDeployment(deploymentRoot, repositoryRoot)).toThrow(
      'unreviewed_runtime_dependency',
    );
  });
});
