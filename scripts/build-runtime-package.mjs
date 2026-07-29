import { builtinModules } from 'node:module';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { build } from 'esbuild';

const RUNTIME_EXTERNALS = new Set(['better-sqlite3', 'fflate']);
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith('node:') ? name : `node:${name}`]),
);
const REQUIRED_MIGRATIONS = [
  '0001_init.sql',
  '0002_source_file_reprocessing_failures.sql',
  '0003_workout_source_files.sql',
  '0004_backup_manifest.sql',
];

function normalizePath(path) {
  return path.replaceAll('\\', '/');
}

function validateMetafile(metafile) {
  for (const input of Object.keys(metafile.inputs)) {
    if (normalizePath(input).split('/').includes('node_modules')) {
      throw new Error('runtime_build_bundled_node_modules');
    }
  }

  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external) continue;
      if (imported.path.startsWith('@velograph/')) {
        throw new Error('runtime_build_external_workspace');
      }
      if (!NODE_BUILTINS.has(imported.path) && !RUNTIME_EXTERNALS.has(imported.path)) {
        throw new Error('runtime_build_unexpected_external');
      }
    }
  }
}

async function canonicalMigrationNames(directory) {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const required of REQUIRED_MIGRATIONS) {
    if (!names.includes(required)) throw new Error('runtime_build_missing_canonical_migration');
  }
  return names;
}

async function copyAndVerifyMigrations(sourceDirectory, outputDirectory) {
  await cp(sourceDirectory, outputDirectory, { recursive: true });
  const [sourceNames, outputNames] = await Promise.all([
    canonicalMigrationNames(sourceDirectory),
    canonicalMigrationNames(outputDirectory),
  ]);
  if (
    sourceNames.length !== outputNames.length ||
    sourceNames.some((name, index) => name !== outputNames[index])
  ) {
    throw new Error('runtime_build_migration_set_mismatch');
  }
  for (const name of sourceNames) {
    const [source, output] = await Promise.all([
      readFile(join(sourceDirectory, name)),
      readFile(join(outputDirectory, name)),
    ]);
    if (!source.equals(output)) throw new Error('runtime_build_migration_content_mismatch');
  }
}

async function copyDirectory(source, destination) {
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) throw new Error('runtime_build_directory_missing');
  await cp(source, destination, { recursive: true });
}

/**
 * Build one self-contained Velograph workspace runtime. Workspace source is
 * bundled; only the native SQLite driver and ZIP implementation remain normal
 * install-time dependencies.
 */
export async function buildRuntimePackage({
  repositoryRoot,
  packageRoot,
  entryPoint,
  launcher,
  executableName,
  runtimeName,
  metafileName,
  webDirectory,
}) {
  const outputDirectory = join(packageRoot, 'dist');
  const migrationOutput = join(packageRoot, 'migrations');
  const canonicalMigrations = join(repositoryRoot, 'packages', 'db', 'migrations');
  const runtimeFile = join(outputDirectory, runtimeName);
  const executable = join(outputDirectory, executableName);

  await rm(outputDirectory, { recursive: true, force: true });
  await rm(migrationOutput, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [entryPoint],
    outfile: runtimeFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20.19'],
    external: [...RUNTIME_EXTERNALS],
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
  });
  validateMetafile(result.metafile);

  await Promise.all([
    copyFile(launcher, executable),
    writeFile(join(outputDirectory, metafileName), `${JSON.stringify(result.metafile, null, 2)}\n`),
    copyAndVerifyMigrations(canonicalMigrations, migrationOutput),
  ]);
  await chmod(executable, 0o755);

  if (webDirectory) {
    await copyDirectory(webDirectory, join(outputDirectory, 'web'));
  }

  // Third-party notices travel with local release tarballs when the canonical
  // notice exists. Deliberately do not fall back to a project LICENSE file:
  // those documents have different legal purposes.
  const notice = join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
  if (existsSync(notice)) {
    const destination = join(outputDirectory, basename(notice));
    await copyFile(notice, destination);
    const [sourceBytes, copiedBytes] = await Promise.all([readFile(notice), readFile(destination)]);
    if (!sourceBytes.equals(copiedBytes)) throw new Error('runtime_build_notice_content_mismatch');
  }
}
