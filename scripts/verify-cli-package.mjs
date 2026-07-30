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
const folderDataDirectory = join(sandbox, 'folder-data');
const zipDataDirectory = join(sandbox, 'zip-data');
const haeFolderDirectory = join(sandbox, 'synthetic-hae-folder');
const haeZipPath = join(sandbox, 'synthetic-hae-export.zip');
const fixturePath = join(sandbox, 'Outdoor Cycling-Heart Rate-20310102_080000.csv');
const quarantinePath = join(sandbox, 'Outdoor Cycling-Heart Rate-20390101_010101.csv');
const oversizedPath = join(sandbox, 'Outdoor Cycling-Heart Rate-20390101_020202.csv');
const backupPath = join(sandbox, 'synthetic-backup.sqlite3');
const canonicalMigrations = join(repositoryRoot, 'packages', 'db', 'migrations');
const workspaceRequire = createRequire(join(repositoryRoot, 'apps', 'cli', 'package.json'));
const cleanRoutePoints = Array.from({ length: 4 }, (_, index) => ({
  timestamp: `2033-06-04T09:1${index}:00Z`,
  lat: -48.8 + index * 0.0003,
  lon: -123.8 - index * 0.0003,
  elevation: 14.2 + index * 0.4,
  speed: 6.1 + index * 0.1,
  course: 101 + index * 2,
}));
const EXPECTED_USAGE = [
  'Usage:',
  '  velograph-import import <file|dir|zip>... [--data-dir <dir>]',
  '  velograph-import delete <workoutId> [--data-dir <dir>]',
  '  velograph-import delete-all --confirm-delete-all [--data-dir <dir>]',
  '  velograph-import backup <destPath> [--data-dir <dir>]',
  '  velograph-import restore <backupPath> --confirm-replace [--data-dir <dir>]',
  '  velograph-import repair <workoutId> [--data-dir <dir>]',
  '',
].join('\n');

const haeFiles = new Map([
  [
    'Outdoor Cycling-Heart Rate-20330604_091000.csv',
    [
      'Date/Time,Min (bpm),Max (bpm),Avg (bpm),Context,Source',
      '2033-06-04T09:10:00Z,137,146,142,workout,Synthetic Clean Install Device',
      '2033-06-04T09:11:00Z,140,150,145,workout,Synthetic Clean Install Device',
      '2033-06-04T09:12:00Z,143,153,148,workout,Synthetic Clean Install Device',
    ].join('\n'),
  ],
  [
    'Outdoor Cycling-Cycling Cadence-20330604_091000.csv',
    [
      'Date/Time,Cadence (rpm),Source',
      '2033-06-04T09:10:00Z,83,Synthetic Clean Install Device',
      '2033-06-04T09:11:00Z,87,Synthetic Clean Install Device',
      '2033-06-04T09:12:00Z,85,Synthetic Clean Install Device',
    ].join('\n'),
  ],
  [
    'Outdoor Cycling-Cycling Distance-20330604_091000.csv',
    [
      'Date/Time,Distance (km),Source',
      '2033-06-04T09:10:00Z,0.731,Synthetic Clean Install Device',
      '2033-06-04T09:11:00Z,0.764,Synthetic Clean Install Device',
      '2033-06-04T09:12:00Z,0.752,Synthetic Clean Install Device',
    ].join('\n'),
  ],
  [
    'Outdoor Cycling-Active Energy-20330604_091000.csv',
    [
      'Date/Time,Active Energy (kJ),Source',
      '2033-06-04T09:10:00Z,32.4,Synthetic Clean Install Device',
      '2033-06-04T09:11:00Z,34.8,Synthetic Clean Install Device',
      '2033-06-04T09:12:00Z,33.7,Synthetic Clean Install Device',
    ].join('\n'),
  ],
  [
    'Outdoor Cycling-Route-20330604_091000.csv',
    ['Timestamp,Latitude,Longitude,Altitude (m),Speed (m/s),Course (deg)']
      .concat(
        cleanRoutePoints.map(
          (point) =>
            `${point.timestamp},${point.lat.toFixed(6)},${point.lon.toFixed(6)},` +
            `${point.elevation.toFixed(1)},${point.speed.toFixed(1)},${point.course.toFixed(1)}`,
        ),
      )
      .join('\n'),
  ],
  [
    'Outdoor Cycling-Route-20330604_091000.gpx',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="velograph-synthetic-clean-install" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <trk><name>Synthetic clean install route</name><trkseg>',
      ...cleanRoutePoints.map(
        (point) =>
          `    <trkpt lat="${point.lat.toFixed(6)}" lon="${point.lon.toFixed(6)}">` +
          `<ele>${point.elevation.toFixed(1)}</ele><time>${point.timestamp}</time></trkpt>`,
      ),
      '  </trkseg></trk>',
      '</gpx>',
    ].join('\n'),
  ],
]);

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

function runPnpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === 'string' && /(?:^|[/\\])pnpm(?:\.c?js)?$/.test(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], cwd);
  }
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, cwd);
}

function assertValueFree(output, forbidden) {
  for (const value of forbidden) {
    if (value && output.includes(value)) {
      throw new Error('installed CLI output exposed forbidden synthetic/private token');
    }
  }
}

function assertExactCommandResult(
  result,
  { status = 0, stdout = '', stderr = '', message = 'installed CLI returned unexpected output' },
) {
  if (
    result.error ||
    result.status !== status ||
    result.stdout !== stdout ||
    result.stderr !== stderr
  ) {
    throw new Error(message);
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

function normalizedRideCounts(database) {
  const count = (table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    workouts: count('workouts'),
    sourceFiles: count('source_files'),
    workoutSourceFiles: count('workout_source_files'),
    metricSeries: count('metric_series'),
    metricSamples: count('metric_samples'),
    routes: count('routes'),
    routePoints: count('route_points'),
  };
}

function verifyCompleteRide(database) {
  const counts = normalizedRideCounts(database);
  if (
    counts.workouts !== 1 ||
    counts.sourceFiles !== 6 ||
    counts.workoutSourceFiles !== 6 ||
    counts.metricSeries !== 4 ||
    counts.metricSamples !== 12 ||
    counts.routes !== 1 ||
    counts.routePoints !== 4
  ) {
    throw new Error('clean-installed CLI did not create one complete normalized ride');
  }
  const series = database
    .prepare(
      `SELECT metric_type, unit, sample_count
       FROM metric_series ORDER BY metric_type`,
    )
    .all();
  if (
    JSON.stringify(series) !==
    JSON.stringify([
      { metric_type: 'cadence', unit: 'rpm', sample_count: 3 },
      { metric_type: 'distance', unit: 'm', sample_count: 3 },
      { metric_type: 'energy', unit: 'J', sample_count: 3 },
      { metric_type: 'heart_rate', unit: 'bpm', sample_count: 3 },
    ])
  ) {
    throw new Error('clean-installed CLI did not preserve every canonical metric series');
  }
  const route = database.prepare('SELECT source_format, point_count FROM routes ORDER BY id').get();
  if (route?.source_format !== 'gpx' || route.point_count !== 4) {
    throw new Error('clean-installed CLI did not preserve the preferred complete GPX route');
  }
  return counts;
}

function assertExactImportSummary(
  result,
  { imported, duplicates, skipped = 0, quarantined = 0, workouts, detailLines = [] },
) {
  const lines = [
    'Batch [1-9]\\d* committed',
    `  imported files:     ${imported}`,
    `  duplicates skipped: ${duplicates}`,
    `  out-of-scope skipped: ${skipped}`,
    `  quarantined:        ${quarantined}`,
    `  workouts created:   ${workouts}`,
    ...detailLines.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  ];
  const expectedOutput = new RegExp(`^${lines.join('\\n')}\\n$`);
  if (
    result.error ||
    result.status !== 0 ||
    result.stderr !== '' ||
    !expectedOutput.test(result.stdout)
  ) {
    throw new Error('clean-installed CLI returned an unexpected aggregate import summary');
  }
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
  await Promise.all([mkdir(packageDirectory), mkdir(installDirectory), mkdir(haeFolderDirectory)]);
  await Promise.all(
    [...haeFiles].map(([name, content]) => writeFile(join(haeFolderDirectory, name), content)),
  );
  const { zipSync } = workspaceRequire('fflate');
  await writeFile(
    haeZipPath,
    zipSync(
      Object.fromEntries(
        [...haeFiles].map(([name, content]) => [
          `Synthetic Health Auto Export/${name}`,
          Buffer.from(content),
        ]),
      ),
      { level: 9 },
    ),
  );

  runPnpm(
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
  assertExactImportSummary(imported, {
    imported: 1,
    duplicates: 0,
    workouts: 1,
  });
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

  const cleanInstallTokens = [
    sandbox,
    haeFolderDirectory,
    haeZipPath,
    ...haeFiles.keys(),
    '2033-06-04T09:10:00Z',
    'Synthetic Clean Install Device',
    cleanRoutePoints[0].lat.toFixed(6),
    cleanRoutePoints[0].lon.toFixed(6),
    '0.731',
    '32.4',
    '142',
  ];
  for (const [kind, sourcePath, cleanDataDirectory] of [
    ['folder', haeFolderDirectory, folderDataDirectory],
    ['ZIP', haeZipPath, zipDataDirectory],
  ]) {
    const firstCleanImport = runCli(['import', sourcePath, '--data-dir', cleanDataDirectory]);
    assertExactImportSummary(firstCleanImport, { imported: 6, duplicates: 0, workouts: 1 });
    assertValueFree(`${firstCleanImport.stdout}${firstCleanImport.stderr}`, cleanInstallTokens);

    let cleanDatabase = new DatabaseConstructor(join(cleanDataDirectory, 'velograph.sqlite3'), {
      readonly: true,
    });
    const beforeDuplicate = verifyCompleteRide(cleanDatabase);
    cleanDatabase.close();

    const duplicateCleanImport = runCli(['import', sourcePath, '--data-dir', cleanDataDirectory]);
    assertExactImportSummary(duplicateCleanImport, {
      imported: 0,
      duplicates: 6,
      workouts: 0,
    });
    assertValueFree(
      `${duplicateCleanImport.stdout}${duplicateCleanImport.stderr}`,
      cleanInstallTokens,
    );

    cleanDatabase = new DatabaseConstructor(join(cleanDataDirectory, 'velograph.sqlite3'), {
      readonly: true,
    });
    const afterDuplicate = verifyCompleteRide(cleanDatabase);
    cleanDatabase.close();
    if (JSON.stringify(beforeDuplicate) !== JSON.stringify(afterDuplicate)) {
      throw new Error(`clean-installed CLI ${kind} re-import was not idempotent`);
    }
  }

  const quarantined = runCli(['import', quarantinePath, '--data-dir', dataDirectory]);
  assertExactImportSummary(quarantined, {
    imported: 0,
    duplicates: 0,
    quarantined: 1,
    workouts: 0,
    detailLines: ['  quarantined [unrecognized_headers]: 1'],
  });
  assertValueFree(`${quarantined.stdout}${quarantined.stderr}`, [
    sandbox,
    quarantinePath,
    '20390101',
    '010101',
  ]);

  const oversized = runCli(['import', oversizedPath, '--data-dir', dataDirectory]);
  if (
    oversized.error ||
    oversized.status !== 1 ||
    oversized.stdout !== '' ||
    oversized.stderr !== 'Import failed: import_failed\n'
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
  assertExactCommandResult(repaired, {
    stdout: `Repaired workout ${workoutId} (formula analytics-v2)\n`,
    message: 'installed CLI did not repair the synthetic workout',
  });
  assertValueFree(`${repaired.stdout}${repaired.stderr}`, privateTokens);

  const backedUp = runCli(['backup', backupPath, '--data-dir', dataDirectory]);
  if (
    backedUp.error ||
    backedUp.status !== 0 ||
    backedUp.stderr !== '' ||
    !/^Backup written \([1-9]\d* page\(s\), format 1, schema 0004_backup_manifest\.sql\)\n$/.test(
      backedUp.stdout,
    )
  ) {
    throw new Error('installed CLI did not create the synthetic backup');
  }
  assertValueFree(`${backedUp.stdout}${backedUp.stderr}`, [...privateTokens, backupPath]);

  const deleted = runCli(['delete', String(workoutId), '--data-dir', dataDirectory]);
  assertExactCommandResult(deleted, {
    stdout: `Deleted workout ${workoutId} (removed 1 exclusive source file record(s))\n`,
    message: 'installed CLI did not delete the synthetic workout',
  });
  database = inspectDatabase();
  if (database.prepare('SELECT count(*) AS count FROM workouts').get().count !== 0) {
    throw new Error('installed CLI delete did not remove the synthetic workout');
  }
  database.close();

  const unconfirmed = runCli(['restore', backupPath, '--data-dir', dataDirectory]);
  assertExactCommandResult(unconfirmed, {
    status: 2,
    stderr: 'Restore requires --confirm-replace\n',
    message: 'installed CLI restored without explicit confirmation',
  });
  const restored = runCli([
    'restore',
    backupPath,
    '--confirm-replace',
    '--data-dir',
    dataDirectory,
  ]);
  assertExactCommandResult(restored, {
    stdout: 'Database restored; manifest and checksums verified (0004_backup_manifest.sql)\n',
    message: 'installed CLI did not restore the confirmed synthetic backup',
  });
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
    assertExactCommandResult(invalid, {
      status: 2,
      stdout: EXPECTED_USAGE,
      message: 'installed CLI accepted an invalid data-dir option',
    });
    assertValueFree(`${invalid.stdout}${invalid.stderr}`, [
      sandbox,
      fixturePath,
      fallbackDirectory,
    ]);
  }
  if (existsSync(fallbackDirectory)) {
    throw new Error('installed CLI resolved the default data directory after invalid arguments');
  }

  const unconfirmedDeleteAll = runCli(['delete-all', '--data-dir', dataDirectory]);
  assertExactCommandResult(unconfirmedDeleteAll, {
    status: 2,
    stderr: 'Delete-all requires --confirm-delete-all\n',
    message: 'installed CLI deleted all data without explicit confirmation',
  });
  database = inspectDatabase();
  if (database.prepare('SELECT count(*) AS count FROM workouts').get().count !== 1) {
    database.close();
    throw new Error('installed CLI unconfirmed delete-all mutated workouts');
  }
  database.close();

  const confirmedDeleteAll = runCli([
    'delete-all',
    '--confirm-delete-all',
    '--data-dir',
    dataDirectory,
  ]);
  assertExactCommandResult(confirmedDeleteAll, {
    stdout: 'Deleted all local data\n',
    message: 'installed CLI did not delete all local data',
  });
  database = inspectDatabase();
  for (const table of ['workouts', 'source_files', 'import_batches', 'user_settings']) {
    if (database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count !== 0) {
      database.close();
      throw new Error('installed CLI delete-all left application rows');
    }
  }
  database.close();

  const runtimePath = join(installedPackageDirectory, 'dist', 'cli-runtime.mjs');
  await rename(runtimePath, `${runtimePath}.missing`);
  const failed = runCli(['import', fixturePath, '--data-dir', dataDirectory]);
  if (
    failed.error ||
    failed.status !== 1 ||
    failed.stdout !== '' ||
    failed.stderr !== 'Command failed: unexpected_error\n'
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
