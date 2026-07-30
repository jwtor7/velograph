#!/usr/bin/env node
/**
 * Deterministic, synthetic-only release benchmark for PRD §14.
 *
 * The benchmark imports 100 Health Auto Export-shaped workouts through the
 * production CLI, then measures production-browser ride opens and the
 * production ride-detail HTTP response after warm-up. It prints one bounded
 * aggregate JSON record and never prints source filenames, sample values,
 * coordinates, or temporary paths.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runOfflineMapBrowserSmoke } from './offline-map-browser-smoke.mjs';

export const BENCHMARK_SCHEMA_VERSION = 3;
export const WORKOUT_COUNT = 100;
export const METRIC_SERIES_PER_WORKOUT = 4;
export const METRIC_SAMPLES_PER_SERIES = 2_000;
export const ROUTE_POINTS_PER_WORKOUT = 2_000;
export const METRIC_SAMPLE_COUNT =
  WORKOUT_COUNT * METRIC_SERIES_PER_WORKOUT * METRIC_SAMPLES_PER_SERIES;
export const ROUTE_POINT_COUNT = WORKOUT_COUNT * ROUTE_POINTS_PER_WORKOUT;
export const COMBINED_SAMPLE_COUNT = METRIC_SAMPLE_COUNT + ROUTE_POINT_COUNT;
export const GENERATED_FILE_COUNT = WORKOUT_COUNT * (METRIC_SERIES_PER_WORKOUT + 1);
export const IMPORT_LIMIT_MS = 180_000;
export const BROWSER_RIDE_OPEN_LIMIT_MS = 1_000;
export const CI_BROWSER_RIDE_OPEN_LIMIT_MS = 3_000;
export const BROWSER_RIDE_MEASURED_RUNS = 5;
export const RIDE_DETAIL_LIMIT_MS = 1_000;
export const RIDE_DETAIL_WARMUP_RUNS = 5;
export const RIDE_DETAIL_MEASURED_RUNS = 40;
export const MAX_SUMMARY_BYTES = 2_048;

const SYNTHETIC_SOURCE = 'Synthetic Benchmark Device';
const BASE_START_UTC = Date.UTC(2037, 0, 1, 8, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1_000;
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export class BenchmarkFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'BenchmarkFailure';
    this.code = code;
  }
}

export function resolveBenchmarkProfile(args = []) {
  if (args.length === 0) {
    return { id: 'release-reference', browserRideOpenLimitMs: BROWSER_RIDE_OPEN_LIMIT_MS };
  }
  if (args.length === 1 && args[0] === '--ci-regression') {
    return { id: 'ci-regression', browserRideOpenLimitMs: CI_BROWSER_RIDE_OPEN_LIMIT_MS };
  }
  throw new BenchmarkFailure('invalid_benchmark_profile');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function stampFor(utcMs) {
  const date = new Date(utcMs);
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function isoUtc(utcMs) {
  return new Date(utcMs).toISOString().replace('.000Z', 'Z');
}

/**
 * Render one deterministic HAE-shaped workout. All route coordinates remain
 * inside the repository's invented Point Nemo fixture box.
 */
export function renderBenchmarkWorkout(
  workoutIndex,
  {
    metricSamplesPerSeries = METRIC_SAMPLES_PER_SERIES,
    routePointsPerWorkout = ROUTE_POINTS_PER_WORKOUT,
  } = {},
) {
  if (!Number.isInteger(workoutIndex) || workoutIndex < 0) {
    throw new BenchmarkFailure('invalid_workout_index');
  }
  if (
    !Number.isInteger(metricSamplesPerSeries) ||
    metricSamplesPerSeries < 1 ||
    !Number.isInteger(routePointsPerWorkout) ||
    routePointsPerWorkout < 1
  ) {
    throw new BenchmarkFailure('invalid_sample_plan');
  }

  const startUtc = BASE_START_UTC + workoutIndex * DAY_MS;
  const stamp = stampFor(startUtc);
  const heartRate = ['Date/Time,Min (bpm),Max (bpm),Avg (bpm),Context,Source'];
  const cadence = ['Date/Time,Cadence (rpm),Source'];
  const distance = ['Date/Time,Distance (km),Source'];
  const energy = ['Date/Time,Active Energy (kJ),Source'];

  for (let sampleIndex = 0; sampleIndex < metricSamplesPerSeries; sampleIndex++) {
    const timestamp = isoUtc(startUtc + sampleIndex * 1_000);
    const heartRateValue = 108 + ((workoutIndex + sampleIndex) % 54);
    const cadenceValue = 68 + ((workoutIndex * 3 + sampleIndex) % 34);
    const distanceValue = (0.004 + ((workoutIndex + sampleIndex) % 5) * 0.001).toFixed(3);
    const energyValue = (1.4 + ((workoutIndex + sampleIndex) % 7) * 0.1).toFixed(1);
    heartRate.push(
      `${timestamp},${heartRateValue - 3},${heartRateValue + 4},${heartRateValue},workout,${SYNTHETIC_SOURCE}`,
    );
    cadence.push(`${timestamp},${cadenceValue},${SYNTHETIC_SOURCE}`);
    distance.push(`${timestamp},${distanceValue},${SYNTHETIC_SOURCE}`);
    energy.push(`${timestamp},${energyValue},${SYNTHETIC_SOURCE}`);
  }

  const route = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="velograph-synthetic-benchmark" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk><name>Synthetic benchmark route</name><trkseg>',
  ];
  for (let pointIndex = 0; pointIndex < routePointsPerWorkout; pointIndex++) {
    const offset = pointIndex % 500;
    const lat = -49.5 + workoutIndex * 0.004 + offset * 0.000001;
    const lon = -124.5 + workoutIndex * 0.004 - offset * 0.000001;
    const elevation = 12 + ((workoutIndex + pointIndex) % 31) * 0.2;
    route.push(
      `    <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${elevation.toFixed(1)}</ele><time>${isoUtc(startUtc + pointIndex * 1_000)}</time></trkpt>`,
    );
  }
  route.push('  </trkseg></trk>', '</gpx>');

  return new Map([
    [`Outdoor Cycling-Heart Rate-${stamp}.csv`, `${heartRate.join('\n')}\n`],
    [`Outdoor Cycling-Cycling Cadence-${stamp}.csv`, `${cadence.join('\n')}\n`],
    [`Outdoor Cycling-Cycling Distance-${stamp}.csv`, `${distance.join('\n')}\n`],
    [`Outdoor Cycling-Active Energy-${stamp}.csv`, `${energy.join('\n')}\n`],
    [`Outdoor Cycling-Route-${stamp}.gpx`, `${route.join('\n')}\n`],
  ]);
}

export function benchmarkPlan() {
  return {
    workouts: WORKOUT_COUNT,
    generatedFiles: GENERATED_FILE_COUNT,
    metricSamples: METRIC_SAMPLE_COUNT,
    routePoints: ROUTE_POINT_COUNT,
    combinedSamples: COMBINED_SAMPLE_COUNT,
  };
}

export function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new BenchmarkFailure('empty_percentile_input');
  }
  if (!(percentileValue > 0 && percentileValue <= 1)) {
    throw new BenchmarkFailure('invalid_percentile');
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * percentileValue) - 1];
}

export function resolveChromeExecutable(
  environment = process.env,
  platform = process.platform,
  exists = existsSync,
) {
  const configured = environment.VELO_BROWSER_SMOKE_CHROME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();

  const candidates =
    platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : platform === 'linux'
        ? [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ]
        : [];
  const detected = candidates.find((candidate) => exists(candidate));
  if (!detected) throw new BenchmarkFailure('chrome_executable_missing');
  return detected;
}

export function selectRepresentativeWorkoutIds(rows, runs = BROWSER_RIDE_MEASURED_RUNS) {
  if (
    !Array.isArray(rows) ||
    !Number.isSafeInteger(runs) ||
    runs < 1 ||
    rows.length < runs ||
    rows.some((row) => !Number.isSafeInteger(row?.id))
  ) {
    throw new BenchmarkFailure('representative_workouts_missing');
  }
  const ids = rows.map((row) => row.id);
  return Array.from({ length: runs }, (_, index) => {
    const position = runs === 1 ? 0 : Math.round((index * (ids.length - 1)) / (runs - 1));
    return ids[position];
  });
}

export function formatBenchmarkSummary(summary) {
  const line = `performance-benchmark ${JSON.stringify(summary)}`;
  if (Buffer.byteLength(line, 'utf8') > MAX_SUMMARY_BYTES) {
    throw new BenchmarkFailure('summary_too_large');
  }
  return line;
}

async function writeCorpus(corpusDirectory) {
  await mkdir(corpusDirectory, { recursive: true });
  for (let workoutIndex = 0; workoutIndex < WORKOUT_COUNT; workoutIndex++) {
    const files = renderBenchmarkWorkout(workoutIndex);
    await Promise.all(
      [...files].map(([name, content]) => writeFile(join(corpusDirectory, name), content)),
    );
  }
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function verifyDatabaseCounts(database) {
  const counts = {
    workouts: count(database, 'workouts'),
    metricSeries: count(database, 'metric_series'),
    metricSamples: count(database, 'metric_samples'),
    routes: count(database, 'routes'),
    routePoints: count(database, 'route_points'),
  };
  const expected = {
    workouts: WORKOUT_COUNT,
    metricSeries: WORKOUT_COUNT * METRIC_SERIES_PER_WORKOUT,
    metricSamples: METRIC_SAMPLE_COUNT,
    routes: WORKOUT_COUNT,
    routePoints: ROUTE_POINT_COUNT,
  };
  if (Object.keys(expected).some((key) => counts[key] !== expected[key])) {
    throw new BenchmarkFailure('corpus_count_mismatch');
  }
  return counts;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new BenchmarkFailure('listen_address_unavailable'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function measureBrowserRideOpen(createApiServer, database, workoutIds, chromeExecutable) {
  const snapshotsBefore = count(database, 'analytics_snapshots');
  if (snapshotsBefore !== 0)
    throw new BenchmarkFailure('browser_cold_snapshot_precondition_failed');

  const server = createApiServer({
    db: database,
    now: () => Date.UTC(2038, 0, 1),
    staticDir: join(repositoryRoot, 'apps', 'api', 'dist', 'web'),
  });
  try {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const timings = [];
    let coldAnalyticsSnapshotsCreated = 0;

    for (let index = 0; index < workoutIds.length; index++) {
      const result = await runOfflineMapBrowserSmoke({
        chromeExecutable,
        baseUrl,
        rideId: workoutIds[index],
        timeoutMs: 30_000,
        requireLocalBasemap: false,
      });
      if (
        !result.passed ||
        !Number.isFinite(result.settledRenderMs) ||
        result.settledRenderMs <= 0
      ) {
        throw new BenchmarkFailure('browser_ride_open_failed');
      }
      timings.push(result.settledRenderMs);
      if (index === 0) {
        coldAnalyticsSnapshotsCreated = count(database, 'analytics_snapshots');
        if (coldAnalyticsSnapshotsCreated < 1) {
          throw new BenchmarkFailure('browser_cold_analytics_missing');
        }
      }
    }

    const placeholders = workoutIds.map(() => '?').join(', ');
    const selectedSnapshotCount = database
      .prepare(
        `SELECT COUNT(DISTINCT workout_id) AS count
         FROM analytics_snapshots
         WHERE workout_id IN (${placeholders})`,
      )
      .get(...workoutIds).count;
    if (selectedSnapshotCount !== workoutIds.length) {
      throw new BenchmarkFailure('browser_selected_analytics_missing');
    }
    return {
      p95Ms: percentile(timings, 0.95),
      measuredRuns: timings.length,
      coldAnalyticsSnapshotsCreated,
    };
  } finally {
    if (server.listening) await closeServer(server);
  }
}

async function measureRideDetailApi(createApiServer, database, workoutId) {
  const server = createApiServer({
    db: database,
    now: () => Date.UTC(2038, 0, 1),
  });
  try {
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/api/workouts/${workoutId}`;
    let verifiedShape = false;

    const requestDetail = async () => {
      const started = performance.now();
      const response = await fetch(url);
      if (response.status !== 200) throw new BenchmarkFailure('ride_detail_failed');
      const body = await response.json();
      const elapsed = performance.now() - started;
      if (!verifiedShape) {
        const metricCount = Object.values(body.metrics ?? {}).reduce(
          (sum, samples) => sum + (Array.isArray(samples) ? samples.length : 0),
          0,
        );
        const routeCount = Array.isArray(body.route)
          ? body.route.reduce(
              (sum, segment) => sum + (Array.isArray(segment?.points) ? segment.points.length : 0),
              0,
            )
          : 0;
        if (
          metricCount !== METRIC_SERIES_PER_WORKOUT * METRIC_SAMPLES_PER_SERIES ||
          routeCount !== ROUTE_POINTS_PER_WORKOUT ||
          body.workout?.id !== workoutId
        ) {
          throw new BenchmarkFailure('ride_detail_shape_mismatch');
        }
        verifiedShape = true;
      }
      return elapsed;
    };

    for (let index = 0; index < RIDE_DETAIL_WARMUP_RUNS; index++) {
      await requestDetail();
    }
    const timings = [];
    for (let index = 0; index < RIDE_DETAIL_MEASURED_RUNS; index++) {
      timings.push(await requestDetail());
    }
    return {
      p95Ms: percentile(timings, 0.95),
      measuredRuns: timings.length,
      warmupRuns: RIDE_DETAIL_WARMUP_RUNS,
    };
  } finally {
    if (server.listening) await closeServer(server);
  }
}

export async function runBenchmark({ profile = resolveBenchmarkProfile() } = {}) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== 22) throw new BenchmarkFailure('node_22_required');
  if (
    !profile ||
    (profile.id !== 'release-reference' && profile.id !== 'ci-regression') ||
    !Number.isSafeInteger(profile.browserRideOpenLimitMs) ||
    profile.browserRideOpenLimitMs < BROWSER_RIDE_OPEN_LIMIT_MS ||
    profile.browserRideOpenLimitMs > CI_BROWSER_RIDE_OPEN_LIMIT_MS
  ) {
    throw new BenchmarkFailure('invalid_benchmark_profile');
  }
  const chromeExecutable = resolveChromeExecutable();

  const sandbox = await mkdtemp(join(tmpdir(), 'velograph-performance-'));
  const corpusDirectory = join(sandbox, 'synthetic-corpus');
  const dataDirectory = join(sandbox, 'synthetic-data');
  const cliLauncher = join(repositoryRoot, 'apps', 'cli', 'dist', 'velograph-import.mjs');
  const apiRuntime = join(repositoryRoot, 'apps', 'api', 'dist', 'api-runtime.mjs');
  let database;
  try {
    await writeCorpus(corpusDirectory);

    const importStarted = performance.now();
    const imported = spawnSync(
      process.execPath,
      [cliLauncher, 'import', corpusDirectory, '--data-dir', dataDirectory],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', VELO_DATA_DIR: '' },
        maxBuffer: 64 * 1024,
        timeout: IMPORT_LIMIT_MS + 5_000,
      },
    );
    const importMs = performance.now() - importStarted;
    if (imported.error || imported.status !== 0) {
      throw new BenchmarkFailure('import_process_failed');
    }
    if (
      !/imported files:\s+500/.test(imported.stdout) ||
      !/workouts created:\s+100/.test(imported.stdout) ||
      !/quarantined:\s+0/.test(imported.stdout)
    ) {
      throw new BenchmarkFailure('import_summary_mismatch');
    }

    const requireFromCli = createRequire(join(repositoryRoot, 'apps', 'cli', 'package.json'));
    const DatabaseConstructor = requireFromCli('better-sqlite3');
    database = new DatabaseConstructor(join(dataDirectory, 'velograph.sqlite3'));
    const counts = verifyDatabaseCounts(database);
    const workoutRows = database.prepare('SELECT id FROM workouts ORDER BY start_utc, id').all();
    const representativeWorkoutIds = selectRepresentativeWorkoutIds(workoutRows);

    const { createApiServer } = await import(`${pathToFileURL(apiRuntime).href}?benchmark=1`);
    const browserRideOpen = await measureBrowserRideOpen(
      createApiServer,
      database,
      representativeWorkoutIds,
      chromeExecutable,
    );
    const rideDetailApi = await measureRideDetailApi(
      createApiServer,
      database,
      representativeWorkoutIds[Math.floor(representativeWorkoutIds.length / 2)],
    );
    const importPassed = importMs < IMPORT_LIMIT_MS;
    const browserRideOpenPassed = browserRideOpen.p95Ms < profile.browserRideOpenLimitMs;
    const rideDetailApiPassed = rideDetailApi.p95Ms < RIDE_DETAIL_LIMIT_MS;
    const summary = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      profile: profile.id,
      runtime: {
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      corpus: benchmarkPlan(),
      database: counts,
      import: {
        durationMs: Number(importMs.toFixed(3)),
        limitMs: IMPORT_LIMIT_MS,
        passed: importPassed,
      },
      browserRideOpen: {
        p95Ms: Number(browserRideOpen.p95Ms.toFixed(3)),
        limitMs: profile.browserRideOpenLimitMs,
        measuredRuns: browserRideOpen.measuredRuns,
        coldAnalyticsSnapshotsCreated: browserRideOpen.coldAnalyticsSnapshotsCreated,
        passed: browserRideOpenPassed,
      },
      rideDetailApi: {
        p95Ms: Number(rideDetailApi.p95Ms.toFixed(3)),
        limitMs: RIDE_DETAIL_LIMIT_MS,
        measuredRuns: rideDetailApi.measuredRuns,
        warmupRuns: rideDetailApi.warmupRuns,
        passed: rideDetailApiPassed,
      },
      passed: importPassed && browserRideOpenPassed && rideDetailApiPassed,
    };
    const output = formatBenchmarkSummary(summary);
    if (output.includes(sandbox) || output.includes(SYNTHETIC_SOURCE)) {
      throw new BenchmarkFailure('summary_contains_source_detail');
    }
    return { output, passed: summary.passed, summary };
  } finally {
    if (database?.open) database.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await runBenchmark({
      profile: resolveBenchmarkProfile(process.argv.slice(2)),
    });
    console.log(result.output);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    const code = error instanceof BenchmarkFailure ? error.code : 'unexpected_error';
    console.error(`performance-benchmark: ${code}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
