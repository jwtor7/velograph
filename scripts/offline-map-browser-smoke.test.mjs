import { describe, expect, it } from 'vitest';
import { summarizeBrowserErrors, summarizeRequestOrigins } from './offline-map-browser-smoke.mjs';

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
