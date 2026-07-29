import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRuntimeDependencyContract } from './runtime-package-contract.mjs';

const repositoryRoot = process.cwd();
const sandbox = await mkdtemp(join(tmpdir(), 'velograph-cli-package-'));
const packageDirectory = join(sandbox, 'package');
const installDirectory = join(sandbox, 'install');
const dataDirectory = join(sandbox, 'data');
const fixturePath = join(sandbox, 'Outdoor Cycling-Heart Rate-20310102_080000.csv');
const quarantinePath = join(sandbox, 'Outdoor Cycling-Heart Rate-20390101_010101.csv');
const oversizedPath = join(sandbox, 'Outdoor Cycling-Heart Rate-20390101_020202.csv');
const backupPath = join(sandbox, 'synthetic-backup.sqlite3');
const canonicalMigrations = join(repositoryRoot, 'packages', 'db', 'migrations');

function environment(extra = {}) {
  return {
    ...process.env,
    CI: '1',
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ...extra,
  };
}

function execute(command, args, cwd, extraEnvironment = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment(extraEnvironment),
  });
}

function run(command, args, cwd, extraEnvironment = {}) {
  const result = execute(command, args, cwd, extraEnvironment);
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? 'signal'}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function assertValueFree(output, forbidden) {
  for (const value of forbidden) {
    if (value && output.includes(value)) {
      throw new Error('installed CLI output exposed forbidden synthetic/private token');
    }
  }
}

async function verifyMigrationCopies(installedPackageDirectory) {
  const canonicalNames = (await readdir(canonicalMigrations))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const installedMigrations = join(installedPackageDirectory, 'migrations');
  const installedNames = (await readdir(installedMigrations))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  if (
    canonicalNames.length !== installedNames.length ||
    canonicalNames.some((name, index) => name !== installedNames[index])
  ) {
    throw new Error('installed CLI migration set differs from canonical migrations');
  }
  for (const name of canonicalNames) {
    const [canonical, installed] = await Promise.all([
      readFile(join(canonicalMigrations, name)),
      readFile(join(installedMigrations, name)),
    ]);
    if (!canonical.equals(installed)) {
      throw new Error('installed CLI migration bytes differ from canonical migrations');
    }
  }
}

async function installedDependencyVersion(installedPackageDirectory, name) {
  for (const path of [
    join(installDirectory, 'node_modules', name, 'package.json'),
    join(installedPackageDirectory, 'node_modules', name, 'package.json'),
  ]) {
    if (!existsSync(path)) continue;
    return JSON.parse(await readFile(path, 'utf8')).version;
  }
  throw new Error('installed CLI runtime dependency is missing');
}

try {
  await writeFile(
    fixturePath,
    [
      'Date/Time,Avg (bpm),Source',
      '2031-01-02T08:00:00Z,120,Synthetic Sensor',
      '2031-01-02T08:01:00Z,124,Synthetic Sensor',
      '2031-01-02T08:02:00Z,122,Synthetic Sensor',
    ].join('\n'),
  );
  await writeFile(quarantinePath, 'invented malformed private source\n');
  await writeFile(oversizedPath, '');
  await truncate(oversizedPath, 64 * 1024 * 1024 + 1);
  await Promise.all([mkdir(packageDirectory), mkdir(installDirectory)]);

  run(
    'pnpm',
    ['--filter', '@velograph/cli', 'pack', '--pack-destination', packageDirectory],
    repositoryRoot,
  );
  const archives = (await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error('expected exactly one CLI package archive');
  const archivePath = join(packageDirectory, archives[0]);
  await writeFile(
    join(installDirectory, 'package.json'),
    JSON.stringify({
      name: 'synthetic-cli-install-test',
      private: true,
      dependencies: { '@velograph/cli': `file:${archivePath}` },
    }),
  );
  run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefer-offline', '--no-audit', '--no-fund'],
    installDirectory,
  );

  const installedPackageDirectory = join(installDirectory, 'node_modules', '@velograph', 'cli');
  const packagedManifest = JSON.parse(
    await readFile(join(installedPackageDirectory, 'package.json'), 'utf8'),
  );
  if (
    packagedManifest.private !== true ||
    packagedManifest.bin?.['velograph-import'] !== './dist/velograph-import.mjs' ||
    packagedManifest.engines?.node !== '^20.19.0 || >=22.12.0 <27'
  ) {
    throw new Error('installed CLI manifest does not target the supported built runtime');
  }
  assertRuntimeDependencyContract(packagedManifest);
  const [sqliteVersion, fflateVersion] = await Promise.all([
    installedDependencyVersion(installedPackageDirectory, 'better-sqlite3'),
    installedDependencyVersion(installedPackageDirectory, 'fflate'),
  ]);
  if (sqliteVersion !== '12.11.1' || fflateVersion !== '0.8.3') {
    throw new Error('installed CLI runtime dependency version is not the audited version');
  }

  await verifyMigrationCopies(installedPackageDirectory);
  const canonicalNotice = join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
  const [canonical, installed] = await Promise.all([
    readFile(canonicalNotice),
    readFile(join(installedPackageDirectory, 'dist', 'THIRD_PARTY_NOTICES.md')),
  ]);
  if (!canonical.equals(installed)) throw new Error('installed CLI notice differs from canonical');
  if (existsSync(join(installedPackageDirectory, 'dist', 'LICENSE'))) {
    throw new Error('installed CLI substituted the project LICENSE for third-party notices');
  }

  const launcher = join(installedPackageDirectory, 'dist', 'velograph-import.mjs');
  const runCli = (args, extraEnvironment = {}) =>
    execute(process.execPath, [launcher, ...args], installDirectory, {
      VELO_DATA_DIR: '',
      ...extraEnvironment,
    });
  const privateTokens = [
    fixturePath,
    dataDirectory,
    '2031-01-02T08:00:00Z',
    'Synthetic Sensor',
    '120',
    '124',
    '122',
  ];

  const imported = runCli(['import', fixturePath, '--data-dir', dataDirectory]);
  if (
    imported.status !== 0 ||
    !/imported files:\s+1/.test(imported.stdout) ||
    !/workouts created:\s+1/.test(imported.stdout)
  ) {
    throw new Error('installed CLI did not import the synthetic fixture');
  }
  assertValueFree(`${imported.stdout}${imported.stderr}`, privateTokens);

  const installedRequire = createRequire(join(installDirectory, 'package.json'));
  const DatabaseConstructor = installedRequire('better-sqlite3');
  const databasePath = join(dataDirectory, 'velograph.sqlite3');
  const inspectDatabase = () => new DatabaseConstructor(databasePath, { readonly: true });
  let database = inspectDatabase();
  const workout = database.prepare('SELECT id FROM workouts ORDER BY id LIMIT 1').get();
  if (!Number.isSafeInteger(workout?.id)) throw new Error('installed CLI created no workout');
  const workoutId = workout.id;
  const storedName = database
    .prepare('SELECT original_name FROM source_files ORDER BY id LIMIT 1')
    .get()?.original_name;
  database.close();
  if (storedName !== 'Outdoor Cycling-Heart Rate-20310102_080000.csv') {
    throw new Error('installed CLI did not store only the portable source basename');
  }

  const quarantined = runCli(['import', quarantinePath, '--data-dir', dataDirectory]);
  if (
    quarantined.status !== 0 ||
    !/quarantined:\s+1/.test(quarantined.stdout) ||
    !/quarantined \[[a-z_]+\]: 1/.test(quarantined.stdout)
  ) {
    throw new Error('installed CLI did not report a value-free quarantine summary');
  }
  assertValueFree(`${quarantined.stdout}${quarantined.stderr}`, [
    sandbox,
    quarantinePath,
    '20390101',
    '010101',
  ]);

  const oversized = runCli(['import', oversizedPath, '--data-dir', dataDirectory]);
  if (
    oversized.status !== 1 ||
    oversized.stdout !== '' ||
    oversized.stderr.trim() !== 'Import failed: import_failed'
  ) {
    throw new Error('installed CLI did not reject an oversized direct file');
  }
  assertValueFree(`${oversized.stdout}${oversized.stderr}`, [
    sandbox,
    oversizedPath,
    '20390101',
    '020202',
  ]);
  database = inspectDatabase();
  if (database.prepare('SELECT count(*) AS count FROM workouts').get().count !== 1) {
    throw new Error('installed CLI oversized-file rejection mutated workouts');
  }
  database.close();

  const runtimeModule = await import(
    `${pathToFileURL(join(installedPackageDirectory, 'dist', 'cli-runtime.mjs')).href}?verify=1`
  );
  if (
    runtimeModule.portableBasename(
      'C:\\synthetic\\export\\Outdoor Cycling-Heart Rate-20310102_080000.csv',
    ) !== 'Outdoor Cycling-Heart Rate-20310102_080000.csv'
  ) {
    throw new Error('installed CLI does not normalize a Windows source basename');
  }

  const repaired = runCli(['repair', String(workoutId), '--data-dir', dataDirectory]);
  if (repaired.status !== 0 || !repaired.stdout.includes(`Repaired workout ${workoutId}`)) {
    throw new Error('installed CLI did not repair the synthetic workout');
  }
  assertValueFree(`${repaired.stdout}${repaired.stderr}`, privateTokens);

  const backedUp = runCli(['backup', backupPath, '--data-dir', dataDirectory]);
  if (backedUp.status !== 0 || !backedUp.stdout.includes('Backup written')) {
    throw new Error('installed CLI did not create the synthetic backup');
  }
  assertValueFree(`${backedUp.stdout}${backedUp.stderr}`, [...privateTokens, backupPath]);

  const deleted = runCli(['delete', String(workoutId), '--data-dir', dataDirectory]);
  if (deleted.status !== 0) throw new Error('installed CLI did not delete the synthetic workout');
  database = inspectDatabase();
  if (database.prepare('SELECT count(*) AS count FROM workouts').get().count !== 0) {
    throw new Error('installed CLI delete did not remove the synthetic workout');
  }
  database.close();

  const unconfirmed = runCli(['restore', backupPath, '--data-dir', dataDirectory]);
  if (
    unconfirmed.status !== 2 ||
    unconfirmed.stderr.trim() !== 'Restore requires --confirm-replace'
  ) {
    throw new Error('installed CLI restored without explicit confirmation');
  }
  const restored = runCli([
    'restore',
    backupPath,
    '--confirm-replace',
    '--data-dir',
    dataDirectory,
  ]);
  if (restored.status !== 0 || !restored.stdout.includes('verified')) {
    throw new Error('installed CLI did not restore the confirmed synthetic backup');
  }
  assertValueFree(`${restored.stdout}${restored.stderr}`, [...privateTokens, backupPath]);
  database = inspectDatabase();
  if (database.prepare('SELECT count(*) AS count FROM workouts').get().count !== 1) {
    throw new Error('installed CLI restore did not recover the synthetic workout');
  }
  database.close();

  const fallbackDirectory = join(sandbox, 'must-not-fallback');
  for (const invalidArgs of [
    ['import', fixturePath, '--data-dir'],
    ['import', fixturePath, '--data-dir', ''],
    [
      'import',
      fixturePath,
      '--data-dir',
      join(sandbox, 'first-data-dir'),
      '--data-dir',
      join(sandbox, 'second-data-dir'),
    ],
  ]) {
    const invalid = runCli(invalidArgs, { VELO_DATA_DIR: fallbackDirectory });
    if (invalid.status !== 2 || !invalid.stdout.startsWith('Usage:')) {
      throw new Error('installed CLI accepted an invalid data-dir option');
    }
    assertValueFree(`${invalid.stdout}${invalid.stderr}`, [
      sandbox,
      fixturePath,
      fallbackDirectory,
    ]);
  }
  if (existsSync(fallbackDirectory)) {
    throw new Error('installed CLI resolved the default data directory after invalid arguments');
  }

  const runtimePath = join(installedPackageDirectory, 'dist', 'cli-runtime.mjs');
  await rename(runtimePath, `${runtimePath}.missing`);
  const failed = runCli(['import', fixturePath, '--data-dir', dataDirectory]);
  if (
    failed.status !== 1 ||
    failed.stdout !== '' ||
    failed.stderr.trim() !== 'Command failed: unexpected_error'
  ) {
    throw new Error('installed CLI module-load failure was not safely contained');
  }
  assertValueFree(`${failed.stdout}${failed.stderr}`, [
    sandbox,
    fixturePath,
    dataDirectory,
    '2031-01-02T08:00:00Z',
    'Synthetic Sensor',
    'node:internal',
  ]);

  console.log(`cli-package: installed binary passed on Node ${process.versions.node}`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
