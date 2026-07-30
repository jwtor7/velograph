import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_SCHEMA_VERSION,
  BenchmarkFailure,
  BROWSER_RIDE_OPEN_LIMIT_MS,
  BROWSER_RIDE_MEASURED_RUNS,
  CI_BROWSER_RIDE_OPEN_LIMIT_MS,
  COMBINED_SAMPLE_COUNT,
  GENERATED_FILE_COUNT,
  MAX_SUMMARY_BYTES,
  METRIC_SAMPLE_COUNT,
  ROUTE_POINT_COUNT,
  WORKOUT_COUNT,
  benchmarkPlan,
  classifyBenchmarkError,
  finishBenchmarkCleanup,
  formatBenchmarkSummary,
  percentile,
  resolveBenchmarkProfile,
  resolveChromeExecutable,
  renderBenchmarkWorkout,
  selectRepresentativeWorkoutIds,
} from './performance-benchmark.mjs';
import { runOfflineMapBrowserSmoke } from './offline-map-browser-smoke.mjs';
import { scanFile } from './privacy-scan.mjs';

describe('performance benchmark contract', () => {
  it('defines the exact PRD §14 corpus', () => {
    expect(benchmarkPlan()).toEqual({
      workouts: 100,
      generatedFiles: 500,
      metricSamples: 800_000,
      routePoints: 200_000,
      combinedSamples: 1_000_000,
    });
    expect(WORKOUT_COUNT).toBe(100);
    expect(GENERATED_FILE_COUNT).toBe(500);
    expect(METRIC_SAMPLE_COUNT).toBe(800_000);
    expect(ROUTE_POINT_COUNT).toBe(200_000);
    expect(COMBINED_SAMPLE_COUNT).toBe(1_000_000);
  });

  it('renders deterministic HAE-shaped metric and route files', () => {
    const first = renderBenchmarkWorkout(7, {
      metricSamplesPerSeries: 3,
      routePointsPerWorkout: 4,
    });
    const second = renderBenchmarkWorkout(7, {
      metricSamplesPerSeries: 3,
      routePointsPerWorkout: 4,
    });

    expect([...first.keys()]).toEqual([...second.keys()]);
    expect(first.size).toBe(5);
    for (const [name, content] of first) {
      expect(content).toBe(second.get(name));
      expect(name).toMatch(/^Outdoor Cycling-.+-\d{8}_\d{6}\.(csv|gpx)$/);
      expect(scanFile(`fixtures/synthetic/benchmark/${name}`, Buffer.from(content))).toEqual([]);
    }
    expect([...first.keys()].filter((name) => name.endsWith('.csv'))).toHaveLength(4);
    expect([...first.keys()].filter((name) => name.endsWith('.gpx'))).toHaveLength(1);
  });

  it('uses nearest-rank p95 and does not mutate the input', () => {
    const timings = [5, 1, 3, 2, 4, 10, 8, 9, 7, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    expect(percentile(timings, 0.95)).toBe(19);
    expect(timings).toEqual([
      5, 1, 3, 2, 4, 10, 8, 9, 7, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it('selects five deterministic rides spanning the imported corpus', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    expect(selectRepresentativeWorkoutIds(rows)).toEqual([1, 26, 51, 75, 100]);
    expect(BROWSER_RIDE_MEASURED_RUNS).toBe(5);
  });

  it('resolves an explicit or platform Chrome executable and fails closed when absent', () => {
    expect(
      resolveChromeExecutable(
        { VELO_BROWSER_SMOKE_CHROME: 'synthetic-chrome' },
        'linux',
        () => false,
      ),
    ).toBe('synthetic-chrome');
    expect(
      resolveChromeExecutable({}, 'linux', (candidate) => candidate === '/usr/bin/chromium'),
    ).toBe('/usr/bin/chromium');
    expect(() => resolveChromeExecutable({}, 'win32', () => false)).toThrow(
      new BenchmarkFailure('chrome_executable_missing'),
    );
  });

  it('keeps the release threshold strict and gives variable CI hardware a bounded regression profile', () => {
    expect(resolveBenchmarkProfile()).toEqual({
      id: 'release-reference',
      browserRideOpenLimitMs: BROWSER_RIDE_OPEN_LIMIT_MS,
    });
    expect(resolveBenchmarkProfile(['--ci-regression'])).toEqual({
      id: 'ci-regression',
      browserRideOpenLimitMs: CI_BROWSER_RIDE_OPEN_LIMIT_MS,
    });
    expect(() => resolveBenchmarkProfile(['--unknown'])).toThrow(
      new BenchmarkFailure('invalid_benchmark_profile'),
    );
  });

  it('preserves privacy-safe browser startup errors across the benchmark boundary', async () => {
    let capturedError;
    try {
      await runOfflineMapBrowserSmoke({
        chromeExecutable: 'synthetic-chrome',
        baseUrl: 'https://example.invalid',
        rideId: 1,
      });
    } catch (error) {
      capturedError = error;
    }

    expect(classifyBenchmarkError(capturedError)).toBe('browser_smoke_invalid_loopback_url');

    let startupError;
    try {
      await runOfflineMapBrowserSmoke({
        chromeExecutable: join(tmpdir(), 'velograph-synthetic-missing-chrome'),
        baseUrl: 'http://127.0.0.1:49156',
        rideId: 1,
        timeoutMs: 5_000,
      });
    } catch (error) {
      startupError = error;
    }
    expect(classifyBenchmarkError(startupError)).toBe('browser_smoke_chromium_launch_failed');

    expect(classifyBenchmarkError(new BenchmarkFailure('synthetic_benchmark_failure'))).toBe(
      'synthetic_benchmark_failure',
    );
    expect(classifyBenchmarkError(new Error('Invented unsafe diagnostic'))).toBe(
      'unexpected_error',
    );
  });

  it('preserves primary benchmark failures through cleanup and safely classifies cleanup-only errors', async () => {
    const primaryError = new BenchmarkFailure('synthetic_primary_failure');
    await expect(
      finishBenchmarkCleanup(primaryError, [
        async () => {
          throw new Error('Invented cleanup failure');
        },
      ]),
    ).rejects.toBe(primaryError);

    let cleanupError;
    try {
      await finishBenchmarkCleanup(null, [
        async () => {
          throw new Error('Invented cleanup failure');
        },
      ]);
    } catch (error) {
      cleanupError = error;
    }
    expect(classifyBenchmarkError(cleanupError)).toBe('benchmark_cleanup_failed');
  });

  it('emits one bounded stable aggregate record', () => {
    const line = formatBenchmarkSummary({
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      profile: 'release-reference',
      corpus: benchmarkPlan(),
      import: { durationMs: 1234.567, limitMs: 180000, passed: true },
      browserRideOpen: {
        p95Ms: 456.789,
        limitMs: 1000,
        measuredRuns: 5,
        coldAnalyticsSnapshotsCreated: 1,
        passed: true,
      },
      rideDetailApi: {
        p95Ms: 12.345,
        limitMs: 1000,
        measuredRuns: 40,
        warmupRuns: 5,
        passed: true,
      },
      passed: true,
    });

    expect(line).toBe(
      'performance-benchmark {"schemaVersion":3,"profile":"release-reference","corpus":{"workouts":100,"generatedFiles":500,"metricSamples":800000,"routePoints":200000,"combinedSamples":1000000},"import":{"durationMs":1234.567,"limitMs":180000,"passed":true},"browserRideOpen":{"p95Ms":456.789,"limitMs":1000,"measuredRuns":5,"coldAnalyticsSnapshotsCreated":1,"passed":true},"rideDetailApi":{"p95Ms":12.345,"limitMs":1000,"measuredRuns":40,"warmupRuns":5,"passed":true},"passed":true}',
    );
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(line).not.toMatch(/\/(?:Users|home|tmp|private)\//);
  });
});
