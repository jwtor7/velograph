import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRuntimeDependencyContract } from './runtime-package-contract.mjs';
import { PROJECT_LICENSE_SPDX, verifyWebArtifactContents } from './third-party-license-gate.mjs';

const repositoryRoot = process.cwd();
const sandbox = await mkdtemp(join(tmpdir(), 'velograph-api-package-'));
const packageDirectory = join(sandbox, 'package');
const installDirectory = join(sandbox, 'install');
const freshDataDirectory = join(sandbox, 'fresh-data');
const legacyDataDirectory = join(sandbox, 'legacy-data');
const canonicalMigrations = join(repositoryRoot, 'packages', 'db', 'migrations');
const activeServers = new Set();

function environment(extra = {}) {
  const env = {
    ...process.env,
    CI: '1',
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    ...extra,
  };
  delete env['VELO_BASEMAP_PATH'];
  delete env['VELO_EXIT_WITH_PARENT_PID'];
  return env;
}

function execute(command, args, cwd, extraEnvironment = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment(extraEnvironment),
  });
}

function run(command, args, cwd) {
  const result = execute(command, args, cwd);
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
      throw new Error('installed API output exposed forbidden synthetic/private token');
    }
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('installed API contains a symlinked web asset');
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function waitForExit(server, timeoutMs) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return { code: server.exitCode, signal: server.signalCode };
  }
  return Promise.race([
    new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
    delay(timeoutMs).then(() => null),
  ]);
}

async function stopServer(server, requireCleanExit = false) {
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  let outcome = await waitForExit(server, 15_000);
  if (!outcome) {
    server.kill('SIGKILL');
    outcome = await waitForExit(server, 2000);
  }
  activeServers.delete(server);
  if (!outcome) throw new Error('installed API did not exit');
  if (requireCleanExit && (outcome.code !== 0 || outcome.signal !== null)) {
    throw new Error('installed API did not exit zero after SIGTERM');
  }
}

async function startServer(launcher, dataDirectory) {
  const server = spawn(process.execPath, [launcher], {
    cwd: installDirectory,
    env: environment({
      VELO_DATA_DIR: dataDirectory,
      VELO_HOST: '127.0.0.1',
      VELO_PORT: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeServers.add(server);
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  server.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  for (let attempt = 0; attempt < 200; attempt++) {
    const match = /Velograph listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
    if (match) return { server, port: Number(match[1]), output: () => `${stdout}${stderr}` };
    if (server.exitCode !== null || server.signalCode !== null) {
      activeServers.delete(server);
      throw new Error(`installed API exited before listening:\n${stdout}\n${stderr}`);
    }
    await delay(100);
  }
  await stopServer(server);
  throw new Error(`installed API did not listen in time:\n${stdout}\n${stderr}`);
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
    throw new Error('installed API migration set differs from canonical migrations');
  }
  for (const name of canonicalNames) {
    const [canonical, installed] = await Promise.all([
      readFile(join(canonicalMigrations, name)),
      readFile(join(installedMigrations, name)),
    ]);
    if (!canonical.equals(installed)) {
      throw new Error('installed API migration bytes differ from canonical migrations');
    }
  }
  return canonicalNames;
}

async function installedDependencyVersion(installedPackageDirectory, name) {
  for (const path of [
    join(installDirectory, 'node_modules', name, 'package.json'),
    join(installedPackageDirectory, 'node_modules', name, 'package.json'),
  ]) {
    if (!existsSync(path)) continue;
    return JSON.parse(await readFile(path, 'utf8')).version;
  }
  throw new Error('installed API runtime dependency is missing');
}

try {
  await Promise.all([mkdir(packageDirectory), mkdir(installDirectory)]);
  run(
    'pnpm',
    ['--filter', '@velograph/api', 'pack', '--pack-destination', packageDirectory],
    repositoryRoot,
  );
  const archives = (await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error('expected exactly one API package archive');
  const archivePath = join(packageDirectory, archives[0]);
  await writeFile(
    join(installDirectory, 'package.json'),
    JSON.stringify({
      name: 'synthetic-api-install-test',
      private: true,
      dependencies: { '@velograph/api': `file:${archivePath}` },
    }),
  );
  run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefer-offline', '--no-audit', '--no-fund'],
    installDirectory,
  );

  const installedPackageDirectory = join(installDirectory, 'node_modules', '@velograph', 'api');
  const packagedManifest = JSON.parse(
    await readFile(join(installedPackageDirectory, 'package.json'), 'utf8'),
  );
  if (
    packagedManifest.private !== true ||
    packagedManifest.exports?.['.'] !== './dist/api-runtime.mjs' ||
    packagedManifest.bin?.['velograph-api'] !== './dist/velograph-api.mjs' ||
    packagedManifest.scripts?.start !== 'node dist/velograph-api.mjs' ||
    packagedManifest.license !== PROJECT_LICENSE_SPDX ||
    packagedManifest.engines?.node !== '^20.19.0 || >=22.12.0 <27' ||
    existsSync(join(installedPackageDirectory, 'src'))
  ) {
    throw new Error('installed API manifest does not target the supported built runtime');
  }
  const installedModule = await import(
    pathToFileURL(join(installedPackageDirectory, 'dist', 'api-runtime.mjs')).href
  );
  if (
    typeof installedModule.main !== 'function' ||
    typeof installedModule.createApiServer !== 'function' ||
    typeof installedModule.repairWorkout !== 'function'
  ) {
    throw new Error('installed API module export does not target the built runtime');
  }
  assertRuntimeDependencyContract(packagedManifest);
  const [sqliteVersion, fflateVersion] = await Promise.all([
    installedDependencyVersion(installedPackageDirectory, 'better-sqlite3'),
    installedDependencyVersion(installedPackageDirectory, 'fflate'),
  ]);
  if (sqliteVersion !== '12.11.1' || fflateVersion !== '0.8.3') {
    throw new Error('installed API runtime dependency version is not the audited version');
  }

  const migrationNames = await verifyMigrationCopies(installedPackageDirectory);
  const canonicalNotice = join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
  const canonicalLicense = join(repositoryRoot, 'LICENSE');
  const canonicalCopyright = join(repositoryRoot, 'COPYRIGHT.md');
  const [
    canonicalNoticeBytes,
    installedNotice,
    canonicalLicenseBytes,
    installedLicense,
    canonicalCopyrightBytes,
    installedCopyright,
  ] = await Promise.all([
    readFile(canonicalNotice),
    readFile(join(installedPackageDirectory, 'dist', 'THIRD_PARTY_NOTICES.md')),
    readFile(canonicalLicense),
    readFile(join(installedPackageDirectory, 'dist', 'LICENSE')),
    readFile(canonicalCopyright),
    readFile(join(installedPackageDirectory, 'dist', 'COPYRIGHT.md')),
  ]);
  if (!canonicalNoticeBytes.equals(installedNotice)) {
    throw new Error('installed API notice differs from canonical');
  }
  if (!canonicalLicenseBytes.equals(installedLicense)) {
    throw new Error('installed API project license differs from canonical');
  }
  if (!canonicalCopyrightBytes.equals(installedCopyright)) {
    throw new Error('installed API project copyright notice differs from canonical');
  }

  const launcher = join(installedPackageDirectory, 'dist', 'velograph-api.mjs');
  const fresh = await startServer(launcher, freshDataDirectory);
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${fresh.port}/api/health`);
    const health = await healthResponse.json();
    if (!healthResponse.ok || health?.ok !== true || health.version !== packagedManifest.version) {
      throw new Error('installed API health/version check failed');
    }

    const manifestResponse = await fetch(`http://127.0.0.1:${fresh.port}/api/basemap`);
    if (
      !manifestResponse.ok ||
      JSON.stringify(await manifestResponse.json()) !== JSON.stringify({ state: 'not_configured' })
    ) {
      throw new Error('installed API basemap manifest check failed');
    }

    const webDirectory = join(installedPackageDirectory, 'dist', 'web');
    const webFiles = await walk(webDirectory);
    if (webFiles.length < 2) throw new Error('installed API web client is incomplete');
    const webContents = new Map();
    for (const file of webFiles) {
      webContents.set(relative(webDirectory, file).replaceAll('\\', '/'), await readFile(file));
    }
    verifyWebArtifactContents(webContents, repositoryRoot);
    for (const file of webFiles) {
      const urlPath = relative(webDirectory, file)
        .split(/[\\/]/)
        .map((part) => encodeURIComponent(part))
        .join('/');
      const response = await fetch(
        urlPath === 'index.html'
          ? `http://127.0.0.1:${fresh.port}/`
          : `http://127.0.0.1:${fresh.port}/${urlPath}`,
      );
      const [served, packaged] = await Promise.all([
        response.arrayBuffer().then((value) => Buffer.from(value)),
        readFile(file),
      ]);
      if (!response.ok || !served.equals(packaged)) {
        throw new Error('installed API did not serve an exact packaged web asset');
      }
    }
    assertValueFree(fresh.output(), [sandbox, freshDataDirectory, 'node:internal']);
  } finally {
    await stopServer(fresh.server, true);
  }
  assertValueFree(fresh.output(), [sandbox, freshDataDirectory, 'node:internal']);

  await mkdir(legacyDataDirectory);
  const installedRequire = createRequire(join(installDirectory, 'package.json'));
  const DatabaseConstructor = installedRequire('better-sqlite3');
  const legacyDatabasePath = join(legacyDataDirectory, 'velograph.sqlite3');
  const legacyDatabase = new DatabaseConstructor(legacyDatabasePath);
  legacyDatabase.exec(
    await readFile(join(installedPackageDirectory, 'migrations', '0001_init.sql'), 'utf8'),
  );
  legacyDatabase.exec(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_init.sql', 1000);
  `);
  legacyDatabase
    .prepare('INSERT INTO user_settings (key, value_json) VALUES (?, ?)')
    .run('synthetic-package-setting', '"preserved"');
  legacyDatabase.close();

  const legacy = await startServer(launcher, legacyDataDirectory);
  await stopServer(legacy.server, true);
  assertValueFree(legacy.output(), [
    sandbox,
    legacyDataDirectory,
    'synthetic-package-setting',
    'preserved',
    'node:internal',
  ]);

  const upgraded = new DatabaseConstructor(legacyDatabasePath, { readonly: true });
  const columns = upgraded
    .prepare('PRAGMA table_info(schema_migrations)')
    .all()
    .map((column) => column.name);
  if (!columns.includes('checksum')) {
    throw new Error('installed API did not adopt the released filename-only migration history');
  }
  const applied = upgraded
    .prepare('SELECT name, checksum FROM schema_migrations ORDER BY rowid')
    .all();
  if (
    applied.length !== migrationNames.length ||
    applied.some(
      (migration, index) =>
        migration.name !== migrationNames[index] ||
        typeof migration.checksum !== 'string' ||
        !/^[a-f0-9]{64}$/.test(migration.checksum),
    )
  ) {
    throw new Error('installed API did not apply and pin every packaged migration');
  }
  if (
    upgraded
      .prepare("SELECT value_json FROM user_settings WHERE key = 'synthetic-package-setting'")
      .get()?.value_json !== '"preserved"'
  ) {
    throw new Error('installed API did not preserve the synthetic legacy row');
  }
  upgraded.close();

  const runtimePath = join(installedPackageDirectory, 'dist', 'api-runtime.mjs');
  await rename(runtimePath, `${runtimePath}.missing`);
  const failed = execute(process.execPath, [launcher], installDirectory, {
    VELO_DATA_DIR: freshDataDirectory,
    VELO_HOST: '127.0.0.1',
    VELO_PORT: '0',
  });
  if (
    failed.status !== 1 ||
    failed.stdout !== '' ||
    failed.stderr.trim() !== 'Server failed: unexpected_error'
  ) {
    throw new Error('installed API module-load failure was not safely contained');
  }
  assertValueFree(`${failed.stdout}${failed.stderr}`, [
    sandbox,
    freshDataDirectory,
    'node:internal',
  ]);

  console.log(`api-package: installed server passed on Node ${process.versions.node}`);
} finally {
  for (const server of activeServers) {
    try {
      await stopServer(server);
    } catch {
      // Preserve the primary verifier result while still attempting cleanup.
    }
  }
  await rm(sandbox, { recursive: true, force: true });
}
