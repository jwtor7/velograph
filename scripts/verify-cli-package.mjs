import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = process.cwd();
const sandbox = await mkdtemp(join(tmpdir(), 'velograph-cli-package-'));
const packageDirectory = join(sandbox, 'package');
const installDirectory = join(sandbox, 'install');
const dataDirectory = join(sandbox, 'data');
const fixturePath = join(sandbox, 'Outdoor Cycling-Heart Rate-20310102_080000.csv');

function execute(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    },
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
      throw new Error(`installed CLI output exposed forbidden synthetic/private token`);
    }
  }
}

try {
  await Promise.all([
    writeFile(
      fixturePath,
      [
        'Date/Time,Avg (bpm),Source',
        '2031-01-02T08:00:00Z,120,Synthetic Sensor',
        '2031-01-02T08:01:00Z,124,Synthetic Sensor',
      ].join('\n'),
    ),
    writeFile(
      join(sandbox, 'README.txt'),
      'All files in this temporary package test use invented synthetic values.\n',
    ),
  ]);
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
  const npmExecutable = join(
    dirname(process.execPath),
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
  );
  run(npmExecutable, ['install', '--prefer-offline', '--no-audit', '--no-fund'], installDirectory);

  const executable = join(
    installDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'velograph-import.CMD' : 'velograph-import',
  );
  const imported = run(
    executable,
    ['import', fixturePath, '--data-dir', dataDirectory],
    installDirectory,
  );
  if (
    !/imported files:\s+1/.test(imported.stdout) ||
    !/workouts created:\s+1/.test(imported.stdout)
  ) {
    throw new Error('installed CLI did not import the synthetic fixture');
  }
  assertValueFree(`${imported.stdout}${imported.stderr}`, [
    fixturePath,
    dataDirectory,
    '2031-01-02T08:00:00Z',
    'Synthetic Sensor',
    '120',
    '124',
  ]);
  const installedManifestPath = join(
    installDirectory,
    'node_modules',
    '@velograph',
    'cli',
    'package.json',
  );
  const packagedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8'));
  if (packagedManifest.bin?.['velograph-import'] !== './dist/velograph-import.mjs') {
    throw new Error('installed CLI bin does not target the built JavaScript artifact');
  }
  if (
    typeof packagedManifest.dependencies?.['better-sqlite3'] !== 'string' ||
    typeof packagedManifest.dependencies?.fflate !== 'string'
  ) {
    throw new Error('installed CLI is missing direct runtime dependencies');
  }

  // The launcher must catch failures that occur while the implementation
  // module itself is resolving. A static import before the try would expose a
  // Node stack and this temporary absolute path.
  const installedPackageDirectory = dirname(installedManifestPath);
  const runtimePath = join(installedPackageDirectory, 'dist', 'cli-runtime.mjs');
  await rename(runtimePath, `${runtimePath}.missing`);
  const failed = execute(
    executable,
    ['import', fixturePath, '--data-dir', dataDirectory],
    installDirectory,
  );
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
    '120',
    '124',
    'node:internal',
  ]);
  console.log(`cli-package: installed binary passed on Node ${process.versions.node}`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
