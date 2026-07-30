import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  canvasTraceHasPolyline,
  cursorSnapshotIsSynchronized,
  devToolsEndpointFromActivePort,
  devToolsEndpointFromOutput,
  safeSmokeErrorCode,
  summarizeBrowserErrors,
  summarizeRequestOrigins,
  waitForDevToolsEndpoint,
} from './offline-map-browser-smoke.mjs';

const synchronizedCursorObservation = Object.freeze({
  minimum: 1_000,
  maximum: 5_000,
  value: 2_000,
  cursorX1: 140,
  cursorX2: 140,
  viewBoxX: 0,
  viewBoxWidth: 560,
});

function syntheticChromiumChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

describe('offline map browser Chromium startup', () => {
  it('accepts only loopback browser-debug endpoints from output and active-port files', () => {
    const endpoint = 'ws://127.0.0.1:49152/devtools/browser/synthetic-browser-id';
    expect(devToolsEndpointFromOutput(`DevTools listening on ${endpoint}\n`)).toBe(endpoint);
    expect(devToolsEndpointFromActivePort('49152\n/devtools/browser/synthetic-browser-id\n')).toBe(
      endpoint,
    );
    expect(
      devToolsEndpointFromOutput(
        'DevTools listening on ws://example.invalid:49152/devtools/browser/synthetic-browser-id',
      ),
    ).toBeNull();
    expect(
      devToolsEndpointFromActivePort('0\n/devtools/browser/synthetic-browser-id\n'),
    ).toBeNull();
  });

  it('discovers Chromium endpoints from stdout and stderr', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velograph-chromium-startup-test-'));
    try {
      for (const streamName of ['stdout', 'stderr']) {
        const child = syntheticChromiumChild();
        const endpoint = `ws://127.0.0.1:4915${streamName === 'stdout' ? '2' : '3'}/devtools/browser/synthetic-${streamName}`;
        const pending = waitForDevToolsEndpoint(child, 1_000, directory);
        child[streamName].write(`DevTools listening on ${endpoint}\n`);
        await expect(pending).resolves.toBe(endpoint);
        child.stdout.destroy();
        child.stderr.destroy();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('discovers Chromium through its validated DevToolsActivePort file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velograph-active-port-test-'));
    const child = syntheticChromiumChild();
    try {
      await writeFile(
        join(directory, 'DevToolsActivePort'),
        '49154\n/devtools/browser/synthetic-active-port\n',
      );
      await expect(waitForDevToolsEndpoint(child, 1_000, directory)).resolves.toBe(
        'ws://127.0.0.1:49154/devtools/browser/synthetic-active-port',
      );
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains an endpoint emitted during the final polling interval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velograph-endpoint-boundary-test-'));
    const child = syntheticChromiumChild();
    const endpoint = 'ws://127.0.0.1:49155/devtools/browser/synthetic-boundary';
    try {
      const pending = waitForDevToolsEndpoint(child, 20, directory);
      setTimeout(() => child.stdout.write(`DevTools listening on ${endpoint}\n`), 10);
      await expect(pending).resolves.toBe(endpoint);
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('maps persistent active-port read failures to a value-free error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'velograph-active-port-error-test-'));
    const child = syntheticChromiumChild();
    const nonDirectory = join(directory, 'not-a-directory');
    let capturedError;
    try {
      await writeFile(nonDirectory, 'synthetic');
      try {
        await waitForDevToolsEndpoint(child, 1_000, nonDirectory);
      } catch (error) {
        capturedError = error;
      }
      expect(safeSmokeErrorCode(capturedError)).toBe('chromium_active_port_unreadable');
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('offline map browser smoke geometry and cursor contracts', () => {
  it('requires draw-time evidence of a polyline segment, not marker arcs alone', () => {
    expect(
      canvasTraceHasPolyline({
        polylineStrokeCount: 0,
        maxPolylineSegmentCount: 0,
        cursorStrokeCount: 4,
      }),
    ).toBe(false);
    expect(
      canvasTraceHasPolyline({
        polylineStrokeCount: 1,
        maxPolylineSegmentCount: 9,
        cursorStrokeCount: 0,
      }),
    ).toBe(true);
  });

  it('accepts exactly three sliders whose values and vertical cursor lines agree', () => {
    expect(
      cursorSnapshotIsSynchronized([
        { ...synchronizedCursorObservation },
        { ...synchronizedCursorObservation },
        { ...synchronizedCursorObservation },
      ]),
    ).toBe(true);
  });

  it('rejects missing sliders, stale values, and non-vertical cursor lines', () => {
    expect(
      cursorSnapshotIsSynchronized([
        { ...synchronizedCursorObservation },
        { ...synchronizedCursorObservation },
      ]),
    ).toBe(false);
    expect(
      cursorSnapshotIsSynchronized([
        { ...synchronizedCursorObservation },
        { ...synchronizedCursorObservation },
        { ...synchronizedCursorObservation, value: 3_000, cursorX1: 280, cursorX2: 280 },
      ]),
    ).toBe(false);
    expect(
      cursorSnapshotIsSynchronized([
        { ...synchronizedCursorObservation },
        { ...synchronizedCursorObservation },
        { ...synchronizedCursorObservation, cursorX2: 141 },
      ]),
    ).toBe(false);
  });
});

describe('offline map browser smoke request summarization', () => {
  it('accepts only loopback HTTP requests and identifies local basemap tiles', () => {
    const summary = summarizeRequestOrigins([
      'http://127.0.0.1:4321/',
      'https://rider.localhost/assets/invented.js',
      'http://[::1]:9876/api/basemap/tiles/4/8/9',
      'http://127.42.7.9:7654/api/invented',
    ]);

    expect(summary).toEqual({
      requestCount: 4,
      loopbackRequestCount: 4,
      nonLoopbackRequestCount: 0,
      invalidRequestCount: 0,
      unsupportedSchemeRequestCount: 0,
      localBasemapTileRequestCount: 1,
      allRequestsLoopback: true,
    });
  });

  it('fails closed without retaining invented external or malformed input', () => {
    const inventedExternal = 'https://example.invalid/private/invented-value?secret=synthetic';
    const inventedMalformed = 'invented-not-a-url';
    const inventedUnsupported = 'data:text/plain,invented-private-value';
    const summary = summarizeRequestOrigins([
      'http://localhost:4567/invented',
      inventedExternal,
      inventedMalformed,
      inventedUnsupported,
    ]);

    expect(summary).toEqual({
      requestCount: 4,
      loopbackRequestCount: 1,
      nonLoopbackRequestCount: 1,
      invalidRequestCount: 1,
      unsupportedSchemeRequestCount: 1,
      localBasemapTileRequestCount: 0,
      allRequestsLoopback: false,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(inventedExternal);
    expect(serialized).not.toContain(inventedMalformed);
    expect(serialized).not.toContain(inventedUnsupported);
  });
});

describe('offline map browser smoke error summarization', () => {
  it('counts console, exception, and log failures without retaining event content', () => {
    const inventedConsoleMessage = 'Invented console content';
    const inventedExceptionMessage = 'Invented exception content';
    const inventedLogMessage = 'Invented log content';
    const summary = summarizeBrowserErrors([
      { source: 'console', level: 'error', message: inventedConsoleMessage },
      { source: 'console', level: 'warning', message: 'Invented warning content' },
      { source: 'console', level: 'assert', message: 'Invented assertion content' },
      { source: 'exception', message: inventedExceptionMessage },
      { source: 'log', level: 'error', message: inventedLogMessage },
      { source: 'log', level: 'info', message: 'Invented informational content' },
    ]);

    expect(summary).toEqual({
      consoleErrorCount: 2,
      exceptionCount: 1,
      logErrorCount: 1,
      totalErrorCount: 4,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(inventedConsoleMessage);
    expect(serialized).not.toContain(inventedExceptionMessage);
    expect(serialized).not.toContain(inventedLogMessage);
  });

  it('returns a clean aggregate for empty and non-error event input', () => {
    expect(
      summarizeBrowserErrors([
        null,
        { source: 'console', level: 'info' },
        { source: 'log', level: 'warning' },
        { source: 'invented', level: 'error' },
      ]),
    ).toEqual({
      consoleErrorCount: 0,
      exceptionCount: 0,
      logErrorCount: 0,
      totalErrorCount: 0,
    });
  });
});
