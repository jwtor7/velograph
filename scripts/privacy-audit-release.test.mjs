import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAK_MARKER } from './privacy-scan.mjs';
import {
  MAX_AUDIT_ENTRY_BYTES,
  assertAuditableSize,
  auditArtifact,
  auditOciArchive,
  auditProductionDeploy,
  normalizedArchivePath,
  scanHistoryContent,
} from './privacy-audit-release.mjs';

const temporaryDirectories = [];
const canonicalNotices = readFileSync(join(process.cwd(), 'THIRD_PARTY_NOTICES.md'));
const thirdPartyManifest = JSON.parse(
  readFileSync(join(process.cwd(), 'third-party-licenses.json'), 'utf8'),
);
const webPackageManifest = JSON.parse(
  readFileSync(join(process.cwd(), 'apps', 'web', 'package.json'), 'utf8'),
);

function makeArtifactDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'velograph-release-audit-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeBlob(layout, content, mediaType) {
  const digest = createHash('sha256').update(content).digest('hex');
  writeFileSync(join(layout, 'blobs', 'sha256', digest), content);
  return {
    mediaType,
    digest: `sha256:${digest}`,
    size: content.length,
  };
}

function jsonBlob(layout, value, mediaType) {
  return writeBlob(layout, Buffer.from(`${JSON.stringify(value)}\n`), mediaType);
}

function writeSyntheticWebArtifact(root) {
  const webRoot = join(root, 'app', 'api', 'dist', 'web');
  const script = Buffer.from('const relList = {}; relList.supports("modulepreload");\n');
  const html = Buffer.from('<main>Synthetic container artifact</main>\n');
  const font = Buffer.from('synthetic bundled font bytes\n');
  const requiredPackageIds = thirdPartyManifest.packages
    .filter((entry) => entry.scopes.includes('web') && entry.artifactPresence === 'required')
    .map((entry) => `${entry.name}@${entry.version}`);
  const workspaceId = `${webPackageManifest.name}@${webPackageManifest.version}`;
  const packageIds = [workspaceId, ...requiredPackageIds].sort((left, right) =>
    left.localeCompare(right),
  );
  const fontPackage = requiredPackageIds.find((id) => id.startsWith('@fontsource/inter@'));
  if (!fontPackage) throw new Error('synthetic_font_package_missing');

  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'assets', 'index.js'), script);
  writeFileSync(join(webRoot, 'assets', 'synthetic-font.woff2'), font);
  writeFileSync(join(webRoot, 'index.html'), html);

  const files = [
    {
      file: 'assets/index.js',
      sha256: createHash('sha256').update(script).digest('hex'),
      bytes: script.length,
      generatedBy: 'rollup-chunk',
      packages: packageIds,
    },
    {
      file: 'assets/synthetic-font.woff2',
      sha256: createHash('sha256').update(font).digest('hex'),
      bytes: font.length,
      generatedBy: 'rollup-asset',
      packages: [fontPackage],
    },
    {
      file: 'index.html',
      sha256: createHash('sha256').update(html).digest('hex'),
      bytes: html.length,
      generatedBy: 'vite-html-entry',
      packages: [workspaceId],
    },
  ];
  writeFileSync(
    join(webRoot, 'third-party-module-evidence.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      packages: packageIds.map((id) => ({ id, moduleCount: 1 })),
      injectedModules: thirdPartyManifest.embeddedComponents
        .filter((entry) => entry.scopes.includes('web'))
        .map((entry) => entry.artifactEvidence)
        .sort(),
      files,
    })}\n`,
  );
  return webRoot;
}

function createSyntheticOciArchive({
  omitArmProvenance = false,
  omitWebNotices = false,
  omitSystemNotices = false,
  whiteoutWebNotices = false,
  whiteoutPath,
  addWebScript = false,
  replaceWebDirectory = false,
  replaceNodeNoticeWithDirectory = false,
  imageIndexDepth = 1,
} = {}) {
  const directory = makeArtifactDirectory();
  const layout = join(directory, 'layout');
  const blobs = join(layout, 'blobs', 'sha256');
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');

  const layerRoot = join(directory, 'layer-root');
  mkdirSync(join(layerRoot, 'app', 'api'), { recursive: true });
  const webRoot = writeSyntheticWebArtifact(layerRoot);
  writeFileSync(join(layerRoot, 'app', 'api', 'release.txt'), 'synthetic container payload\n');
  writeFileSync(join(layerRoot, 'app', 'api', 'THIRD_PARTY_NOTICES.md'), canonicalNotices);
  if (!omitWebNotices) {
    writeFileSync(join(webRoot, 'THIRD_PARTY_NOTICES.md'), canonicalNotices);
  }
  if (!omitSystemNotices) {
    mkdirSync(join(layerRoot, 'usr', 'local'), { recursive: true });
    mkdirSync(join(layerRoot, 'usr', 'share', 'doc', 'tini'), { recursive: true });
    writeFileSync(join(layerRoot, 'usr', 'local', 'LICENSE'), 'Synthetic Node licence.\n');
    writeFileSync(
      join(layerRoot, 'usr', 'share', 'doc', 'tini', 'copyright'),
      'Synthetic tini copyright notice.\n',
    );
  }
  const layerTar = join(directory, 'layer.tar');
  // Match BuildKit layer archives, which include a harmless `./` root marker.
  // The release auditor must ignore only that marker while still validating
  // every descendant path.
  execFileSync('tar', ['-cf', layerTar, '-C', layerRoot, '.']);
  const layer = writeBlob(
    layout,
    gzipSync(readFileSync(layerTar)),
    'application/vnd.oci.image.layer.v1.tar+gzip',
  );
  const imageLayers = [layer];
  const effectiveWhiteoutPath =
    whiteoutPath ??
    (whiteoutWebNotices ? 'app/api/dist/web/.wh.THIRD_PARTY_NOTICES.md' : undefined);
  if (
    effectiveWhiteoutPath ||
    addWebScript ||
    replaceWebDirectory ||
    replaceNodeNoticeWithDirectory
  ) {
    const whiteoutRoot = join(directory, 'whiteout-root');
    const archiveRoots = new Set();
    if (effectiveWhiteoutPath) {
      const whiteout = join(whiteoutRoot, effectiveWhiteoutPath);
      mkdirSync(dirname(whiteout), { recursive: true });
      writeFileSync(whiteout, '');
      archiveRoots.add(effectiveWhiteoutPath.split('/')[0]);
    }
    if (addWebScript) {
      const extraScript = join(
        whiteoutRoot,
        'app',
        'api',
        'dist',
        'web',
        'assets',
        'unreviewed.js',
      );
      mkdirSync(dirname(extraScript), { recursive: true });
      writeFileSync(extraScript, 'console.log("synthetic extra script");\n');
      archiveRoots.add('app');
    }
    if (replaceWebDirectory) {
      const replacement = join(whiteoutRoot, 'app', 'api', 'dist', 'web');
      mkdirSync(dirname(replacement), { recursive: true });
      writeFileSync(replacement, 'synthetic replacement file\n');
      archiveRoots.add('app');
    }
    if (replaceNodeNoticeWithDirectory) {
      mkdirSync(join(whiteoutRoot, 'usr', 'local', 'LICENSE'), {
        recursive: true,
      });
      archiveRoots.add('usr');
    }
    const whiteoutTar = join(directory, 'whiteout.tar');
    execFileSync('tar', ['-cf', whiteoutTar, '-C', whiteoutRoot, ...archiveRoots]);
    imageLayers.push(
      writeBlob(
        layout,
        gzipSync(readFileSync(whiteoutTar)),
        'application/vnd.oci.image.layer.v1.tar+gzip',
      ),
    );
  }

  const descriptors = [];
  for (const architecture of ['amd64', 'arm64']) {
    const config = jsonBlob(
      layout,
      { architecture, os: 'linux' },
      'application/vnd.oci.image.config.v1+json',
    );
    const manifest = jsonBlob(
      layout,
      { schemaVersion: 2, config, layers: imageLayers },
      'application/vnd.oci.image.manifest.v1+json',
    );
    descriptors.push({ ...manifest, platform: { architecture, os: 'linux' } });

    const attestationConfig = jsonBlob(
      layout,
      { architecture: 'unknown', os: 'unknown' },
      'application/vnd.oci.image.config.v1+json',
    );
    const sbom = jsonBlob(
      layout,
      {
        _type: 'https://in-toto.io/Statement/v0.1',
        predicateType: 'https://spdx.dev/Document',
        predicate: {},
      },
      'application/vnd.in-toto+json',
    );
    const provenance = jsonBlob(
      layout,
      {
        _type: 'https://in-toto.io/Statement/v0.1',
        predicateType: 'https://slsa.dev/provenance/v1',
        predicate: {},
      },
      'application/vnd.in-toto+json',
    );
    const attestationManifest = jsonBlob(
      layout,
      {
        schemaVersion: 2,
        config: attestationConfig,
        layers: architecture === 'arm64' && omitArmProvenance ? [sbom] : [sbom, provenance],
      },
      'application/vnd.oci.image.manifest.v1+json',
    );
    descriptors.push({
      ...attestationManifest,
      annotations: {
        'vnd.docker.reference.digest': manifest.digest,
        'vnd.docker.reference.type': 'attestation-manifest',
      },
      platform: { architecture: 'unknown', os: 'unknown' },
    });
  }

  let rootDescriptors = descriptors;
  for (let depth = 0; depth < imageIndexDepth; depth += 1) {
    rootDescriptors = [
      jsonBlob(
        layout,
        {
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: rootDescriptors,
        },
        'application/vnd.oci.image.index.v1+json',
      ),
    ];
  }
  writeFileSync(
    join(layout, 'index.json'),
    `${JSON.stringify({ schemaVersion: 2, manifests: rootDescriptors })}\n`,
  );
  const archive = join(directory, 'synthetic.oci.tar');
  execFileSync('tar', ['-cf', archive, '-C', layout, 'oci-layout', 'index.json', 'blobs']);
  return archive;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('release privacy artifact audit', () => {
  it('uses an opaque history handle for a sensitive filename', () => {
    const sensitiveName = ['Outdoor Cycling-Heart Rate-', '20250101', '_101500.csv'].join('');
    const violations = scanHistoryContent(`private/${sensitiveName}`, Buffer.from('invented\n'));
    expect(violations).toHaveLength(2);
    expect(violations[0]?.path).toMatch(/^history-entry\/[0-9a-f]{16}$/);
    expect(JSON.stringify(violations)).not.toContain(sensitiveName);
    expect(JSON.stringify(violations)).not.toContain('20250101');
  });

  it('accepts an ordinary extracted artifact', () => {
    const directory = makeArtifactDirectory();
    writeFileSync(join(directory, 'release-notes.txt'), 'synthetic release notes\n');
    expect(auditArtifact(directory)).toBe(0);
  });

  it('fails without echoing a matched leak marker', () => {
    const directory = makeArtifactDirectory();
    writeFileSync(join(directory, 'release-notes.txt'), LEAK_MARKER);
    const messages = [];
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation((message) => messages.push(message));
    try {
      expect(auditArtifact(directory)).toBe(1);
    } finally {
      error.mockRestore();
    }
    expect(messages.join('\n')).toContain('leak-marker-canary');
    expect(messages.join('\n')).not.toContain(LEAK_MARKER);
  });

  it('fails closed before attempting to buffer an oversized entry', () => {
    expect(() =>
      assertAuditableSize(MAX_AUDIT_ENTRY_BYTES + 1, 'synthetic_entry_exceeds_64_mib'),
    ).toThrow('synthetic_entry_exceeds_64_mib');
  });

  it('rejects unsafe archive paths without ignoring root-marker lookalikes', () => {
    expect(normalizedArchivePath('./app/api/release.txt')).toBe('app/api/release.txt');
    for (const path of ['../escape', '/absolute', '\\\\server\\share', 'C:\\absolute', '.\\']) {
      expect(() => normalizedArchivePath(path)).toThrow('unsafe_archive_entry_path');
    }
  });

  it('audits an exact two-platform OCI archive with SBOM and provenance', async () => {
    await expect(auditOciArchive(createSyntheticOciArchive())).resolves.toBe(0);
  });

  it('rejects OCI indexes nested beyond the supported BuildKit wrapper', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ imageIndexDepth: 2 })),
    ).rejects.toThrow('oci_index_invalid');
  });

  it('requires provenance for each target platform', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ omitArmProvenance: true, imageIndexDepth: 0 })),
    ).rejects.toThrow('oci_linux_arm64_missing_provenance_attestation');
  });

  it('requires exact third-party notices in each platform image', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ omitWebNotices: true })),
    ).rejects.toThrow('container_third_party_notices_missing');
  });

  it('requires native Node and tini notice files in each platform image', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ omitSystemNotices: true })),
    ).rejects.toThrow('container_system_notices_missing');
  });

  it('does not accept a notice deleted by a later image layer', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ whiteoutWebNotices: true })),
    ).rejects.toThrow('container_third_party_notices_missing');
  });

  it.each(['app/.wh.api', 'app/api/dist/.wh.web', '.wh.app'])(
    'tracks a parent-directory whiteout at %s',
    async (whiteoutPath) => {
      await expect(auditOciArchive(createSyntheticOciArchive({ whiteoutPath }))).rejects.toThrow(
        'container_third_party_notices_missing',
      );
    },
  );

  it('rejects an unrecorded web script added by a later image layer', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ addWebScript: true })),
    ).rejects.toThrow('container_web_artifact_license_evidence_invalid');
  });

  it('forgets notices when a later regular file replaces their parent directory', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ replaceWebDirectory: true })),
    ).rejects.toThrow('container_third_party_notices_missing');
  });

  it('forgets a notice when a later directory replaces that file', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ replaceNodeNoticeWithDirectory: true })),
    ).rejects.toThrow('container_system_notices_missing');
  });

  it('accepts a recognized native addon in a production deployment', () => {
    const directory = makeArtifactDirectory();
    const addon = join(
      directory,
      'node_modules',
      '.pnpm',
      'better-sqlite3@12.11.1',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    );
    mkdirSync(dirname(addon), { recursive: true });
    writeFileSync(addon, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00]));
    writeFileSync(join(directory, 'THIRD_PARTY_NOTICES.md'), canonicalNotices);

    expect(auditProductionDeploy(directory)).toBe(0);
  });

  it('rejects a production-deployment symlink outside its root', () => {
    const directory = makeArtifactDirectory();
    const outside = makeArtifactDirectory();
    writeFileSync(join(outside, 'payload.txt'), 'synthetic outside payload\n');
    symlinkSync(outside, join(directory, 'outside'));

    expect(() => auditProductionDeploy(directory)).toThrow('production_deploy_external_symlink');
  });

  it('rejects a symlink in place of production third-party notices', () => {
    const directory = makeArtifactDirectory();
    const noticeTarget = join(directory, 'canonical-notice-copy');
    writeFileSync(noticeTarget, canonicalNotices);
    symlinkSync(noticeTarget, join(directory, 'THIRD_PARTY_NOTICES.md'));

    expect(() => auditProductionDeploy(directory)).toThrow('production_deploy_notices_invalid');
  });
});
