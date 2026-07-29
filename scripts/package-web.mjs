#!/usr/bin/env node
/**
 * Build the web client while emitting privacy-safe, deterministic evidence of
 * every package represented in Rollup's output modules.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(repositoryRoot, 'apps', 'web');
const outputRoot = join(webRoot, 'dist');
const evidenceFile = 'third-party-module-evidence.json';
const webRequire = createRequire(join(webRoot, 'package.json'));
const outputMetadata = new Map();
let buildPackages;
let injectedModules;

// Vite's programmatic build API does not set NODE_ENV for callers. Force the
// production React/JSX branches so deployable bundles never contain development
// diagnostics or absolute source paths.
process.env.NODE_ENV = 'production';

function fail(code) {
  throw new Error(code);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function containedPath(root, path) {
  const candidate = relative(root, path);
  return !isAbsolute(candidate) && candidate !== '..' && !candidate.startsWith(`..${sep}`);
}

function absoluteModulePath(moduleId) {
  if (moduleId.startsWith('\0')) return undefined;
  const withoutQuery = moduleId.split('?')[0];
  if (isAbsolute(withoutQuery)) return withoutQuery;
  return undefined;
}

function packageIdentityFromPath(modulePath) {
  let sourcePath;
  try {
    const stat = lstatSync(modulePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('web_build_module_source_invalid');
    }
    sourcePath = realpathSync(modulePath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('web_build_')) throw error;
    fail('web_build_module_source_invalid');
  }
  if (!containedPath(repositoryRoot, sourcePath)) {
    fail('web_build_module_outside_checkout');
  }
  let current = dirname(sourcePath);
  while (containedPath(repositoryRoot, current)) {
    const manifestPath = join(current, 'package.json');
    if (existsSync(manifestPath)) {
      const stat = lstatSync(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail('web_build_package_metadata_invalid');
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
        fail('web_build_package_identity_missing');
      }
      return `${manifest.name}@${manifest.version}`;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail('web_build_module_outside_reviewed_packages');
}

function moduleEvidence(moduleId) {
  if (moduleId === '\0vite/modulepreload-polyfill.js') {
    return { injectedModule: 'vite-modulepreload-polyfill' };
  }
  if (moduleId.startsWith('\0')) {
    const commonJsWrapper = moduleId.match(
      /^\0(.+)\?(?:commonjs-exports|commonjs-es-import|commonjs-module)$/,
    );
    if (!commonJsWrapper || !isAbsolute(commonJsWrapper[1]) || commonJsWrapper[1].includes('?')) {
      fail('web_build_unattributed_virtual_module');
    }
    return { packageId: packageIdentityFromPath(commonJsWrapper[1]) };
  }
  const modulePath = absoluteModulePath(moduleId);
  if (modulePath) {
    return { packageId: packageIdentityFromPath(modulePath) };
  }
  fail('web_build_unattributed_module');
}

function originalFilePackageIdentity(originalFileName) {
  if (typeof originalFileName !== 'string' || originalFileName.length === 0) {
    fail('web_build_asset_source_missing');
  }
  const sourcePath = isAbsolute(originalFileName)
    ? originalFileName
    : resolve(webRoot, originalFileName);
  return packageIdentityFromPath(sourcePath);
}

function sortedPackages(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertNoPublicAssets() {
  const publicRoot = join(webRoot, 'public');
  if (!existsSync(publicRoot)) return;
  const stat = lstatSync(publicRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(publicRoot).length > 0) {
    fail('web_build_unreviewed_public_assets');
  }
}

function assertSafeOutputRoot() {
  if (!existsSync(outputRoot)) return;
  const stat = lstatSync(outputRoot);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !containedPath(webRoot, realpathSync(outputRoot))
  ) {
    fail('web_build_output_root_invalid');
  }
}

function collectOutputFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectOutputFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join('/'));
    } else {
      fail('web_build_non_regular_output');
    }
  }
  return files;
}

function licenceEvidencePlugin() {
  return {
    name: 'velograph-third-party-module-evidence',
    apply: 'build',
    generateBundle(_options, bundle) {
      const packageModules = new Map();
      const injected = new Set();

      for (const output of Object.values(bundle)) {
        const packages = new Set();
        if (output.type === 'chunk') {
          for (const moduleId of Object.keys(output.modules)) {
            const module = moduleEvidence(moduleId);
            if (module.packageId) {
              const modules = packageModules.get(module.packageId) ?? new Set();
              modules.add(moduleId);
              packageModules.set(module.packageId, modules);
              packages.add(module.packageId);
            }
            if (module.injectedModule) {
              injected.add(module.injectedModule);
            }
          }
          outputMetadata.set(output.fileName, {
            generatedBy: 'rollup-chunk',
            packages: sortedPackages(packages),
          });
          continue;
        }

        if (!Array.isArray(output.originalFileNames) || output.originalFileNames.length === 0) {
          fail('web_build_asset_source_missing');
        }
        for (const source of output.originalFileNames) {
          packages.add(originalFilePackageIdentity(source));
        }
        outputMetadata.set(output.fileName, {
          generatedBy: 'rollup-asset',
          packages: sortedPackages(packages),
        });
      }

      buildPackages = [...packageModules]
        .map(([id, modules]) => ({ id, moduleCount: modules.size }))
        .sort((left, right) => left.id.localeCompare(right.id));
      injectedModules = [...injected].sort();
    },
  };
}

assertNoPublicAssets();
assertSafeOutputRoot();
const viteEntrypoint = webRequire.resolve('vite');
const reactPluginEntrypoint = webRequire.resolve('@vitejs/plugin-react');
const { build } = await import(pathToFileURL(viteEntrypoint).href);
const { default: react } = await import(pathToFileURL(reactPluginEntrypoint).href);
await build({
  root: webRoot,
  mode: 'production',
  plugins: [react(), licenceEvidencePlugin()],
});

if (!buildPackages || !injectedModules) fail('web_build_evidence_not_generated');
outputMetadata.set('index.html', {
  generatedBy: 'vite-html-entry',
  packages: [packageIdentityFromPath(join(webRoot, 'index.html'))],
});

const files = collectOutputFiles(outputRoot)
  .filter((file) => file !== evidenceFile)
  .map((file) => {
    const metadata = outputMetadata.get(file);
    if (!metadata) fail('web_build_output_source_missing');
    const content = readFileSync(join(outputRoot, ...file.split('/')));
    if (file.endsWith('.js')) {
      const javascript = content.toString('utf8');
      if (
        javascript.includes('jsxDEV') ||
        javascript.includes('Each child in a list should have a unique')
      ) {
        fail('web_build_development_jsx_runtime');
      }
      if (javascript.replaceAll(String.fromCharCode(92), '/').includes('/apps/web/src/')) {
        fail('web_build_absolute_source_path');
      }
    }
    return {
      file,
      sha256: sha256(content),
      bytes: content.length,
      ...metadata,
    };
  })
  .sort((left, right) => left.file.localeCompare(right.file));

if (files.length !== outputMetadata.size) fail('web_build_output_set_mismatch');
writeFileSync(
  join(outputRoot, evidenceFile),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      packages: buildPackages,
      injectedModules,
      files,
    },
    null,
    2,
  )}\n`,
);
