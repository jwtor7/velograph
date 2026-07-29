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
} from './privacy-audit-release.mjs';

const temporaryDirectories = [];

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

function createSyntheticOciArchive({ omitArmProvenance = false } = {}) {
  const directory = makeArtifactDirectory();
  const layout = join(directory, 'layout');
  const blobs = join(layout, 'blobs', 'sha256');
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');

  const layerRoot = join(directory, 'layer-root');
  mkdirSync(join(layerRoot, 'app', 'api'), { recursive: true });
  writeFileSync(join(layerRoot, 'app', 'api', 'release.txt'), 'synthetic container payload\n');
  const layerTar = join(directory, 'layer.tar');
  execFileSync('tar', ['-cf', layerTar, '-C', layerRoot, 'app']);
  const layer = writeBlob(
    layout,
    gzipSync(readFileSync(layerTar)),
    'application/vnd.oci.image.layer.v1.tar+gzip',
  );

  const descriptors = [];
  for (const architecture of ['amd64', 'arm64']) {
    const config = jsonBlob(
      layout,
      { architecture, os: 'linux' },
      'application/vnd.oci.image.config.v1+json',
    );
    const manifest = jsonBlob(
      layout,
      { schemaVersion: 2, config, layers: [layer] },
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

  writeFileSync(
    join(layout, 'index.json'),
    `${JSON.stringify({ schemaVersion: 2, manifests: descriptors })}\n`,
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

  it('audits an exact two-platform OCI archive with SBOM and provenance', async () => {
    await expect(auditOciArchive(createSyntheticOciArchive())).resolves.toBe(0);
  });

  it('requires provenance for each target platform', async () => {
    await expect(
      auditOciArchive(createSyntheticOciArchive({ omitArmProvenance: true })),
    ).rejects.toThrow('oci_linux_arm64_missing_provenance_attestation');
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

    expect(auditProductionDeploy(directory)).toBe(0);
  });

  it('rejects a production-deployment symlink outside its root', () => {
    const directory = makeArtifactDirectory();
    const outside = makeArtifactDirectory();
    writeFileSync(join(outside, 'payload.txt'), 'synthetic outside payload\n');
    symlinkSync(outside, join(directory, 'outside'));

    expect(() => auditProductionDeploy(directory)).toThrow('production_deploy_external_symlink');
  });
});
