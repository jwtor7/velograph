#!/usr/bin/env node
/**
 * Remove known non-runtime package-manager debris from a production API
 * deployment before it crosses into the container runtime stage.
 *
 * This is intentionally an exact allowlist, not a general `find -delete`.
 * Any newly introduced archive fails the build and must be reviewed.
 */
import { lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ARCHIVE_EXTENSION = /\.(?:7z|bz2|gz|rar|tar|tgz|xz|zip)$/i;
const KNOWN_NON_RUNTIME_ARCHIVE =
  /^node_modules\/\.pnpm\/tar-fs@[^/]+\/node_modules\/tar-fs\/test\/fixtures\/invalid\.tar$/;
const FORBIDDEN_DEVELOPMENT_PACKAGES = [
  /^@eslint\+/,
  /^@types\+/,
  /^@vitest\+/,
  /^esbuild@/,
  /^eslint(?:@|-)/,
  /^prettier@/,
  /^typescript@/,
  /^typescript-eslint@/,
  /^vite@/,
  /^vitest@/,
];

class PruneFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'PruneFailure';
    this.code = code;
  }
}

function fail(code) {
  throw new PruneFailure(code);
}

function walkRegularFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkRegularFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function removeReviewedPath(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return 0;
  rmSync(path, { recursive: stat.isDirectory(), force: false });
  return 1;
}

function packageRoots(virtualStore, packageName) {
  return readdirSync(virtualStore, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${packageName}@`))
    .map((entry) => join(virtualStore, entry.name, 'node_modules', packageName));
}

export function pruneDeployedApi(path) {
  const root = realpathSync(path);
  if (!statSync(root).isDirectory()) fail('deployment_not_directory');

  const virtualStore = join(root, 'node_modules', '.pnpm');
  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      FORBIDDEN_DEVELOPMENT_PACKAGES.some((pattern) => pattern.test(entry.name))
    ) {
      fail('development_dependency_in_production_deploy');
    }
  }

  // Legacy workspace deployment creates a convenience link back to the source
  // API package. The deployed package is already copied at `root`; retaining
  // the link would either pull build-source into an image or become dangling
  // once the build stage is discarded.
  const sourceBacklink = join(virtualStore, 'node_modules', '@velograph', 'api');
  const sourceBacklinkStat = lstatIfPresent(sourceBacklink);
  if (sourceBacklinkStat) {
    if (!sourceBacklinkStat.isSymbolicLink()) {
      fail('production_source_backlink_not_symlink');
    }
    rmSync(sourceBacklink);
  }

  let removedArchives = 0;
  for (const file of walkRegularFiles(root)) {
    const deploymentPath = relative(root, file).replaceAll('\\', '/');
    if (!ARCHIVE_EXTENSION.test(deploymentPath)) continue;
    if (!KNOWN_NON_RUNTIME_ARCHIVE.test(deploymentPath)) {
      fail('unexpected_archive_in_production_deploy');
    }
    rmSync(file);
    removedArchives += 1;
  }

  // The native addon is built before this step. Its compiler inputs, package
  // tests, package-manager metadata, and documentation are not runtime
  // dependencies and contain privacy-scanner false positives such as example
  // home paths. Keep the executable addon, JS loader, package metadata, and
  // licences.
  let removedNonRuntimePaths = 0;
  removedNonRuntimePaths += removeReviewedPath(join(root, 'node_modules', '.modules.yaml'));
  removedNonRuntimePaths += removeReviewedPath(join(virtualStore, 'lock.yaml'));
  for (const packageRoot of packageRoots(virtualStore, 'better-sqlite3')) {
    for (const pathWithinPackage of [
      'README.md',
      'binding.gyp',
      'deps',
      'src',
      join('node_modules', '.bin'),
    ]) {
      removedNonRuntimePaths += removeReviewedPath(join(packageRoot, pathWithinPackage));
    }
  }
  for (const packageRoot of packageRoots(virtualStore, 'bindings')) {
    removedNonRuntimePaths += removeReviewedPath(join(packageRoot, 'README.md'));
  }
  for (const packageRoot of packageRoots(virtualStore, 'rc')) {
    removedNonRuntimePaths += removeReviewedPath(join(packageRoot, 'README.md'));
    removedNonRuntimePaths += removeReviewedPath(join(packageRoot, 'test'));
  }
  for (const packageRoot of packageRoots(virtualStore, 'tar-fs')) {
    removedNonRuntimePaths += removeReviewedPath(join(packageRoot, 'test'));
  }

  console.log(
    `production-deploy-prune: removed ${removedArchives} reviewed archive(s) and ${removedNonRuntimePaths} non-runtime path(s)`,
  );
  return removedArchives;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: prune-deployed-api.mjs <production-deploy-directory>');
    process.exit(64);
  }
  try {
    pruneDeployedApi(path);
  } catch (error) {
    const code = error instanceof PruneFailure ? error.code : 'unexpected_prune_failure';
    console.error(`PRODUCTION DEPLOY PRUNE FAILED — [${code}]`);
    process.exit(1);
  }
}
