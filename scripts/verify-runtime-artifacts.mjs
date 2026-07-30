import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { formatOpaqueViolation, scanFile } from './privacy-scan.mjs';
import { verifyWebArtifactContents } from './third-party-license-gate.mjs';

const repositoryRoot = process.cwd();
const apiRoot = join(repositoryRoot, 'apps', 'api');
const cliRoot = join(repositoryRoot, 'apps', 'cli');
const canonicalMigrations = join(repositoryRoot, 'packages', 'db', 'migrations');
const requiredFiles = [
  join(apiRoot, 'dist', 'velograph-api.mjs'),
  join(apiRoot, 'dist', 'api-runtime.mjs'),
  join(apiRoot, 'dist', 'api-runtime.meta.json'),
  join(apiRoot, 'dist', 'COPYRIGHT.md'),
  join(apiRoot, 'dist', 'LICENSE'),
  join(apiRoot, 'dist', 'THIRD_PARTY_NOTICES.md'),
  join(apiRoot, 'dist', 'web', 'index.html'),
  join(apiRoot, 'dist', 'web', 'COPYRIGHT.md'),
  join(apiRoot, 'dist', 'web', 'LICENSE'),
  join(apiRoot, 'dist', 'web', 'THIRD_PARTY_NOTICES.md'),
  join(apiRoot, 'dist', 'web', 'third-party-module-evidence.json'),
  join(cliRoot, 'dist', 'velograph-import.mjs'),
  join(cliRoot, 'dist', 'cli-runtime.mjs'),
  join(cliRoot, 'dist', 'cli-runtime.meta.json'),
  join(cliRoot, 'dist', 'COPYRIGHT.md'),
  join(cliRoot, 'dist', 'LICENSE'),
  join(cliRoot, 'dist', 'THIRD_PARTY_NOTICES.md'),
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('runtime_artifact_symlink');
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function collectContents(directory) {
  const contents = new Map();
  for (const path of await walk(directory)) {
    contents.set(relative(directory, path).replaceAll('\\', '/'), await readFile(path));
  }
  return contents;
}

async function verifyMigrationCopy(packageRoot) {
  const destination = join(packageRoot, 'migrations');
  const canonicalNames = (await readdir(canonicalMigrations))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const copiedNames = (await readdir(destination))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  if (
    canonicalNames.length !== copiedNames.length ||
    canonicalNames.some((name, index) => name !== copiedNames[index])
  ) {
    throw new Error('runtime_artifact_migration_set_mismatch');
  }
  for (const name of canonicalNames) {
    const [canonical, copied] = await Promise.all([
      readFile(join(canonicalMigrations, name)),
      readFile(join(destination, name)),
    ]);
    if (!canonical.equals(copied)) throw new Error('runtime_artifact_migration_content_mismatch');
  }
}

for (const path of requiredFiles) {
  if (!existsSync(path) || !(await stat(path)).isFile()) {
    throw new Error('runtime_artifact_missing');
  }
}

await Promise.all([verifyMigrationCopy(apiRoot), verifyMigrationCopy(cliRoot)]);
verifyWebArtifactContents(await collectContents(join(apiRoot, 'dist', 'web')), repositoryRoot);

const canonicalNotice = join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
const canonicalLicense = join(repositoryRoot, 'LICENSE');
const canonicalCopyright = join(repositoryRoot, 'COPYRIGHT.md');
const [canonicalNoticeBytes, canonicalLicenseBytes, canonicalCopyrightBytes] = await Promise.all([
  readFile(canonicalNotice),
  readFile(canonicalLicense),
  readFile(canonicalCopyright),
]);
for (const packageRoot of [apiRoot, cliRoot]) {
  const [copiedNotice, copiedLicense, copiedCopyright] = await Promise.all([
    readFile(join(packageRoot, 'dist', 'THIRD_PARTY_NOTICES.md')),
    readFile(join(packageRoot, 'dist', 'LICENSE')),
    readFile(join(packageRoot, 'dist', 'COPYRIGHT.md')),
  ]);
  if (!canonicalNoticeBytes.equals(copiedNotice)) {
    throw new Error('runtime_artifact_notice_mismatch');
  }
  if (!canonicalLicenseBytes.equals(copiedLicense)) {
    throw new Error('runtime_artifact_project_license_mismatch');
  }
  if (!canonicalCopyrightBytes.equals(copiedCopyright)) {
    throw new Error('runtime_artifact_project_copyright_mismatch');
  }
}

const artifactFiles = [
  ...(await walk(join(apiRoot, 'dist'))),
  ...(await walk(join(apiRoot, 'migrations'))),
  ...(await walk(join(cliRoot, 'dist'))),
  ...(await walk(join(cliRoot, 'migrations'))),
];
const violations = [];
for (const path of artifactFiles) {
  const relativePath = relative(repositoryRoot, path).replaceAll('\\', '/');
  violations.push(...scanFile(relativePath, await readFile(path)));
  try {
    const ignored = execFileSync('git', ['check-ignore', '--no-index', relativePath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (ignored) throw new Error('runtime_artifact_ignored');
  } catch (error) {
    if (error instanceof Error && error.message === 'runtime_artifact_ignored') throw error;
    // git check-ignore exits 1 when the artifact is correctly visible.
  }
}
if (violations.length > 0) {
  console.error(`RUNTIME ARTIFACT PRIVACY SCAN FAILED — ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`  ${formatOpaqueViolation(violation)}`);
  }
  process.exitCode = 1;
} else {
  console.log(`runtime-artifacts: ${artifactFiles.length} generated file(s) verified and clean`);
}
