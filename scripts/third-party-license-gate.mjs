#!/usr/bin/env node
/**
 * Fail-closed third-party runtime licence and notice verification.
 *
 * This gate covers dependencies that are shipped in the built web client,
 * retained API production deployment, or CLI runtime package. It deliberately
 * does not select or imply a licence for Velograph itself.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const REPOSITORY_ROOT = join(scriptDirectory, '..');
export const MANIFEST_PATH = join(REPOSITORY_ROOT, 'third-party-licenses.json');
export const NOTICES_PATH = join(REPOSITORY_ROOT, 'THIRD_PARTY_NOTICES.md');
export const LICENSE_TEXT_DIRECTORY = join(REPOSITORY_ROOT, 'third_party_licenses');

const APPROVED_SELECTED_LICENSES = new Set([
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'OFL-1.1',
  'blessing',
]);
const FORBIDDEN_LICENSE = /\b(?:A?GPL|LGPL|SSPL|BUSL|Commons-Clause|CC-BY-NC)\b/i;
const VALID_SCOPES = new Set(['api', 'cli', 'web']);
const MAX_LICENSE_BYTES = 128 * 1024;
const MAX_ARTIFACT_ENTRY_BYTES = 64 * 1024 * 1024;
const WEB_ARTIFACT_EVIDENCE_FILE = 'third-party-module-evidence.json';

export class LicenseGateFailure extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}:${detail}` : code);
    this.name = 'LicenseGateFailure';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = '') {
  throw new LicenseGateFailure(code, detail);
}

function packageId(name, version) {
  return `${name}@${version}`;
}

function parsePackageId(id) {
  const separator = typeof id === 'string' ? id.lastIndexOf('@') : -1;
  if (separator <= 0 || separator === id.length - 1) {
    fail('invalid_source_package_identity');
  }
  return { name: id.slice(0, separator), version: id.slice(separator + 1) };
}

function allNoticeEntries(manifest) {
  return [...manifest.packages, ...manifest.embeddedComponents];
}

function safeReadJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code);
  }
}

export function normalizeLicenseText(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  if (text.includes('\0') || text.includes('\uFFFD')) fail('invalid_license_text');
  return `${text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd()}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isSafeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

function parseSupportedSpdxExpression(value, id) {
  if (/^[A-Za-z0-9.+-]+$/.test(value)) return [value];
  const alternatives = value.match(/^\(([A-Za-z0-9.+-]+(?: OR [A-Za-z0-9.+-]+)+)\)$/);
  if (!alternatives) fail('unsupported_spdx_expression', id);
  return alternatives[1].split(' OR ');
}

function validateCommonEntry(entry, id) {
  if (
    !entry ||
    typeof entry.name !== 'string' ||
    typeof entry.version !== 'string' ||
    typeof entry.declaredLicense !== 'string' ||
    typeof entry.selectedLicense !== 'string' ||
    !Array.isArray(entry.scopes) ||
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(entry.name) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version) ||
    !/^[A-Za-z0-9.+() -]+$/.test(entry.declaredLicense) ||
    !/^[0-9a-f]{64}$/.test(entry.licenseSha256) ||
    !Number.isSafeInteger(entry.licenseBytes) ||
    entry.licenseBytes <= 0 ||
    entry.licenseBytes > MAX_LICENSE_BYTES
  ) {
    fail('invalid_license_manifest_entry', id);
  }

  const sortedScopes = [...entry.scopes].sort();
  if (
    entry.scopes.length === 0 ||
    entry.scopes.some((scope) => !VALID_SCOPES.has(scope)) ||
    entry.scopes.join('\0') !== sortedScopes.join('\0') ||
    new Set(entry.scopes).size !== entry.scopes.length
  ) {
    fail('invalid_license_scope', id);
  }
  if (
    !APPROVED_SELECTED_LICENSES.has(entry.selectedLicense) ||
    FORBIDDEN_LICENSE.test(entry.selectedLicense)
  ) {
    fail('forbidden_selected_license', id);
  }
  const declaredTokens = parseSupportedSpdxExpression(entry.declaredLicense, id);
  if (FORBIDDEN_LICENSE.test(entry.declaredLicense)) {
    fail('forbidden_declared_license', id);
  }
  if (!declaredTokens.includes(entry.selectedLicense)) {
    fail('selected_license_not_declared', id);
  }
}

export function validateManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.packages) ||
    !Array.isArray(manifest.embeddedComponents)
  ) {
    fail('invalid_license_manifest');
  }

  const ids = new Set();
  let previousId = '';
  for (const entry of manifest.packages) {
    const id = packageId(entry.name, entry.version);
    validateCommonEntry(entry, id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.licenseFile)) {
      fail('invalid_license_file', id);
    }
    if (ids.has(id)) fail('duplicate_license_manifest_entry', id);
    ids.add(id);
    if (previousId && previousId.localeCompare(id) >= 0) {
      fail('unsorted_license_manifest');
    }
    previousId = id;

    if (
      entry.conditionalOnDirectDependency !== undefined &&
      entry.conditionalOnDirectDependency !== true
    ) {
      fail('invalid_conditional_dependency_flag', id);
    }
    if (
      (entry.scopes.includes('web') &&
        !['required', 'graph-only'].includes(entry.artifactPresence)) ||
      (!entry.scopes.includes('web') && entry.artifactPresence !== undefined)
    ) {
      fail('invalid_web_artifact_presence', id);
    }
  }

  previousId = '';
  for (const entry of manifest.embeddedComponents) {
    const id = packageId(entry.name, entry.version);
    validateCommonEntry(entry, id);
    if (ids.has(id)) fail('duplicate_license_manifest_entry', id);
    ids.add(id);
    if (previousId && previousId.localeCompare(id) >= 0) {
      fail('unsorted_embedded_component_manifest');
    }
    previousId = id;
    if (
      !['package-license', 'sqlite-amalgamation-blessing'].includes(entry.evidenceKind) ||
      typeof entry.sourcePackage !== 'string' ||
      !isSafeRelativePath(entry.sourceFile)
    ) {
      fail('invalid_embedded_component_evidence', id);
    }
    const sourceIdentity = parsePackageId(entry.sourcePackage);
    if (
      !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(sourceIdentity.name) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(sourceIdentity.version)
    ) {
      fail('invalid_source_package_identity', id);
    }
    if (
      entry.productionEvidenceFile !== undefined &&
      !isSafeRelativePath(entry.productionEvidenceFile)
    ) {
      fail('invalid_embedded_component_production_evidence', id);
    }
    if (
      (entry.scopes.includes('web') && entry.artifactEvidence !== 'vite-modulepreload-polyfill') ||
      (!entry.scopes.includes('web') && entry.artifactEvidence !== undefined)
    ) {
      fail('invalid_embedded_component_artifact_evidence', id);
    }
    if (
      entry.evidenceKind === 'sqlite-amalgamation-blessing' &&
      (entry.declaredLicense !== 'blessing' ||
        entry.selectedLicense !== 'blessing' ||
        !entry.productionEvidenceFile)
    ) {
      fail('invalid_sqlite_component_evidence', id);
    }
  }
  return manifest;
}

export function loadManifest(path = MANIFEST_PATH) {
  return validateManifest(safeReadJson(path, 'license_manifest_unreadable'));
}

function assertContained(root, path, code) {
  const containedPath = relative(root, path);
  if (isAbsolute(containedPath) || containedPath === '..' || containedPath.startsWith(`..${sep}`)) {
    fail(code);
  }
}

function readPackageRecord(root) {
  let packageJson;
  try {
    packageJson = JSON.parse(
      readRegularFile(join(root, 'package.json'), {
        code: 'package_metadata_unreadable',
        maxBytes: 1024 * 1024,
        encoding: 'utf8',
      }),
    );
  } catch (error) {
    if (error instanceof LicenseGateFailure) throw error;
    fail('package_metadata_unreadable');
  }
  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    fail('package_identity_missing');
  }
  return { packageJson, root, id: packageId(packageJson.name, packageJson.version) };
}

function resolveDependencyRoot(packageRoot, dependencyName, repositoryRoot) {
  let current = packageRoot;
  while (true) {
    const candidate = join(current, 'node_modules', ...dependencyName.split('/'));
    if (existsSync(candidate)) {
      let resolved;
      try {
        resolved = realpathSync(candidate);
      } catch {
        fail('dependency_unreadable', dependencyName);
      }
      assertContained(repositoryRoot, resolved, 'dependency_outside_checkout');
      return resolved;
    }
    if (current === repositoryRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail('required_dependency_missing', dependencyName);
}

function collectDependencyClosure(packageRoot, scope, repositoryRoot, records = new Map()) {
  let resolvedPackageRoot;
  try {
    resolvedPackageRoot = realpathSync(packageRoot);
  } catch {
    fail('package_root_unreadable');
  }
  const record = readPackageRecord(resolvedPackageRoot);
  const existing = records.get(record.id);
  if (existing) {
    let existingRoot;
    try {
      existingRoot = realpathSync(existing.root);
    } catch {
      fail('package_root_unreadable', record.id);
    }
    if (existingRoot !== resolvedPackageRoot) {
      fail('duplicate_package_identity', record.id);
    }
    existing.scopes.add(scope);
    return records;
  }
  record.scopes = new Set([scope]);
  records.set(record.id, record);

  const optional = record.packageJson.optionalDependencies ?? {};
  const required = Object.keys(record.packageJson.dependencies ?? {}).filter(
    (dependencyName) => !Object.hasOwn(optional, dependencyName),
  );
  for (const dependencyName of required.sort()) {
    const root = resolveDependencyRoot(record.root, dependencyName, repositoryRoot);
    collectDependencyClosure(root, scope, repositoryRoot, records);
  }
  for (const dependencyName of Object.keys(optional).sort()) {
    try {
      const root = resolveDependencyRoot(record.root, dependencyName, repositoryRoot);
      collectDependencyClosure(root, scope, repositoryRoot, records);
    } catch (error) {
      if (!(error instanceof LicenseGateFailure) || error.code !== 'required_dependency_missing') {
        throw error;
      }
    }
  }
  for (const dependencyName of Object.keys(record.packageJson.peerDependencies ?? {}).sort()) {
    if (record.packageJson.peerDependenciesMeta?.[dependencyName]?.optional) continue;
    const root = resolveDependencyRoot(record.root, dependencyName, repositoryRoot);
    collectDependencyClosure(root, scope, repositoryRoot, records);
  }
  return records;
}

export function collectWorkspaceClosures(repositoryRoot = REPOSITORY_ROOT) {
  const root = realpathSync(repositoryRoot);
  const webRecords = collectDependencyClosure(join(root, 'apps', 'web'), 'web', root);
  const apiRecords = collectDependencyClosure(join(root, 'apps', 'api'), 'api', root);
  const cliRecords = collectDependencyClosure(join(root, 'apps', 'cli'), 'cli', root);
  return { root, webRecords, apiRecords, cliRecords };
}

function addPackageRecord(records, record) {
  const existing = records.get(record.id);
  if (existing) {
    let existingRoot;
    let recordRoot;
    try {
      existingRoot = realpathSync(existing.root);
      recordRoot = realpathSync(record.root);
    } catch {
      fail('package_root_unreadable', record.id);
    }
    if (existingRoot !== recordRoot) fail('duplicate_package_identity', record.id);
    return;
  }
  records.set(record.id, record);
}

function collectPhysicalPackageRoots(deploymentRoot, nodeModulesRoot, records, visitedNodeModules) {
  if (!existsSync(nodeModulesRoot)) return;
  let resolvedNodeModules;
  try {
    resolvedNodeModules = realpathSync(nodeModulesRoot);
  } catch {
    fail('production_node_modules_unreadable');
  }
  assertContained(
    deploymentRoot,
    resolvedNodeModules,
    'production_node_modules_outside_deployment',
  );
  if (visitedNodeModules.has(resolvedNodeModules)) return;
  visitedNodeModules.add(resolvedNodeModules);

  for (const entry of readdirSync(resolvedNodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      fail('production_package_entry_invalid');
    }
    const entryRoot = join(resolvedNodeModules, entry.name);
    if (entry.name.startsWith('@')) {
      collectPhysicalPackageRoots(deploymentRoot, entryRoot, records, visitedNodeModules);
      continue;
    }
    let packageRoot;
    try {
      packageRoot = realpathSync(entryRoot);
    } catch {
      fail('production_package_entry_unreadable');
    }
    assertContained(deploymentRoot, packageRoot, 'production_package_entry_outside_deployment');
    if (!existsSync(join(packageRoot, 'package.json'))) {
      fail('production_package_metadata_missing');
    }
    const record = readPackageRecord(packageRoot);
    addPackageRecord(records, record);
    collectPhysicalPackageRoots(
      deploymentRoot,
      join(packageRoot, 'node_modules'),
      records,
      visitedNodeModules,
    );
  }
}

function collectTopLevelPackage(root, packageRoot, records, visitedNodeModules) {
  let resolved;
  try {
    resolved = realpathSync(packageRoot);
  } catch {
    fail('production_top_level_package_unreadable');
  }
  assertContained(root, resolved, 'production_top_level_package_outside_deployment');
  if (!existsSync(join(resolved, 'package.json'))) {
    fail('production_top_level_package_metadata_missing');
  }
  addPackageRecord(records, readPackageRecord(resolved));
  collectPhysicalPackageRoots(root, join(resolved, 'node_modules'), records, visitedNodeModules);
}

function collectTopLevelPackages(root, nodeModulesRoot, records, visitedNodeModules) {
  for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (entry.name === '.pnpm' || entry.name === '.bin' || entry.name.startsWith('.')) {
      continue;
    }
    const entryRoot = join(nodeModulesRoot, entry.name);
    if (entry.name.startsWith('@')) {
      let scopeRoot;
      try {
        scopeRoot = realpathSync(entryRoot);
      } catch {
        fail('production_top_level_scope_unreadable');
      }
      assertContained(root, scopeRoot, 'production_top_level_scope_outside_deployment');
      if (!lstatSync(scopeRoot).isDirectory()) fail('production_top_level_scope_invalid');
      for (const child of readdirSync(scopeRoot, { withFileTypes: true })) {
        if (!child.isDirectory() && !child.isSymbolicLink()) {
          fail('production_top_level_package_invalid');
        }
        collectTopLevelPackage(root, join(scopeRoot, child.name), records, visitedNodeModules);
      }
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      fail('production_top_level_package_invalid');
    }
    collectTopLevelPackage(root, entryRoot, records, visitedNodeModules);
  }
}

export function collectProductionDeployment(deploymentRoot) {
  let root;
  try {
    root = realpathSync(deploymentRoot);
  } catch {
    fail('production_deployment_unreadable');
  }
  const virtualStore = join(root, 'node_modules', '.pnpm');
  if (!existsSync(virtualStore)) fail('production_virtual_store_missing');

  const records = new Map();
  const visitedNodeModules = new Set();
  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    collectPhysicalPackageRoots(
      root,
      join(virtualStore, entry.name, 'node_modules'),
      records,
      visitedNodeModules,
    );
  }
  collectTopLevelPackages(root, join(root, 'node_modules'), records, visitedNodeModules);
  const virtualAliases = join(virtualStore, 'node_modules');
  if (existsSync(virtualAliases)) {
    collectTopLevelPackages(root, virtualAliases, records, visitedNodeModules);
  }
  return { root, records };
}

function workspacePackageRoots(repositoryRoot) {
  const packages = new Map();
  for (const directory of ['apps', 'packages']) {
    const parent = join(repositoryRoot, directory);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = realpathSync(join(parent, entry.name));
      if (!existsSync(join(root, 'package.json'))) continue;
      const record = readPackageRecord(root);
      packages.set(record.id, root);
    }
  }
  return packages;
}

function collectPackageFiles(root, current = root, files = new Map()) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (current === root && entry.name === 'node_modules') continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      collectPackageFiles(root, path, files);
      continue;
    }
    if (!entry.isFile()) fail('deployed_workspace_package_non_regular_entry');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_ENTRY_BYTES) {
      fail('deployed_workspace_package_unreadable');
    }
    const content = readFileSync(path);
    files.set(relative(root, path).split(sep).join('/'), sha256(content));
  }
  return files;
}

function verifyDeployedWorkspaceCopy(id, deployedRoot, workspaceRoot) {
  let deployedFiles;
  let workspaceFiles;
  try {
    deployedFiles = collectPackageFiles(realpathSync(deployedRoot));
    workspaceFiles = collectPackageFiles(realpathSync(workspaceRoot));
  } catch (error) {
    if (error instanceof LicenseGateFailure) throw error;
    fail('deployed_workspace_package_unreadable', id);
  }
  if (
    [...deployedFiles.keys()].sort().join('\0') !== [...workspaceFiles.keys()].sort().join('\0')
  ) {
    fail('deployed_workspace_package_file_set_mismatch', id);
  }
  for (const [path, expectedHash] of workspaceFiles) {
    if (deployedFiles.get(path) !== expectedHash) {
      fail('deployed_workspace_package_content_mismatch', id);
    }
  }
}

function thirdPartyRecords(records, repositoryRoot, { allowDeployedWorkspaceCopies = false } = {}) {
  const workspaceRoots = workspacePackageRoots(repositoryRoot);
  return new Map(
    [...records].filter(([id, record]) => {
      const workspaceRoot = workspaceRoots.get(id);
      if (!workspaceRoot) return true;
      if (allowDeployedWorkspaceCopies) {
        verifyDeployedWorkspaceCopy(id, record.root, workspaceRoot);
        return false;
      }
      try {
        return realpathSync(record.root) !== workspaceRoot;
      } catch {
        fail('package_root_unreadable', id);
      }
    }),
  );
}

function manifestForScope(manifest, scope) {
  return new Map(
    manifest.packages
      .filter((entry) => entry.scopes.includes(scope))
      .map((entry) => [packageId(entry.name, entry.version), entry]),
  );
}

function conditionalDependencyIsActive(entry, repositoryRoot) {
  if (!entry.conditionalOnDirectDependency) return true;
  const app = entry.scopes.includes('web') ? 'web' : 'api';
  const packageJson = safeReadJson(
    join(repositoryRoot, 'apps', app, 'package.json'),
    'application_manifest_unreadable',
  );
  return Object.hasOwn(packageJson.dependencies ?? {}, entry.name);
}

export function verifyScopeCoverage({
  actualRecords,
  manifest,
  scope,
  repositoryRoot = REPOSITORY_ROOT,
  allowDeployedWorkspaceCopies = false,
}) {
  const actual = thirdPartyRecords(actualRecords, repositoryRoot, {
    allowDeployedWorkspaceCopies,
  });
  const reviewed = manifestForScope(manifest, scope);

  for (const id of actual.keys()) {
    if (!reviewed.has(id)) fail('unreviewed_runtime_dependency', id);
  }
  for (const [id, entry] of reviewed) {
    if (!actual.has(id) && conditionalDependencyIsActive(entry, repositoryRoot)) {
      fail('reviewed_runtime_dependency_missing', id);
    }
  }
  return actual;
}

export function verifyPackageLicense(record, entry, checkedText) {
  const id = packageId(entry.name, entry.version);
  if (record.packageJson.name !== entry.name || record.packageJson.version !== entry.version) {
    fail('package_identity_mismatch', id);
  }
  if (record.packageJson.license !== entry.declaredLicense) {
    fail('package_spdx_mismatch', id);
  }

  const licensePath = join(record.root, entry.licenseFile);
  let stat;
  try {
    stat = lstatSync(licensePath);
  } catch {
    fail('package_license_file_missing', id);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LICENSE_BYTES) {
    fail('package_license_file_invalid', id);
  }
  const unreviewedNotice = readdirSync(record.root).find(
    (name) =>
      name !== entry.licenseFile &&
      /^(?:NOTICES?|THIRD[_-]PARTY[_-]NOTICES?|ATTRIBUTIONS?)(?:$|[._-])/i.test(name),
  );
  if (unreviewedNotice) fail('unreviewed_package_notice_file', id);

  const installedText = normalizeLicenseText(readFileSync(licensePath));
  if (
    sha256(installedText) !== entry.licenseSha256 ||
    Buffer.byteLength(installedText) !== entry.licenseBytes
  ) {
    fail('package_license_text_mismatch', id);
  }
  if (installedText !== checkedText) fail('checked_license_text_mismatch', id);
}

function readRegularFile(path, { code, maxBytes = MAX_LICENSE_BYTES, encoding } = {}) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
    fail(code);
  }
  return readFileSync(path, encoding);
}

function hasNativeAddonMagic(content) {
  if (content.length < 4) return false;
  const magic = content.subarray(0, 4).toString('hex');
  return (
    new Set(['7f454c46', 'cafebabe', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface']).has(magic) ||
    content.subarray(0, 2).toString('latin1') === 'MZ'
  );
}

export function verifySqliteRuntimeVersion(entry, Database) {
  let database;
  let version;
  try {
    database = new Database(':memory:');
    version = database.prepare('select sqlite_version() as version').get()?.version;
  } catch {
    fail('production_embedded_component_runtime_query_failed');
  } finally {
    try {
      database?.close();
    } catch {
      fail('production_embedded_component_runtime_close_failed');
    }
  }
  if (version !== entry.version) {
    fail('production_embedded_component_version_mismatch', packageId(entry.name, entry.version));
  }
}

function resolveEmbeddedSourceRecord(entry, repositoryRoot, sourceRecords) {
  const existing = sourceRecords.get(entry.sourcePackage);
  if (existing) return existing;

  const sourceIdentity = parsePackageId(entry.sourcePackage);
  for (const scope of entry.scopes) {
    try {
      const root = resolveDependencyRoot(
        join(repositoryRoot, 'apps', scope),
        sourceIdentity.name,
        repositoryRoot,
      );
      const record = readPackageRecord(root);
      if (record.id === entry.sourcePackage) return record;
    } catch (error) {
      if (!(error instanceof LicenseGateFailure) || error.code !== 'required_dependency_missing') {
        throw error;
      }
    }
  }
  fail('embedded_component_source_missing', entry.sourcePackage);
}

const SQLITE_BLESSING_PATTERN =
  /\*\* The author disclaims copyright to this source code\. {2}In place of\n\*\* a legal notice, here is a blessing:\n\*\*\n\*\* {4}May you do good and not evil\.\n\*\* {4}May you find forgiveness for yourself and forgive others\.\n\*\* {4}May you share freely, never taking more than you give\./;

export function extractEmbeddedLicenseText(entry, record) {
  const id = packageId(entry.name, entry.version);
  if (record.id !== entry.sourcePackage) fail('embedded_component_source_mismatch', id);

  let sourceRoot;
  let sourcePath;
  try {
    sourceRoot = realpathSync(record.root);
    sourcePath = realpathSync(join(sourceRoot, entry.sourceFile));
  } catch {
    fail('embedded_component_source_invalid', id);
  }
  assertContained(sourceRoot, sourcePath, 'embedded_component_source_outside_package');
  if (entry.evidenceKind === 'package-license') {
    if (record.packageJson.license !== entry.declaredLicense) {
      fail('embedded_component_spdx_mismatch', id);
    }
    return normalizeLicenseText(
      readRegularFile(sourcePath, {
        code: 'embedded_component_source_invalid',
        encoding: 'utf8',
      }),
    );
  }

  const source = normalizeLicenseText(
    readRegularFile(sourcePath, {
      code: 'embedded_component_source_invalid',
      maxBytes: 32 * 1024 * 1024,
      encoding: 'utf8',
    }),
  );
  const versionPattern = new RegExp(
    `#define SQLITE_VERSION\\s+"${entry.version.replaceAll('.', '\\.')}"`,
  );
  if (!versionPattern.test(source)) fail('embedded_component_version_mismatch', id);
  const blessing = source.match(SQLITE_BLESSING_PATTERN);
  if (!blessing) fail('embedded_component_license_evidence_missing', id);
  return normalizeLicenseText(
    blessing[0]
      .split('\n')
      .map((line) => line.replace(/^\*\* ?/, ''))
      .join('\n'),
  );
}

function verifyEmbeddedComponents(manifest, texts, repositoryRoot, sourceRecords) {
  for (const entry of manifest.embeddedComponents) {
    const id = packageId(entry.name, entry.version);
    const record = resolveEmbeddedSourceRecord(entry, repositoryRoot, sourceRecords);
    const extracted = extractEmbeddedLicenseText(entry, record);
    if (
      sha256(extracted) !== entry.licenseSha256 ||
      Buffer.byteLength(extracted) !== entry.licenseBytes ||
      extracted !== texts.get(entry.licenseSha256)
    ) {
      fail('embedded_component_license_text_mismatch', id);
    }
  }
}

export function loadCheckedLicenseTexts(manifest, directory = LICENSE_TEXT_DIRECTORY) {
  const hashes = new Map();
  for (const entry of allNoticeEntries(manifest)) {
    const existingBytes = hashes.get(entry.licenseSha256);
    if (existingBytes !== undefined && existingBytes !== entry.licenseBytes) {
      fail('license_hash_size_conflict');
    }
    hashes.set(entry.licenseSha256, entry.licenseBytes);
  }

  let presentFiles;
  try {
    presentFiles = readdirSync(directory).sort();
  } catch {
    fail('checked_license_directory_unreadable');
  }
  const expectedFiles = [...hashes.keys()].sort().map((hash) => `${hash}.txt`);
  if (presentFiles.join('\0') !== expectedFiles.join('\0')) {
    fail('checked_license_file_set_mismatch');
  }

  const texts = new Map();
  for (const [hash, bytes] of hashes) {
    const path = join(directory, `${hash}.txt`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LICENSE_BYTES) {
      fail('checked_license_file_invalid', hash);
    }
    const raw = readFileSync(path, 'utf8');
    const normalized = normalizeLicenseText(raw);
    if (
      raw !== normalized ||
      sha256(normalized) !== hash ||
      Buffer.byteLength(normalized) !== bytes
    ) {
      fail('checked_license_file_mismatch', hash);
    }
    if (normalized.includes('```')) fail('license_text_markdown_delimiter_conflict', hash);
    texts.set(hash, normalized);
  }
  return texts;
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|');
}

export function renderNotices(manifest, texts) {
  const lines = [
    '# Third-party notices',
    '',
    'This document covers third-party components distributed in Velograph application-owned runtime artifacts.',
    '**It does not grant a licence to Velograph itself. No licence for Velograph has been selected.**',
    '',
    'The package inventory, SPDX declarations, and normalized licence texts are verified by',
    '`scripts/third-party-license-gate.mjs` against installed production packages and the',
    'checked `third-party-licenses.json` manifest.',
    '',
    'The web inventory is deliberately conservative: it covers the complete production',
    'dependency graph, including facades or modules a particular build may tree-shake.',
    '',
    '## Reviewed package inventory',
    '',
    '| Package | Version | Reviewed scope | Declared SPDX | Selected SPDX | Licence text SHA-256 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of manifest.packages) {
    lines.push(
      `| \`${markdownCell(entry.name)}\` | \`${entry.version}\` | ${entry.scopes.join(', ')} | \`${markdownCell(entry.declaredLicense)}\` | \`${entry.selectedLicense}\` | \`${entry.licenseSha256}\` |`,
    );
  }

  lines.push(
    '',
    '## Reviewed embedded and build contributions',
    '',
    '| Component | Version | Artifact scope | Parent evidence | Declared SPDX | Selected SPDX | Licence text SHA-256 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const entry of manifest.embeddedComponents) {
    lines.push(
      `| \`${markdownCell(entry.name)}\` | \`${entry.version}\` | ${entry.scopes.join(', ')} | \`${markdownCell(entry.sourcePackage)}\` | \`${markdownCell(entry.declaredLicense)}\` | \`${entry.selectedLicense}\` | \`${entry.licenseSha256}\` |`,
    );
  }

  lines.push('', '## Authoritative licence texts', '');
  const packagesByHash = new Map();
  for (const entry of allNoticeEntries(manifest)) {
    const ids = packagesByHash.get(entry.licenseSha256) ?? [];
    ids.push(packageId(entry.name, entry.version));
    packagesByHash.set(entry.licenseSha256, ids);
  }
  for (const hash of [...packagesByHash.keys()].sort()) {
    const entries = allNoticeEntries(manifest).filter((entry) => entry.licenseSha256 === hash);
    const selected = [...new Set(entries.map((entry) => entry.selectedLicense))].sort();
    lines.push(
      `### ${selected.join(' / ')} — \`${hash}\``,
      '',
      `Applies to: ${packagesByHash
        .get(hash)
        .sort()
        .map((id) => `\`${id}\``)
        .join(', ')}`,
      '',
      `<!-- BEGIN THIRD-PARTY LICENCE ${hash} -->`,
      '```text',
      texts.get(hash).trimEnd(),
      '```',
      `<!-- END THIRD-PARTY LICENCE ${hash} -->`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function verifyCanonicalNotices(manifest, texts, noticesPath = NOTICES_PATH) {
  const actual = readRegularFile(noticesPath, {
    code: 'third_party_notices_missing',
    maxBytes: 2 * 1024 * 1024,
    encoding: 'utf8',
  });
  const expected = renderNotices(manifest, texts);
  if (actual !== expected) fail('third_party_notices_out_of_date');
  return expected;
}

function verifyRecords(
  records,
  manifest,
  texts,
  scope,
  repositoryRoot,
  { allowDeployedWorkspaceCopies = false } = {},
) {
  const actual = verifyScopeCoverage({
    actualRecords: records,
    manifest,
    scope,
    repositoryRoot,
    allowDeployedWorkspaceCopies,
  });
  const reviewed = manifestForScope(manifest, scope);
  for (const [id, record] of actual) {
    const entry = reviewed.get(id);
    verifyPackageLicense(record, entry, texts.get(entry.licenseSha256));
  }
}

function packageManifestSelectsLicence(packageJson) {
  return Object.hasOwn(packageJson, 'license') || Object.hasOwn(packageJson, 'licenses');
}

function conventionalLicenceFile(root) {
  return readdirSync(root).find((name) =>
    /^(?:licenses?|licences?|copying)(?:$|[._-])/i.test(name),
  );
}

export function assertVelographLicenceUnselected(repositoryRoot) {
  const rootPackage = safeReadJson(
    join(repositoryRoot, 'package.json'),
    'root_package_manifest_unreadable',
  );
  const projectLicenceFile = conventionalLicenceFile(repositoryRoot);
  if (packageManifestSelectsLicence(rootPackage) || projectLicenceFile) {
    fail('velograph_license_selection_out_of_scope');
  }
  for (const root of workspacePackageRoots(repositoryRoot).values()) {
    const packageJson = safeReadJson(
      join(root, 'package.json'),
      'workspace_package_manifest_unreadable',
    );
    if (packageManifestSelectsLicence(packageJson) || conventionalLicenceFile(root)) {
      fail('velograph_license_selection_out_of_scope');
    }
  }
}

export function verifyWorkspace(repositoryRoot = REPOSITORY_ROOT) {
  const manifest = loadManifest(join(repositoryRoot, 'third-party-licenses.json'));
  const texts = loadCheckedLicenseTexts(manifest, join(repositoryRoot, 'third_party_licenses'));
  verifyCanonicalNotices(manifest, texts, join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'));
  assertVelographLicenceUnselected(repositoryRoot);

  const closures = collectWorkspaceClosures(repositoryRoot);
  verifyRecords(closures.webRecords, manifest, texts, 'web', closures.root);
  verifyRecords(closures.apiRecords, manifest, texts, 'api', closures.root);
  verifyRecords(closures.cliRecords, manifest, texts, 'cli', closures.root);
  verifyEmbeddedComponents(
    manifest,
    texts,
    closures.root,
    new Map([...closures.webRecords, ...closures.apiRecords, ...closures.cliRecords]),
  );
  console.log(
    `third-party-license-gate: workspace clean (${manifest.packages.length} package(s), ${manifest.embeddedComponents.length} embedded/build contribution(s))`,
  );
  return 0;
}

function verifyArtifactNotice(artifactRoot, canonicalNotices) {
  const path = join(artifactRoot, 'THIRD_PARTY_NOTICES.md');
  const content = readRegularFile(path, {
    code: 'artifact_third_party_notices_missing',
    maxBytes: 2 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (content !== canonicalNotices) fail('artifact_third_party_notices_mismatch');
}

function verifyProductionEmbeddedEvidence(manifest, deployment) {
  for (const entry of manifest.embeddedComponents.filter((candidate) =>
    candidate.scopes.includes('api'),
  )) {
    if (!entry.productionEvidenceFile) {
      fail('production_embedded_component_evidence_missing', entry.name);
    }
    const record = deployment.records.get(entry.sourcePackage);
    if (!record) fail('production_embedded_component_parent_missing', entry.sourcePackage);
    let sourceRoot;
    let evidencePath;
    try {
      sourceRoot = realpathSync(record.root);
      evidencePath = realpathSync(join(sourceRoot, entry.productionEvidenceFile));
    } catch {
      fail('production_embedded_component_evidence_invalid');
    }
    assertContained(
      sourceRoot,
      evidencePath,
      'production_embedded_component_evidence_outside_package',
    );
    const evidence = readRegularFile(evidencePath, {
      code: 'production_embedded_component_evidence_invalid',
      maxBytes: 64 * 1024 * 1024,
    });
    if (entry.evidenceKind === 'sqlite-amalgamation-blessing') {
      if (!hasNativeAddonMagic(evidence)) {
        fail('production_embedded_component_native_binary_invalid');
      }
      let packageEntrypoint;
      let Database;
      try {
        packageEntrypoint = realpathSync(
          join(sourceRoot, record.packageJson.main ?? 'lib/index.js'),
        );
        assertContained(
          sourceRoot,
          packageEntrypoint,
          'production_embedded_component_entrypoint_outside_package',
        );
        Database = require(packageEntrypoint);
      } catch (error) {
        if (error instanceof LicenseGateFailure) throw error;
        fail('production_embedded_component_runtime_unloadable');
      }
      verifySqliteRuntimeVersion(entry, Database);
    }
  }
}

function sortedUnique(values) {
  return (
    values.length === new Set(values).size &&
    values.join('\0') === [...values].sort((left, right) => left.localeCompare(right)).join('\0')
  );
}

function collectArtifactContents(root, current = root, contents = new Map()) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    fail('artifact_entry_unreadable');
  }
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      collectArtifactContents(root, absolute, contents);
      continue;
    }
    if (!entry.isFile()) fail('artifact_non_regular_entry');

    const artifactPath = relative(root, absolute).split(sep).join('/');
    if (!isSafeRelativePath(artifactPath)) fail('artifact_unsafe_entry_path');
    const content = readRegularFile(absolute, {
      code: 'artifact_entry_unreadable',
      maxBytes: MAX_ARTIFACT_ENTRY_BYTES,
    });
    contents.set(artifactPath, content);
  }
  return contents;
}

function parseArtifactEvidence(contents) {
  const content = contents.get(WEB_ARTIFACT_EVIDENCE_FILE);
  if (!Buffer.isBuffer(content) || content.length === 0 || content.length > 2 * 1024 * 1024) {
    fail('artifact_module_evidence_missing');
  }
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    fail('artifact_module_evidence_invalid');
  }
}

function verifyArtifactPackageIdentity(id) {
  const identity = parsePackageId(id);
  if (
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(identity.name) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(identity.version)
  ) {
    fail('artifact_package_identity_invalid', id);
  }
}

function verifyWebArtifactEvidence(manifest, contents, repositoryRoot) {
  for (const [path, content] of contents) {
    if (
      !isSafeRelativePath(path) ||
      !Buffer.isBuffer(content) ||
      content.length === 0 ||
      content.length > MAX_ARTIFACT_ENTRY_BYTES
    ) {
      fail('artifact_entry_invalid');
    }
  }

  const evidence = parseArtifactEvidence(contents);
  if (
    evidence?.schemaVersion !== 1 ||
    !Array.isArray(evidence.packages) ||
    !Array.isArray(evidence.injectedModules) ||
    !Array.isArray(evidence.files)
  ) {
    fail('artifact_module_evidence_invalid');
  }

  const filePaths = [];
  const filePackageIds = new Set();
  let htmlEntryCount = 0;
  for (const file of evidence.files) {
    if (
      !file ||
      !isSafeRelativePath(file.file) ||
      file.file === WEB_ARTIFACT_EVIDENCE_FILE ||
      file.file === 'THIRD_PARTY_NOTICES.md' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      file.bytes > MAX_ARTIFACT_ENTRY_BYTES ||
      !['rollup-asset', 'rollup-chunk', 'vite-html-entry'].includes(file.generatedBy) ||
      !Array.isArray(file.packages) ||
      file.packages.length === 0 ||
      !file.packages.every((id) => typeof id === 'string') ||
      !sortedUnique(file.packages)
    ) {
      fail('artifact_file_evidence_invalid');
    }
    if (
      (file.generatedBy === 'rollup-chunk' && !file.file.endsWith('.js')) ||
      (file.generatedBy === 'rollup-asset' && file.file.endsWith('.js')) ||
      (file.generatedBy === 'vite-html-entry' && file.file !== 'index.html')
    ) {
      fail('artifact_file_provenance_invalid');
    }
    if (file.generatedBy === 'vite-html-entry') htmlEntryCount += 1;

    const content = contents.get(file.file);
    if (!content || content.length !== file.bytes || sha256(content) !== file.sha256) {
      fail('artifact_file_evidence_mismatch');
    }
    for (const id of file.packages) {
      verifyArtifactPackageIdentity(id);
      filePackageIds.add(id);
    }
    filePaths.push(file.file);
  }
  if (htmlEntryCount !== 1 || !sortedUnique(filePaths)) {
    fail('artifact_file_evidence_invalid');
  }

  const actualPayloadFiles = [...contents.keys()]
    .filter((path) => path !== WEB_ARTIFACT_EVIDENCE_FILE && path !== 'THIRD_PARTY_NOTICES.md')
    .sort((left, right) => left.localeCompare(right));
  if (actualPayloadFiles.join('\0') !== filePaths.join('\0')) {
    fail('artifact_file_set_mismatch');
  }

  const packageIds = [];
  for (const entry of evidence.packages) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !Number.isSafeInteger(entry.moduleCount) ||
      entry.moduleCount <= 0
    ) {
      fail('artifact_package_evidence_invalid');
    }
    verifyArtifactPackageIdentity(entry.id);
    packageIds.push(entry.id);
  }
  if (!sortedUnique(packageIds)) fail('artifact_package_evidence_invalid');

  const workspaceIds = new Set(workspacePackageRoots(repositoryRoot).keys());
  const actualThirdParty = new Set(packageIds.filter((id) => !workspaceIds.has(id)));
  const reviewed = manifestForScope(manifest, 'web');
  for (const id of actualThirdParty) {
    const entry = reviewed.get(id);
    if (
      !entry ||
      entry.artifactPresence !== 'required' ||
      !conditionalDependencyIsActive(entry, repositoryRoot)
    ) {
      fail('artifact_unreviewed_runtime_dependency', id);
    }
  }
  for (const [id, entry] of reviewed) {
    const active = conditionalDependencyIsActive(entry, repositoryRoot);
    if (entry.artifactPresence === 'required' && active && !actualThirdParty.has(id)) {
      fail('artifact_reviewed_runtime_dependency_missing', id);
    }
    if (entry.artifactPresence === 'graph-only' && actualThirdParty.has(id)) {
      fail('artifact_graph_only_dependency_present', id);
    }
  }

  for (const id of filePackageIds) {
    if (!workspaceIds.has(id) && !actualThirdParty.has(id)) {
      fail('artifact_file_package_not_in_module_graph', id);
    }
  }
  for (const id of packageIds) {
    if (!filePackageIds.has(id)) {
      fail('artifact_module_package_without_output', id);
    }
  }

  if (
    !evidence.injectedModules.every((value) => typeof value === 'string') ||
    !sortedUnique(evidence.injectedModules)
  ) {
    fail('artifact_embedded_component_evidence_invalid');
  }
  const expectedInjected = manifest.embeddedComponents
    .filter((entry) => entry.scopes.includes('web'))
    .map((entry) => entry.artifactEvidence)
    .sort((left, right) => left.localeCompare(right));
  if (evidence.injectedModules.join('\0') !== expectedInjected.join('\0')) {
    fail('artifact_embedded_component_evidence_mismatch');
  }
  if (expectedInjected.includes('vite-modulepreload-polyfill')) {
    const compiledEvidence = evidence.files
      .filter((file) => file.generatedBy === 'rollup-chunk')
      .some((file) => {
        const content = contents.get(file.file).toString('utf8');
        return (
          content.includes('relList') && /supports\((?:"|')modulepreload(?:"|')\)/.test(content)
        );
      });
    if (!compiledEvidence) {
      fail('artifact_embedded_component_compiled_evidence_missing');
    }
  }
}

export function verifyWebArtifactContents(contents, repositoryRoot = REPOSITORY_ROOT) {
  const manifest = loadManifest(join(repositoryRoot, 'third-party-licenses.json'));
  const texts = loadCheckedLicenseTexts(manifest, join(repositoryRoot, 'third_party_licenses'));
  const canonicalNotices = verifyCanonicalNotices(
    manifest,
    texts,
    join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
  );
  const packagedNotices = contents.get('THIRD_PARTY_NOTICES.md');
  if (!Buffer.isBuffer(packagedNotices)) {
    fail('artifact_third_party_notices_missing');
  }
  if (!packagedNotices.equals(Buffer.from(canonicalNotices))) {
    fail('artifact_third_party_notices_mismatch');
  }
  verifyWebArtifactEvidence(manifest, contents, repositoryRoot);
  return 0;
}

export function verifyProductionDeployment(deploymentRoot, repositoryRoot = REPOSITORY_ROOT) {
  const manifest = loadManifest(join(repositoryRoot, 'third-party-licenses.json'));
  const texts = loadCheckedLicenseTexts(manifest, join(repositoryRoot, 'third_party_licenses'));
  const canonicalNotices = verifyCanonicalNotices(
    manifest,
    texts,
    join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
  );
  const deployment = collectProductionDeployment(deploymentRoot);
  verifyRecords(deployment.records, manifest, texts, 'api', repositoryRoot, {
    allowDeployedWorkspaceCopies: true,
  });
  verifyProductionEmbeddedEvidence(manifest, deployment);
  verifyArtifactNotice(deployment.root, canonicalNotices);
  verifyWebArtifactContents(
    collectArtifactContents(join(deployment.root, 'dist', 'web')),
    repositoryRoot,
  );
  console.log(
    `third-party-license-gate: production API clean (${thirdPartyRecords(deployment.records, repositoryRoot, { allowDeployedWorkspaceCopies: true }).size} package(s))`,
  );
  return 0;
}

export function verifyArtifact(artifactRoot, repositoryRoot = REPOSITORY_ROOT) {
  let root;
  try {
    const stat = lstatSync(artifactRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('artifact_unreadable');
    root = realpathSync(artifactRoot);
  } catch (error) {
    if (error instanceof LicenseGateFailure) throw error;
    fail('artifact_unreadable');
  }
  const contents = collectArtifactContents(root);
  verifyWebArtifactContents(contents, repositoryRoot);
  console.log('third-party-license-gate: web artifact closure and notices clean');
  return 0;
}

export function stageAndVerifyArtifact(artifactRoot, repositoryRoot = REPOSITORY_ROOT) {
  let root;
  try {
    const rootStat = lstatSync(artifactRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      fail('artifact_unreadable');
    }
    root = realpathSync(artifactRoot);
  } catch (error) {
    if (error instanceof LicenseGateFailure) throw error;
    fail('artifact_unreadable');
  }
  const destination = join(root, 'THIRD_PARTY_NOTICES.md');
  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('artifact_third_party_notices_invalid');
    }
  }
  copyFileSync(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), destination);
  return verifyArtifact(root, repositoryRoot);
}

function sourceRootsFromWorkspace(repositoryRoot) {
  const closures = collectWorkspaceClosures(repositoryRoot);
  return new Map([...closures.webRecords, ...closures.apiRecords, ...closures.cliRecords]);
}

export function syncNotices({
  repositoryRoot = REPOSITORY_ROOT,
  additionalPackageRoots = [],
} = {}) {
  const manifest = loadManifest(join(repositoryRoot, 'third-party-licenses.json'));
  const roots = sourceRootsFromWorkspace(repositoryRoot);
  for (const packageRoot of additionalPackageRoots) {
    const record = readPackageRecord(realpathSync(packageRoot));
    roots.set(record.id, record);
  }

  const texts = new Map();
  for (const entry of manifest.packages) {
    const id = packageId(entry.name, entry.version);
    const record = roots.get(id);
    if (!record) fail('notice_source_package_missing', id);
    const licensePath = join(record.root, entry.licenseFile);
    const normalized = normalizeLicenseText(readFileSync(licensePath));
    if (
      record.packageJson.license !== entry.declaredLicense ||
      sha256(normalized) !== entry.licenseSha256 ||
      Buffer.byteLength(normalized) !== entry.licenseBytes
    ) {
      fail('notice_source_package_mismatch', id);
    }
    texts.set(entry.licenseSha256, normalized);
  }
  for (const entry of manifest.embeddedComponents) {
    const record = resolveEmbeddedSourceRecord(entry, repositoryRoot, roots);
    const normalized = extractEmbeddedLicenseText(entry, record);
    if (
      sha256(normalized) !== entry.licenseSha256 ||
      Buffer.byteLength(normalized) !== entry.licenseBytes
    ) {
      fail('notice_source_package_mismatch', packageId(entry.name, entry.version));
    }
    texts.set(entry.licenseSha256, normalized);
  }

  mkdirSync(join(repositoryRoot, 'third_party_licenses'), { recursive: true });
  for (const [hash, text] of texts) {
    writeFileSync(join(repositoryRoot, 'third_party_licenses', `${hash}.txt`), text);
  }
  writeFileSync(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), renderNotices(manifest, texts));
  console.log(`third-party-license-gate: synchronized ${texts.size} licence text(s)`);
  return 0;
}

export function run(argv) {
  try {
    const [mode, value] = argv;
    if (mode === '--workspace' && argv.length === 1) return verifyWorkspace();
    if (mode === '--production-deploy' && value && argv.length === 2) {
      return verifyProductionDeployment(value);
    }
    if (mode === '--artifact' && value && argv.length === 2) {
      return verifyArtifact(value);
    }
    if (mode === '--stage-artifact' && value && argv.length === 2) {
      return stageAndVerifyArtifact(value);
    }
    if (mode === '--sync-notices' && argv.slice(1).length % 2 === 0) {
      const roots = [];
      for (let index = 1; index < argv.length; index += 2) {
        if (argv[index] !== '--package-root' || !argv[index + 1]) {
          fail('unexpected_license_gate_arguments');
        }
        roots.push(argv[index + 1]);
      }
      return syncNotices({ additionalPackageRoots: roots });
    }
  } catch (error) {
    const code = error instanceof LicenseGateFailure ? error.code : 'unexpected_license_gate_error';
    const detail = error instanceof LicenseGateFailure && error.detail ? ` ${error.detail}` : '';
    console.error(`THIRD-PARTY LICENSE GATE FAILED — [${code}]${detail}`);
    return 1;
  }
  console.error(
    'Usage: --workspace | --production-deploy <path> | --artifact <path> | --stage-artifact <path> | --sync-notices [--package-root <path>]',
  );
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}
