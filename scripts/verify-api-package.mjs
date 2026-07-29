import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const repositoryRoot = process.cwd();
const sandbox = await mkdtemp(join(tmpdir(), 'velograph-api-package-'));
const packageDirectory = join(sandbox, 'package');
const installDirectory = join(sandbox, 'install');
const dataDirectory = join(sandbox, 'data');
let server;

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

function run(command, args, cwd) {
  const result = execute(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? 'signal'}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function assertValueFree(output, forbidden) {
  for (const value of forbidden) {
    if (output.includes(value)) {
      throw new Error('installed API output exposed forbidden synthetic/private token');
    }
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  for (
    let attempt = 0;
    attempt < 40 && server.exitCode === null && server.signalCode === null;
    attempt++
  ) {
    await delay(50);
  }
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
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
  const npmExecutable = join(
    dirname(process.execPath),
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
  );
  run(npmExecutable, ['install', '--prefer-offline', '--no-audit', '--no-fund'], installDirectory);

  const installedPackageDirectory = join(installDirectory, 'node_modules', '@velograph', 'api');
  const installedManifestPath = join(installedPackageDirectory, 'package.json');
  const packagedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8'));
  if (
    packagedManifest.bin?.['velograph-api'] !== './dist/velograph-api.mjs' ||
    packagedManifest.scripts?.start !== 'node dist/velograph-api.mjs'
  ) {
    throw new Error('installed API does not target the built JavaScript artifact');
  }
  if (
    typeof packagedManifest.dependencies?.['better-sqlite3'] !== 'string' ||
    typeof packagedManifest.dependencies?.fflate !== 'string'
  ) {
    throw new Error('installed API is missing direct runtime dependencies');
  }

  const executable = join(
    installDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'velograph-api.CMD' : 'velograph-api',
  );
  server = spawn(executable, [], {
    cwd: installDirectory,
    env: environment({
      VELO_DATA_DIR: dataDirectory,
      VELO_HOST: '127.0.0.1',
      VELO_PORT: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    const match = /Velograph listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
    if (match) {
      port = Number(match[1]);
      break;
    }
    if (server.exitCode !== null) {
      throw new Error(`installed API exited before listening: ${stdout}\n${stderr}`);
    }
    await delay(100);
  }
  if (!port) throw new Error(`installed API did not listen in time: ${stdout}\n${stderr}`);

  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const health = await response.json();
  if (!response.ok || health?.ok !== true || typeof health?.version !== 'string') {
    throw new Error('installed API health check failed');
  }
  assertValueFree(`${stdout}${stderr}`, [sandbox, dataDirectory, 'node:internal']);
  await stopServer();

  const runtimePath = join(installedPackageDirectory, 'dist', 'api-runtime.mjs');
  await rename(runtimePath, `${runtimePath}.missing`);
  const failed = execute(executable, [], installDirectory, {
    VELO_DATA_DIR: dataDirectory,
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
  assertValueFree(`${failed.stdout}${failed.stderr}`, [sandbox, dataDirectory, 'node:internal']);

  console.log(`api-package: installed server passed on Node ${process.versions.node}`);
} finally {
  await stopServer();
  await rm(sandbox, { recursive: true, force: true });
}
