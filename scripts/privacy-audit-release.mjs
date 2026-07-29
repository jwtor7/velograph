#!/usr/bin/env node
/**
 * Release privacy audit (PRD §12.2 and §18.13).
 *
 * Extends the tracked-worktree scanner to public release surfaces that are
 * easy to overlook: every reachable Git blob, extracted release artifacts,
 * native Docker image application payloads, and the exact multi-platform OCI
 * archive retained by CI. Reports rule + opaque audit path only; never prints
 * matched content or host filesystem paths.
 *
 * Usage:
 *   node scripts/privacy-audit-release.mjs --working-tree
 *   node scripts/privacy-audit-release.mjs --history
 *   node scripts/privacy-audit-release.mjs --artifact path/to/extracted-output
 *   node scripts/privacy-audit-release.mjs --image velograph:local
 *   node scripts/privacy-audit-release.mjs --oci-image path/to/image.oci.tar
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { scanFile } from './privacy-scan.mjs';
import { verifyWebArtifactContents } from './third-party-license-gate.mjs';

export const MAX_AUDIT_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_OCI_ATTESTATION_BYTES = 16 * 1024 * 1024;
const OPAQUE_REPORT_SALT = randomBytes(32);
const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_NOTICES_PATH = join(REPOSITORY_ROOT, 'THIRD_PARTY_NOTICES.md');
export const REQUIRED_CONTAINER_NOTICE_PATHS = [
  'app/api/THIRD_PARTY_NOTICES.md',
  'app/api/dist/web/THIRD_PARTY_NOTICES.md',
];
export const REQUIRED_CONTAINER_SYSTEM_NOTICE_PATHS = [
  'usr/local/LICENSE',
  'usr/share/doc/tini/copyright',
];
const WEB_ARTIFACT_PREFIX = 'app/api/dist/web/';
const COMMAND_BUFFER_BYTES = MAX_AUDIT_ENTRY_BYTES + 1;
const TARGET_PLATFORMS = ['linux/amd64', 'linux/arm64'];
const MAX_OCI_DESCRIPTOR_COUNT = 128;
const OCI_INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const OCI_MANIFEST_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const APP_ENTRYPOINTS = new Set([
  'usr/local/bin/docker-entrypoint.sh',
  'usr/local/bin/docker-proxy.mjs',
]);

class AuditFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'AuditFailure';
    this.code = code;
  }
}

function fail(code) {
  throw new AuditFailure(code);
}

function canonicalNotices() {
  let content;
  try {
    const stat = lstatSync(CANONICAL_NOTICES_PATH);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('canonical_notices_invalid');
    assertAuditableSize(stat.size, 'canonical_notices_exceeds_64_mib');
    content = readFileSync(CANONICAL_NOTICES_PATH);
  } catch (error) {
    if (error instanceof AuditFailure) throw error;
    fail('canonical_notices_unreadable');
  }
  return content;
}

export function assertAuditableSize(size, code = 'entry_exceeds_64_mib') {
  if (!Number.isSafeInteger(size) || size < 0) fail('invalid_entry_size');
  if (size > MAX_AUDIT_ENTRY_BYTES) fail(code);
}

function commandText(program, args, code, options = {}) {
  try {
    return execFileSync(program, args, {
      encoding: 'utf8',
      maxBuffer: COMMAND_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...options,
    });
  } catch {
    fail(code);
  }
}

function commandBuffer(program, args, code, options = {}) {
  try {
    return execFileSync(program, args, {
      maxBuffer: COMMAND_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...options,
    });
  } catch {
    fail(code);
  }
}

function report(scope, violations) {
  if (violations.length === 0) {
    console.log(`release-privacy-audit: ${scope} clean`);
    return 0;
  }
  console.error(`RELEASE PRIVACY AUDIT FAILED — ${scope}: ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(
      `  ${violation.path}${violation.line ? ':' + violation.line : ''}  [${violation.rule}]`,
    );
  }
  console.error('No matched values are printed. Treat any published data as exposed.');
  return 1;
}

export function normalizedArchivePath(path) {
  const separatorNormalized = path.replaceAll('\\', '/');
  if (separatorNormalized.startsWith('/') || /^[A-Za-z]:\//.test(separatorNormalized)) {
    fail('unsafe_archive_entry_path');
  }
  const normalized = separatorNormalized.replace(/^\.\/+/, '');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    segments.some((segment) => segment === '..')
  ) {
    fail('unsafe_archive_entry_path');
  }
  return normalized;
}

function opaquePath(scope, identity) {
  const digest = createHash('sha256')
    .update(OPAQUE_REPORT_SALT)
    .update('\0')
    .update(identity)
    .digest('hex')
    .slice(0, 16);
  return `${scope}/${digest}`;
}

function hasNativeAddonMagic(content) {
  if (content.length < 4) return false;
  const magic = content.subarray(0, 4).toString('hex');
  return (
    new Set([
      '7f454c46', // ELF (Linux)
      'cafebabe', // Mach-O universal
      'cffaedfe', // Mach-O 64-bit, little endian
      'cefaedfe', // Mach-O 32-bit, little endian
      'feedfacf', // Mach-O 64-bit, big endian
      'feedface', // Mach-O 32-bit, big endian
    ]).has(magic) || content.subarray(0, 2).toString('latin1') === 'MZ'
  );
}

function isExpectedBetterSqliteAddon(path, content) {
  return (
    path.startsWith('app/api/node_modules/') &&
    path.includes('/better-sqlite3/') &&
    path.endsWith('/better_sqlite3.node') &&
    hasNativeAddonMagic(content)
  );
}

function scanContent(logicalPath, content, reportPath = logicalPath) {
  let violations = scanFile(logicalPath.replaceAll('\\', '/'), content);
  if (isExpectedBetterSqliteAddon(logicalPath, content)) {
    violations = violations.filter(({ rule }) => rule !== 'unexpected-binary-file');
  }
  if (
    /^app\/api\/node_modules\/\.pnpm\/bindings@1\.5\.0\/node_modules\/bindings\/bindings\.js$/.test(
      logicalPath,
    ) &&
    createHash('sha256').update(content).digest('hex') ===
      '8e32a0d37f20bd6f7d5bdbf99d041aa27be47cbbe5172ac13ebf7380a10b3bf6'
  ) {
    // Upstream's locked public source contains one example `/home/...` path
    // in a comment. Suppress only that rule and only for the reviewed bytes;
    // any package update or content change is audited normally.
    violations = violations.filter(({ rule }) => rule !== 'home-directory-absolute-path');
  }
  return violations.map((violation) => ({ ...violation, path: reportPath }));
}

export function scanHistoryContent(path, content) {
  return scanContent(path, content, opaquePath('history-entry', path));
}

function walkArtifactFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkArtifactFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    } else {
      fail('artifact_non_regular_entry');
    }
  }
  return files;
}

export function auditArtifact(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail('artifact_unreadable');
  }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    fail('artifact_non_regular_entry');
  }

  const files = stat.isDirectory() ? walkArtifactFiles(path) : [path];
  const violations = [];
  for (const file of files) {
    let fileStat;
    try {
      fileStat = lstatSync(file);
    } catch {
      fail('artifact_entry_unreadable');
    }
    if (!fileStat.isFile()) fail('artifact_non_regular_entry');
    assertAuditableSize(fileStat.size, 'artifact_entry_exceeds_64_mib');

    const artifactPath = stat.isDirectory() ? relative(path, file) : basename(file);
    const auditPath = `artifact/${artifactPath || basename(file)}`.replaceAll('\\', '/');
    let content;
    try {
      content = readFileSync(file);
    } catch {
      fail('artifact_entry_unreadable');
    }
    assertAuditableSize(content.length, 'artifact_entry_exceeds_64_mib');
    violations.push(...scanContent(auditPath, content, opaquePath('artifact-entry', artifactPath)));
  }
  return report(`artifact (${files.length} file(s))`, violations);
}

function walkProductionDeployment(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkProductionDeployment(root, absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    } else if (entry.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(absolute);
      } catch {
        fail('production_deploy_broken_symlink');
      }
      const targetPath = relative(root, target);
      if (isAbsolute(targetPath) || targetPath === '..' || targetPath.startsWith(`..${sep}`)) {
        fail('production_deploy_external_symlink');
      }
      // pnpm's physical package targets are traversed under node_modules/.pnpm.
      // Avoid scanning the same bytes again through each symlink alias.
    } else {
      fail('production_deploy_non_regular_entry');
    }
  }
  return files;
}

export function auditProductionDeploy(path) {
  let root;
  try {
    root = realpathSync(path);
  } catch {
    fail('production_deploy_unreadable');
  }
  if (!lstatSync(root).isDirectory()) fail('production_deploy_not_directory');

  const files = walkProductionDeployment(root);
  let packagedNotices;
  try {
    const noticesPath = join(root, 'THIRD_PARTY_NOTICES.md');
    const stat = lstatSync(noticesPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('production_deploy_notices_invalid');
    }
    assertAuditableSize(stat.size, 'production_deploy_notices_exceeds_64_mib');
    packagedNotices = readFileSync(noticesPath);
  } catch (error) {
    if (error instanceof AuditFailure) throw error;
    fail('production_deploy_notices_missing');
  }
  if (!packagedNotices.equals(canonicalNotices())) {
    fail('production_deploy_notices_mismatch');
  }
  const violations = [];
  for (const file of files) {
    const deploymentPath = relative(root, file).replaceAll('\\', '/');
    const logicalPath = `app/api/${deploymentPath}`;
    let content;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) fail('production_deploy_non_regular_entry');
      assertAuditableSize(stat.size, 'production_deploy_entry_exceeds_64_mib');
      content = readFileSync(file);
    } catch (error) {
      if (error instanceof AuditFailure) throw error;
      fail('production_deploy_entry_unreadable');
    }
    assertAuditableSize(content.length, 'production_deploy_entry_exceeds_64_mib');
    violations.push(
      ...scanContent(logicalPath, content, opaquePath('production-entry', deploymentPath)),
    );
  }
  return report(`production API deployment (${files.length} file(s))`, violations);
}

export function auditHistory() {
  const lines = commandText(
    'git',
    ['rev-list', '--objects', '--all'],
    'history_object_list_unreadable',
  )
    .split('\n')
    .filter(Boolean);
  const seen = new Set();
  const violations = [];

  for (const line of lines) {
    const separator = line.indexOf(' ');
    const objectId = separator === -1 ? line : line.slice(0, separator);
    const listedPath = separator === -1 ? '' : line.slice(separator + 1);
    const path = listedPath || `unpathed/${objectId.slice(0, 16)}.blob`;
    if (seen.has(`${objectId}\0${path}`)) continue;

    const objectType = commandText(
      'git',
      ['cat-file', '-t', objectId],
      'history_object_type_unreadable',
    ).trim();
    if (objectType !== 'blob') continue;

    const rawSize = commandText(
      'git',
      ['cat-file', '-s', objectId],
      'history_blob_size_unreadable',
    ).trim();
    const size = Number(rawSize);
    assertAuditableSize(size, 'history_blob_exceeds_64_mib');

    const content = commandBuffer('git', ['cat-file', 'blob', objectId], 'history_blob_unreadable');
    if (content.length !== size) fail('history_blob_size_mismatch');

    seen.add(`${objectId}\0${path}`);
    // Keep the repository-relative path for scanner policy (notably the
    // synthetic fixture allowlist), then prefix only the human-safe report.
    violations.push(...scanHistoryContent(path, content));
  }
  return report(`history (${seen.size} reachable blob path(s))`, violations);
}

function listTarEntries(archive, code) {
  const entries = commandText('tar', ['-tf', archive], code).split('\n').filter(Boolean);
  const index = new Map();
  for (const entry of entries) {
    // BuildKit-generated layer archives can include the conventional `./`
    // root-directory marker. It names no payload and is safe to ignore; all
    // descendants still pass the strict traversal checks below.
    if (entry === '.' || entry === './') continue;
    const canonical = normalizedArchivePath(entry);
    if (index.has(canonical)) fail('duplicate_archive_entry');
    index.set(canonical, entry);
  }
  return index;
}

function readTarEntry(archive, archiveIndex, canonicalPath, code) {
  const entry = archiveIndex.get(canonicalPath);
  if (!entry) fail(code);
  return commandBuffer('tar', ['-xOf', archive, '--', entry], code);
}

function extractTarEntry(archive, archiveIndex, canonicalPath, destination, code) {
  const entry = archiveIndex.get(canonicalPath);
  if (!entry) fail(code);
  let descriptor;
  try {
    descriptor = openSync(destination, 'wx', 0o600);
    const result = spawnSync('tar', ['-xOf', archive, '--', entry], {
      stdio: ['ignore', descriptor, 'ignore'],
    });
    if (result.error || result.status !== 0) fail(code);
  } catch (error) {
    if (error instanceof AuditFailure) throw error;
    fail(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(content, code) {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    fail(code);
  }
}

function isApplicationEntry(path) {
  return path === 'app' || path.startsWith('app/') || APP_ENTRYPOINTS.has(path);
}

function shouldTrackContainerEntry(path) {
  return (
    REQUIRED_CONTAINER_NOTICE_PATHS.includes(path) ||
    REQUIRED_CONTAINER_SYSTEM_NOTICE_PATHS.includes(path) ||
    path.startsWith(WEB_ARTIFACT_PREFIX)
  );
}

function applyContainerWhiteout(entry, containerState) {
  const name = basename(entry);
  if (!name.startsWith('.wh.')) return false;
  const directory = dirname(entry);
  const prefix = directory === '.' ? '' : `${directory}/`;
  if (name === '.wh..wh..opq') {
    for (const path of containerState.keys()) {
      if (path.startsWith(prefix)) containerState.delete(path);
    }
  } else {
    const target = `${prefix}${name.slice('.wh.'.length)}`;
    for (const path of containerState.keys()) {
      if (path === target || path.startsWith(`${target}/`)) {
        containerState.delete(path);
      }
    }
  }
  return true;
}

function applyContainerReplacement(entry, containerState) {
  for (const path of containerState.keys()) {
    if (path === entry || path.startsWith(`${entry}/`)) {
      containerState.delete(path);
    }
  }
}

function auditLayerTar(layerTar, layerIdentity, violations, containerState) {
  const entries = listTarEntries(layerTar, 'container_layer_index_unreadable');
  for (const [entry] of entries) {
    if (applyContainerWhiteout(entry, containerState)) continue;
    const directoryEntry = entry.endsWith('/');
    const replacementPath = directoryEntry ? entry.slice(0, -1) : entry;
    if (directoryEntry) {
      containerState.delete(replacementPath);
    } else {
      applyContainerReplacement(replacementPath, containerState);
    }
    if (directoryEntry) continue;
    const tracked = shouldTrackContainerEntry(entry);
    if (!isApplicationEntry(entry) && !tracked) continue;
    const content = readTarEntry(
      layerTar,
      entries,
      entry,
      'container_entry_unreadable_or_exceeds_64_mib',
    );
    assertAuditableSize(content.length, 'container_entry_exceeds_64_mib');
    if (tracked) {
      containerState.set(entry, content);
    }
    if (isApplicationEntry(entry)) {
      violations.push(
        ...scanContent(entry, content, opaquePath('container-entry', `${layerIdentity}\0${entry}`)),
      );
    }
  }
}

function verifyContainerNotices(containerState) {
  const expected = canonicalNotices();
  for (const path of REQUIRED_CONTAINER_NOTICE_PATHS) {
    const content = containerState.get(path);
    if (!content) fail('container_third_party_notices_missing');
    if (!content.equals(expected)) fail('container_third_party_notices_mismatch');
  }
  for (const path of REQUIRED_CONTAINER_SYSTEM_NOTICE_PATHS) {
    if (!containerState.get(path)?.length) fail('container_system_notices_missing');
  }

  const webContents = new Map(
    [...containerState]
      .filter(([path]) => path.startsWith(WEB_ARTIFACT_PREFIX))
      .map(([path, content]) => [path.slice(WEB_ARTIFACT_PREFIX.length), content]),
  );
  try {
    verifyWebArtifactContents(webContents, REPOSITORY_ROOT);
  } catch {
    fail('container_web_artifact_license_evidence_invalid');
  }
}

export function auditImage(image) {
  const directory = mkdtempSync(join(tmpdir(), 'velograph-image-audit-'));
  const archive = join(directory, 'image.tar');
  try {
    commandText(
      'docker',
      ['image', 'save', '--output', archive, image],
      'docker_image_save_failed',
    );
    const archiveIndex = listTarEntries(archive, 'docker_archive_index_unreadable');
    const manifestContent = readTarEntry(
      archive,
      archiveIndex,
      'manifest.json',
      'docker_manifest_unreadable',
    );
    assertAuditableSize(manifestContent.length, 'docker_manifest_exceeds_64_mib');
    const manifest = parseJson(manifestContent, 'docker_manifest_invalid');
    if (!Array.isArray(manifest) || manifest.length !== 1) fail('docker_manifest_invalid');

    const imageRecord = manifest[0];
    if (
      !imageRecord ||
      typeof imageRecord.Config !== 'string' ||
      !Array.isArray(imageRecord.Layers)
    ) {
      fail('docker_manifest_invalid');
    }

    const violations = [];
    const config = readTarEntry(
      archive,
      archiveIndex,
      normalizedArchivePath(imageRecord.Config),
      'docker_config_unreadable',
    );
    assertAuditableSize(config.length, 'docker_config_exceeds_64_mib');
    violations.push(
      ...scanContent(
        'container/config.json',
        config,
        opaquePath('container-config', imageRecord.Config),
      ),
    );

    const noticeState = new Map();
    for (const [index, rawLayerName] of imageRecord.Layers.entries()) {
      if (typeof rawLayerName !== 'string') fail('docker_manifest_invalid');
      const layerName = normalizedArchivePath(rawLayerName);
      const layer = join(directory, `layer-${index}.tar`);
      extractTarEntry(archive, archiveIndex, layerName, layer, 'docker_layer_unreadable');
      auditLayerTar(layer, `native:${index}`, violations, noticeState);
    }
    verifyContainerNotices(noticeState);

    return report(
      `container application payload (${imageRecord.Layers.length} layer(s))`,
      violations,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function descriptorDigest(descriptor, code) {
  const digest = descriptor?.digest;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) fail(code);
  return digest;
}

function blobArchivePath(descriptor, code) {
  return `blobs/sha256/${descriptorDigest(descriptor, code).slice('sha256:'.length)}`;
}

function verifyBufferDigest(content, descriptor, code) {
  const expected = descriptorDigest(descriptor, code);
  const actual = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (actual !== expected) fail(code);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function verifyFileDigest(path, descriptor, code) {
  const expected = descriptorDigest(descriptor, code);
  let actual;
  try {
    actual = await sha256File(path);
  } catch {
    fail(code);
  }
  if (actual !== expected) fail(code);
}

function readOciBlob(archive, archiveIndex, descriptor, code) {
  const content = readTarEntry(archive, archiveIndex, blobArchivePath(descriptor, code), code);
  assertAuditableSize(content.length, 'oci_blob_exceeds_64_mib');
  verifyBufferDigest(content, descriptor, 'oci_blob_digest_mismatch');
  return content;
}

function resolveOciManifestDescriptors(archive, archiveIndex, descriptors, violations) {
  if (
    descriptors.length === 0 ||
    descriptors.length > MAX_OCI_DESCRIPTOR_COUNT ||
    descriptors.some((descriptor) => !descriptor || typeof descriptor !== 'object')
  ) {
    fail('oci_index_invalid');
  }

  const wrapperDescriptors = descriptors.filter((descriptor) =>
    OCI_INDEX_MEDIA_TYPES.has(descriptor.mediaType),
  );
  if (wrapperDescriptors.length === 0) return descriptors;
  if (descriptors.length !== 1 || wrapperDescriptors.length !== 1) {
    fail('oci_index_shape_invalid');
  }

  const wrapper = wrapperDescriptors[0];
  const wrapperDigest = descriptorDigest(wrapper, 'oci_index_descriptor_invalid');
  const content = readOciBlob(archive, archiveIndex, wrapper, 'oci_index_unreadable');
  const nestedIndex = parseJson(content, 'oci_index_invalid');
  if (
    nestedIndex?.schemaVersion !== 2 ||
    !Array.isArray(nestedIndex.manifests) ||
    nestedIndex.manifests.length === 0 ||
    nestedIndex.manifests.length > MAX_OCI_DESCRIPTOR_COUNT ||
    nestedIndex.manifests.some(
      (descriptor) =>
        !descriptor ||
        typeof descriptor !== 'object' ||
        OCI_INDEX_MEDIA_TYPES.has(descriptor.mediaType),
    )
  ) {
    fail('oci_index_invalid');
  }
  violations.push(
    ...scanContent('oci/index.json', content, opaquePath('oci-index', wrapperDigest)),
  );
  return nestedIndex.manifests;
}

function evidenceKind(content) {
  const statement = parseJson(content, 'oci_attestation_invalid');
  const predicateType = statement?.predicateType;
  if (
    typeof statement?._type !== 'string' ||
    !statement._type.startsWith('https://in-toto.io/Statement/') ||
    typeof predicateType !== 'string' ||
    !statement.predicate ||
    typeof statement.predicate !== 'object' ||
    Array.isArray(statement.predicate)
  ) {
    fail('oci_attestation_invalid');
  }
  const normalized = predicateType.toLowerCase();
  if (normalized.includes('spdx')) return 'sbom';
  if (normalized.includes('slsa.dev/provenance')) return 'provenance';
  return 'other';
}

function scanOciAttestation(content, reportPath) {
  if (content.length > MAX_OCI_ATTESTATION_BYTES) {
    fail('oci_attestation_exceeds_16_mib');
  }
  const kind = evidenceKind(content);
  const violations = scanContent('oci/attestation.json', content, reportPath).filter(
    ({ rule }) => rule !== 'oversized-text-file',
  );
  return { kind, violations };
}

function platformKey(descriptor) {
  const os = descriptor?.platform?.os;
  const architecture = descriptor?.platform?.architecture;
  return typeof os === 'string' && typeof architecture === 'string' ? `${os}/${architecture}` : '';
}

function isAttestationDescriptor(descriptor) {
  return (
    descriptor?.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' ||
    platformKey(descriptor) === 'unknown/unknown'
  );
}

function attestationSubject(descriptor) {
  const subject = descriptor?.annotations?.['vnd.docker.reference.digest'];
  if (typeof subject !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(subject)) {
    fail('oci_attestation_subject_invalid');
  }
  return subject;
}

async function materializeOciLayer(archive, archiveIndex, descriptor, directory, sequence) {
  const blob = join(directory, `blob-${sequence}`);
  extractTarEntry(
    archive,
    archiveIndex,
    blobArchivePath(descriptor, 'oci_layer_descriptor_invalid'),
    blob,
    'oci_layer_unreadable',
  );
  await verifyFileDigest(blob, descriptor, 'oci_layer_digest_mismatch');

  const mediaType = descriptor?.mediaType;
  if (
    mediaType === 'application/vnd.oci.image.layer.v1.tar' ||
    mediaType === 'application/vnd.docker.image.rootfs.diff.tar'
  ) {
    return blob;
  }
  if (
    mediaType === 'application/vnd.oci.image.layer.v1.tar+gzip' ||
    mediaType === 'application/vnd.docker.image.rootfs.diff.tar.gzip'
  ) {
    const layerTar = join(directory, `layer-${sequence}.tar`);
    try {
      await pipeline(
        createReadStream(blob),
        createGunzip(),
        createWriteStream(layerTar, { mode: 0o600 }),
      );
    } catch {
      fail('oci_layer_decompression_failed');
    }
    return layerTar;
  }
  fail('oci_unsupported_layer_media_type');
}

export async function auditOciArchive(archive) {
  const directory = mkdtempSync(join(tmpdir(), 'velograph-oci-audit-'));
  try {
    const archiveIndex = listTarEntries(archive, 'oci_archive_index_unreadable');
    const layoutContent = readTarEntry(
      archive,
      archiveIndex,
      'oci-layout',
      'oci_layout_unreadable',
    );
    const layout = parseJson(layoutContent, 'oci_layout_invalid');
    if (layout?.imageLayoutVersion !== '1.0.0') fail('oci_layout_invalid');

    const indexContent = readTarEntry(archive, archiveIndex, 'index.json', 'oci_index_unreadable');
    assertAuditableSize(indexContent.length, 'oci_index_exceeds_64_mib');
    const index = parseJson(indexContent, 'oci_index_invalid');
    if (index?.schemaVersion !== 2 || !Array.isArray(index.manifests)) {
      fail('oci_index_invalid');
    }

    const violations = [
      ...scanContent('oci/index.json', indexContent, opaquePath('oci-index', 'index.json')),
    ];
    const manifestDescriptors = resolveOciManifestDescriptors(
      archive,
      archiveIndex,
      index.manifests,
      violations,
    );
    const imagesByPlatform = new Map();
    const noticesByPlatform = new Map();
    const evidenceBySubject = new Map();
    let layerSequence = 0;

    for (const descriptor of manifestDescriptors) {
      if (!OCI_MANIFEST_MEDIA_TYPES.has(descriptor.mediaType)) {
        fail('oci_manifest_descriptor_invalid');
      }
      const manifestDigest = descriptorDigest(descriptor, 'oci_manifest_descriptor_invalid');
      const manifestContent = readOciBlob(
        archive,
        archiveIndex,
        descriptor,
        'oci_manifest_unreadable',
      );
      const manifest = parseJson(manifestContent, 'oci_manifest_invalid');
      if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.layers) || !manifest.config) {
        fail('oci_manifest_invalid');
      }

      violations.push(
        ...scanContent(
          'oci/manifest.json',
          manifestContent,
          opaquePath('oci-manifest', manifestDigest),
        ),
      );
      const configContent = readOciBlob(
        archive,
        archiveIndex,
        manifest.config,
        'oci_config_unreadable',
      );
      violations.push(
        ...scanContent('oci/config.json', configContent, opaquePath('oci-config', manifestDigest)),
      );

      if (isAttestationDescriptor(descriptor)) {
        const subject = attestationSubject(descriptor);
        const evidence = evidenceBySubject.get(subject) ?? new Set();
        for (const layerDescriptor of manifest.layers) {
          if (layerDescriptor?.mediaType !== 'application/vnd.in-toto+json') {
            fail('oci_attestation_media_type_invalid');
          }
          const content = readOciBlob(
            archive,
            archiveIndex,
            layerDescriptor,
            'oci_attestation_unreadable',
          );
          const attestation = scanOciAttestation(
            content,
            opaquePath(
              'oci-attestation',
              descriptorDigest(layerDescriptor, 'oci_attestation_invalid'),
            ),
          );
          violations.push(...attestation.violations);
          evidence.add(attestation.kind);
        }
        evidenceBySubject.set(subject, evidence);
        continue;
      }

      const platform = platformKey(descriptor);
      if (imagesByPlatform.has(platform)) fail('oci_duplicate_platform_manifest');
      imagesByPlatform.set(platform, manifestDigest);
      const noticeState = new Map();
      for (const layerDescriptor of manifest.layers) {
        const layerTar = await materializeOciLayer(
          archive,
          archiveIndex,
          layerDescriptor,
          directory,
          layerSequence,
        );
        auditLayerTar(layerTar, `${platform}:${layerSequence}`, violations, noticeState);
        layerSequence += 1;
      }
      noticesByPlatform.set(platform, noticeState);
    }

    for (const platform of TARGET_PLATFORMS) {
      const subject = imagesByPlatform.get(platform);
      if (!subject) fail(`oci_missing_${platform.replace('/', '_')}`);
      const evidence = evidenceBySubject.get(subject);
      if (!evidence?.has('sbom'))
        fail(`oci_${platform.replace('/', '_')}_missing_sbom_attestation`);
      if (!evidence?.has('provenance')) {
        fail(`oci_${platform.replace('/', '_')}_missing_provenance_attestation`);
      }
      verifyContainerNotices(noticesByPlatform.get(platform) ?? new Map());
    }

    return report(
      `exact OCI archive (${TARGET_PLATFORMS.length} platform(s), SBOM + provenance)`,
      violations,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function run(argv) {
  const [mode, value] = argv;
  try {
    if (mode === '--working-tree') {
      const output = commandText(
        'node',
        ['scripts/privacy-scan.mjs', '--all'],
        'working_tree_audit_failed',
      );
      process.stdout.write(output);
      return 0;
    }
    if (mode === '--history') return auditHistory();
    if (mode === '--artifact' && value) return auditArtifact(value);
    if (mode === '--production-deploy' && value) return auditProductionDeploy(value);
    if (mode === '--image' && value) return auditImage(value);
    if (mode === '--oci-image' && value) return auditOciArchive(value);
  } catch (error) {
    const code = error instanceof AuditFailure ? error.code : 'unexpected_audit_error';
    console.error(`RELEASE PRIVACY AUDIT FAILED — [${code}]`);
    return 1;
  }
  console.error(
    'Usage: --working-tree | --history | --artifact <path> | --production-deploy <path> | --image <reference> | --oci-image <archive>',
  );
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await run(process.argv.slice(2)));
}
