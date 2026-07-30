#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 25;
const STATE_KEY = '__velographOfflineMapBrowserSmoke';
const CANVAS_TRACE_KEY = '__velographOfflineMapCanvasTrace';
const BASEMAP_TILE_PATH = /^\/api\/basemap\/tiles\/\d+\/\d+\/\d+\/?$/;

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

class SafeSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SafeSmokeError';
    this.code = code;
  }
}

function safeError(code) {
  return new SafeSmokeError(code);
}

export function canvasTraceHasPolyline(trace) {
  return Boolean(
    trace &&
    typeof trace === 'object' &&
    Number.isInteger(trace.polylineStrokeCount) &&
    trace.polylineStrokeCount > 0 &&
    Number.isInteger(trace.maxPolylineSegmentCount) &&
    trace.maxPolylineSegmentCount > 0,
  );
}

export function cursorSnapshotIsSynchronized(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length !== 3) return false;

  const observations = snapshot.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const values = [
      entry.minimum,
      entry.maximum,
      entry.value,
      entry.cursorX1,
      entry.cursorX2,
      entry.viewBoxX,
      entry.viewBoxWidth,
    ];
    if (
      !values.every(Number.isFinite) ||
      entry.maximum <= entry.minimum ||
      entry.viewBoxWidth <= 0
    ) {
      return null;
    }
    if (entry.value < entry.minimum || entry.value > entry.maximum) return null;

    const normalizedValue = (entry.value - entry.minimum) / (entry.maximum - entry.minimum);
    const normalizedCursor = (entry.cursorX1 - entry.viewBoxX) / entry.viewBoxWidth;
    if (
      Math.abs(entry.cursorX1 - entry.cursorX2) > 1e-6 ||
      Math.abs(normalizedValue - normalizedCursor) > 1e-6
    ) {
      return null;
    }
    return { ...entry, normalizedCursor };
  });
  if (observations.some((entry) => entry === null)) return false;

  const first = observations[0];
  return observations.every(
    (entry) =>
      entry.minimum === first.minimum &&
      entry.maximum === first.maximum &&
      entry.value === first.value &&
      Math.abs(entry.normalizedCursor - first.normalizedCursor) <= 1e-6,
  );
}

function normalizedHostname(hostname) {
  const lower = hostname.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function isLoopbackHostname(hostname) {
  const normalized = normalizedHostname(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  const octets = normalized.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const values = octets.map(Number);
  return values[0] === 127 && values.every((value) => value >= 0 && value <= 255);
}

/**
 * Reduce raw CDP request URLs to privacy-safe counters. No URL, host, path,
 * query, or fragment is retained in the returned value.
 */
export function summarizeRequestOrigins(requestUrls) {
  let requestCount = 0;
  let loopbackRequestCount = 0;
  let nonLoopbackRequestCount = 0;
  let invalidRequestCount = 0;
  let unsupportedSchemeRequestCount = 0;
  let localBasemapTileRequestCount = 0;

  for (const rawUrl of requestUrls) {
    requestCount += 1;
    let parsed;
    try {
      parsed = new URL(typeof rawUrl === 'string' ? rawUrl : '');
    } catch {
      invalidRequestCount += 1;
      continue;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      unsupportedSchemeRequestCount += 1;
      continue;
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      nonLoopbackRequestCount += 1;
      continue;
    }

    loopbackRequestCount += 1;
    if (BASEMAP_TILE_PATH.test(parsed.pathname)) localBasemapTileRequestCount += 1;
  }

  return Object.freeze({
    requestCount,
    loopbackRequestCount,
    nonLoopbackRequestCount,
    invalidRequestCount,
    unsupportedSchemeRequestCount,
    localBasemapTileRequestCount,
    allRequestsLoopback:
      requestCount > 0 &&
      loopbackRequestCount === requestCount &&
      nonLoopbackRequestCount === 0 &&
      invalidRequestCount === 0 &&
      unsupportedSchemeRequestCount === 0,
  });
}

/**
 * Reduce sanitized console/runtime/log event descriptors to counters. Message
 * text and other event fields are deliberately ignored.
 */
export function summarizeBrowserErrors(events) {
  let consoleErrorCount = 0;
  let exceptionCount = 0;
  let logErrorCount = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.source === 'exception') {
      exceptionCount += 1;
    } else if (
      event.source === 'console' &&
      (event.level === 'error' || event.level === 'assert')
    ) {
      consoleErrorCount += 1;
    } else if (event.source === 'log' && event.level === 'error') {
      logErrorCount += 1;
    }
  }

  return Object.freeze({
    consoleErrorCount,
    exceptionCount,
    logErrorCount,
    totalErrorCount: consoleErrorCount + exceptionCount + logErrorCount,
  });
}

function emptyMutableRequestSummary() {
  return {
    requestCount: 0,
    loopbackRequestCount: 0,
    nonLoopbackRequestCount: 0,
    invalidRequestCount: 0,
    unsupportedSchemeRequestCount: 0,
    localBasemapTileRequestCount: 0,
  };
}

function addRequestSummary(total, next) {
  total.requestCount += next.requestCount;
  total.loopbackRequestCount += next.loopbackRequestCount;
  total.nonLoopbackRequestCount += next.nonLoopbackRequestCount;
  total.invalidRequestCount += next.invalidRequestCount;
  total.unsupportedSchemeRequestCount += next.unsupportedSchemeRequestCount;
  total.localBasemapTileRequestCount += next.localBasemapTileRequestCount;
}

function requestSummaryIsLoopbackOnly(summary) {
  return (
    summary.requestCount > 0 &&
    summary.loopbackRequestCount === summary.requestCount &&
    summary.nonLoopbackRequestCount === 0 &&
    summary.invalidRequestCount === 0 &&
    summary.unsupportedSchemeRequestCount === 0
  );
}

function parseArguments(argv, environment) {
  const options = {
    chromeExecutable: environment.VELO_BROWSER_SMOKE_CHROME,
    baseUrl: environment.VELO_BROWSER_SMOKE_URL,
    rideId: environment.VELO_BROWSER_SMOKE_RIDE_ID,
    timeoutMs: environment.VELO_BROWSER_SMOKE_TIMEOUT_MS
      ? Number(environment.VELO_BROWSER_SMOKE_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw safeError('invalid_arguments');
    if (argument === '--chrome') options.chromeExecutable = value;
    else if (argument === '--url') options.baseUrl = value;
    else if (argument === '--ride-id') options.rideId = value;
    else if (argument === '--timeout-ms') options.timeoutMs = Number(value);
    else throw safeError('invalid_arguments');
    index += 1;
  }

  return options;
}

function usage() {
  return [
    'Usage: node scripts/offline-map-browser-smoke.mjs --chrome <executable> --url <loopback-origin> --ride-id <positive-integer>',
    '',
    'Environment equivalents:',
    '  VELO_BROWSER_SMOKE_CHROME',
    '  VELO_BROWSER_SMOKE_URL',
    '  VELO_BROWSER_SMOKE_RIDE_ID',
    '  VELO_BROWSER_SMOKE_TIMEOUT_MS',
    '',
  ].join('\n');
}

function validatedRuntimeOptions(options) {
  if (
    typeof options.chromeExecutable !== 'string' ||
    options.chromeExecutable.trim().length === 0 ||
    typeof options.baseUrl !== 'string' ||
    typeof options.rideId !== 'string'
  ) {
    throw safeError('missing_required_arguments');
  }
  if (!/^[1-9]\d*$/.test(options.rideId)) throw safeError('invalid_ride_id');
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < MIN_TIMEOUT_MS ||
    options.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw safeError('invalid_timeout');
  }

  let baseUrl;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch {
    throw safeError('invalid_loopback_url');
  }
  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
    !isLoopbackHostname(baseUrl.hostname) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw safeError('invalid_loopback_url');
  }

  const rideUrl = new URL(`/rides/${options.rideId}`, baseUrl.origin).href;
  return {
    chromeExecutable: options.chromeExecutable,
    rideUrl,
    timeoutMs: options.timeoutMs,
  };
}

function waitForDevToolsEndpoint(child, timeoutMs) {
  return new Promise((resolveEndpoint, rejectEndpoint) => {
    let settled = false;
    let stderrBuffer = '';

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const onData = (chunk) => {
      stderrBuffer = `${stderrBuffer}${String(chunk)}`.slice(-65_536);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderrBuffer);
      if (match?.[1]) finish(resolveEndpoint, match[1]);
    };
    const onError = () => finish(rejectEndpoint, safeError('chromium_launch_failed'));
    const onExit = () => finish(rejectEndpoint, safeError('chromium_exited_before_ready'));
    const timer = setTimeout(
      () => finish(rejectEndpoint, safeError('chromium_start_timeout')),
      timeoutMs,
    );

    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolveExit(result);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChromium(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 2_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

class CdpClient {
  static async connect(endpoint, timeoutMs) {
    if (typeof globalThis.WebSocket !== 'function') {
      throw safeError('node_websocket_unavailable');
    }
    const socket = new globalThis.WebSocket(endpoint);
    await new Promise((resolveOpen, rejectOpen) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        callback(value);
      };
      const onOpen = () => finish(resolveOpen);
      const onError = () => finish(rejectOpen, safeError('cdp_connection_failed'));
      const timer = setTimeout(
        () => finish(rejectOpen, safeError('cdp_connection_timeout')),
        timeoutMs,
      );
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => this.handleClose());
    this.socket.addEventListener('error', () => this.handleClose());
  }

  handleMessage(rawMessage) {
    let message;
    try {
      message = JSON.parse(typeof rawMessage === 'string' ? rawMessage : '');
    } catch {
      return;
    }

    if (Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(safeError('cdp_command_failed'));
      else pending.resolve(message.result ?? {});
      return;
    }

    if (typeof message.method === 'string') {
      for (const listener of this.listeners) listener(message);
    }
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(safeError('cdp_connection_closed'));
    }
    this.pending.clear();
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, sessionId, timeoutMs = 10_000) {
    if (this.closed || this.socket.readyState !== globalThis.WebSocket.OPEN) {
      return Promise.reject(safeError('cdp_connection_closed'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(safeError('cdp_command_timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(safeError('cdp_connection_closed'));
    }
    this.pending.clear();
    this.listeners.clear();
    this.socket.close();
  }
}

async function evaluate(client, sessionId, expression) {
  const response = await client.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    sessionId,
  );
  if (response.exceptionDetails) throw safeError('browser_evaluation_failed');
  return response.result?.value;
}

async function waitForBoolean(client, sessionId, expression, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if ((await evaluate(client, sessionId, expression)) === true) return true;
    await delay(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return false;
}

function remainingTime(deadline) {
  return Math.max(250, deadline - Date.now());
}

function installCanvasTraceExpression() {
  return `(() => {
    const contextPrototype = globalThis.CanvasRenderingContext2D?.prototype;
    if (!contextPrototype) return false;
    if (contextPrototype['${CANVAS_TRACE_KEY}']) return true;

    const pathStates = new WeakMap();
    const beginPath = contextPrototype.beginPath;
    const moveTo = contextPrototype.moveTo;
    const lineTo = contextPrototype.lineTo;
    const arc = contextPrototype.arc;
    const stroke = contextPrototype.stroke;
    const pathState = (context) => {
      let state = pathStates.get(context);
      if (!state) {
        state = { lineSegmentCount: 0, arcs: [] };
        pathStates.set(context, state);
      }
      return state;
    };
    const traceFor = (canvas) => {
      let trace = canvas['${CANVAS_TRACE_KEY}'];
      if (!trace) {
        trace = {
          polylineStrokeCount: 0,
          maxPolylineSegmentCount: 0,
          cursorStrokeCount: 0,
          lastCursorCenter: null,
        };
        Object.defineProperty(canvas, '${CANVAS_TRACE_KEY}', {
          configurable: true,
          enumerable: false,
          value: trace,
          writable: false,
        });
      }
      return trace;
    };

    contextPrototype.beginPath = function (...argumentsList) {
      pathStates.set(this, { lineSegmentCount: 0, arcs: [] });
      return Reflect.apply(beginPath, this, argumentsList);
    };
    contextPrototype.moveTo = function (...argumentsList) {
      pathState(this);
      return Reflect.apply(moveTo, this, argumentsList);
    };
    contextPrototype.lineTo = function (...argumentsList) {
      const state = pathState(this);
      state.lineSegmentCount += 1;
      return Reflect.apply(lineTo, this, argumentsList);
    };
    contextPrototype.arc = function (x, y, radius, ...argumentsList) {
      const state = pathState(this);
      if ([x, y, radius].every(Number.isFinite)) state.arcs.push({ x, y, radius });
      return Reflect.apply(arc, this, [x, y, radius, ...argumentsList]);
    };
    contextPrototype.stroke = function (...argumentsList) {
      const canvas = this.canvas;
      const state = pathState(this);
      if (canvas?.closest?.('.leaflet-overlay-pane')) {
        const trace = traceFor(canvas);
        if (state.lineSegmentCount > 0) {
          trace.polylineStrokeCount += 1;
          trace.maxPolylineSegmentCount = Math.max(
            trace.maxPolylineSegmentCount,
            state.lineSegmentCount,
          );
        }
        const cursorArc = state.arcs.find(({ radius }) => Math.abs(radius - 8) <= 0.05);
        if (cursorArc) {
          trace.cursorStrokeCount += 1;
          trace.lastCursorCenter = [cursorArc.x, cursorArc.y];
        }
      }
      return Reflect.apply(stroke, this, argumentsList);
    };
    Object.defineProperty(contextPrototype, '${CANVAS_TRACE_KEY}', {
      configurable: true,
      enumerable: false,
      value: true,
      writable: false,
    });
    return true;
  })()`;
}

function mapDomSnapshotExpression() {
  return `(() => {
    const map = document.querySelector('.route-map.leaflet-container');
    const overlayCanvas = map?.querySelector('.leaflet-overlay-pane canvas');
    const canvasTraceHasPolyline = ${canvasTraceHasPolyline.toString()};
    const canvasTrace = overlayCanvas?.['${CANVAS_TRACE_KEY}'];
    let overlayHasInk = false;
    try {
      const context = overlayCanvas?.getContext('2d', { willReadFrequently: true });
      const pixels = context?.getImageData(0, 0, overlayCanvas.width, overlayCanvas.height).data;
      if (pixels) {
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] !== 0) {
            overlayHasInk = true;
            break;
          }
        }
      }
    } catch {
      overlayHasInk = false;
    }
    const linkedControls = map
      ? [...document.querySelectorAll('.route-map-toolbar .route-map-button')]
          .filter((button) => button.getAttribute('aria-controls') === map.id).length
      : 0;
    const routeLabels = map
      ? [...map.querySelectorAll('.leaflet-tooltip-pane .route-map-label')]
      : [];
    const endpointMarkerCount = routeLabels.filter((label) =>
      label.classList.contains('route-map-label-endpoint'),
    ).length;
    const directionMarkerCount = routeLabels.filter((label) =>
      label.classList.contains('route-map-label-direction'),
    ).length;
    const distanceMarkerCount = routeLabels.filter(
      (label) =>
        !label.classList.contains('route-map-label-endpoint') &&
        !label.classList.contains('route-map-label-direction'),
    ).length;
    const status = document.querySelector('.route-map-status');
    return {
      leafletUi: Boolean(
        map &&
        Number.isInteger(map._leaflet_id) &&
        map.querySelector('.leaflet-map-pane') &&
        map.querySelector('.leaflet-tile-pane') &&
        map.querySelector('.leaflet-overlay-pane') &&
        map.querySelector('.leaflet-control-container')
      ),
      controls: linkedControls >= 3,
      scale: Boolean(map?.querySelector('.leaflet-control-scale-line')),
      markers: Boolean(map) && endpointMarkerCount >= 2 && routeLabels.length >= 2,
      endpointMarkerCount,
      directionMarkerCount,
      distanceMarkerCount,
      routeGeometry: Boolean(
        overlayCanvas &&
        overlayCanvas.width > 0 &&
        overlayCanvas.height > 0 &&
        overlayHasInk &&
        canvasTraceHasPolyline(canvasTrace)
      ),
      basemapNotConfigured: Boolean(
        status?.classList.contains('route-map-status-not_configured') &&
        status.textContent?.trim() === 'No local basemap configured · showing route-only view'
      ),
      localTileLoaded: Boolean(map?.querySelector('.leaflet-tile-pane img.leaflet-tile-loaded')),
    };
  })()`;
}

function settledRideExpression() {
  return `(() => {
    const canvasTraceHasPolyline = ${canvasTraceHasPolyline.toString()};
    if (document.readyState !== 'complete') return false;
    if (document.body?.textContent?.includes('Loading…')) return false;
    const map = document.querySelector('.route-map.leaflet-container');
    const canvas = map?.querySelector('.leaflet-overlay-pane canvas');
    const status = document.querySelector('.route-map-status');
    if (
      !map ||
      !Number.isInteger(map._leaflet_id) ||
      !map.querySelector('.leaflet-map-pane') ||
      !canvas ||
      canvas.width <= 0 ||
      canvas.height <= 0 ||
      !status
    ) {
      return false;
    }
    // The pre-navigation draw trace stops the performance timer at the actual
    // route stroke. A full pixel read remains a separate post-timing assertion
    // in mapDomSnapshotExpression so observation overhead cannot inflate p95.
    return Boolean(
      canvasTraceHasPolyline(canvas['${CANVAS_TRACE_KEY}']) &&
      document.querySelectorAll('.chart-grid svg').length >= 4 &&
      document.querySelector('svg[aria-label="elevation profile"]') &&
      document.querySelectorAll('.chart-grid [role="slider"][aria-keyshortcuts]').length === 3 &&
      document.querySelectorAll('.kpi-grid .kpi').length >= 7
    );
  })()`;
}

function installSmokeStateExpression() {
  return `(() => {
    const map = document.querySelector('.route-map.leaflet-container');
    const mapPane = map?.querySelector('.leaflet-map-pane');
    if (!map || !mapPane) return false;
    const cursorSnapshotIsSynchronized = ${cursorSnapshotIsSynchronized.toString()};
    const overlayHash = () => {
      const canvas = map.querySelector('.leaflet-overlay-pane canvas');
      const context = canvas?.getContext('2d', { willReadFrequently: true });
      if (!canvas || !context) return null;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 1) {
        hash ^= pixels[index];
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    };
    const readCursorSnapshot = () =>
      [...document.querySelectorAll('.chart-grid [role="slider"][aria-keyshortcuts]')].map(
        (slider) => {
          const cursorLines = [...slider.querySelectorAll('line')].filter(
            (line) => line.getAttribute('stroke-dasharray') === '3 3',
          );
          const cursorLine = cursorLines.length === 1 ? cursorLines[0] : null;
          const viewBox = slider.viewBox?.baseVal;
          return {
            minimum: Number(slider.getAttribute('aria-valuemin')),
            maximum: Number(slider.getAttribute('aria-valuemax')),
            value: Number(slider.getAttribute('aria-valuenow')),
            cursorX1: Number(cursorLine?.getAttribute('x1')),
            cursorX2: Number(cursorLine?.getAttribute('x2')),
            viewBoxX: Number(viewBox?.x),
            viewBoxWidth: Number(viewBox?.width),
          };
        },
      );
    const readMapCursorTrace = () => {
      const canvas = map.querySelector('.leaflet-overlay-pane canvas');
      const trace = canvas?.['${CANVAS_TRACE_KEY}'];
      const center =
        Array.isArray(trace?.lastCursorCenter) &&
        trace.lastCursorCenter.length === 2 &&
        trace.lastCursorCenter.every(Number.isFinite)
          ? [...trace.lastCursorCenter]
          : null;
      return {
        count: Number.isInteger(trace?.cursorStrokeCount) ? trace.cursorStrokeCount : 0,
        center,
      };
    };
    const state = {
      mapTransform: mapPane.style.transform || getComputedStyle(mapPane).transform,
      overlayHash,
      readCursorSnapshot,
      readMapCursorTrace,
      cursorSnapshotIsSynchronized,
      preCursorHash: null,
      preMapCursorCount: null,
      firstCursorHash: null,
      firstMapCursorCount: null,
      firstMapCursorCenter: null,
      firstCursorValue: null,
      firstCursorPosition: null,
    };
    Object.defineProperty(window, '${STATE_KEY}', {
      configurable: true,
      enumerable: false,
      value: state,
      writable: false,
    });
    map.focus({ preventScroll: true });
    return document.activeElement === map;
  })()`;
}

function mapPanChangedExpression() {
  return `(() => {
    const state = window['${STATE_KEY}'];
    const mapPane = document.querySelector('.route-map.leaflet-container .leaflet-map-pane');
    if (!state || !mapPane) return false;
    const current = mapPane.style.transform || getComputedStyle(mapPane).transform;
    return current !== state.mapTransform;
  })()`;
}

function focusChartCursorExpression() {
  return `(() => {
    const state = window['${STATE_KEY}'];
    const sliders = [...document.querySelectorAll('.chart-grid [role="slider"][aria-keyshortcuts]')];
    if (!state || sliders.length !== 3) return false;
    const slider = sliders[0];
    state.preCursorHash = state.overlayHash();
    state.preMapCursorCount = state.readMapCursorTrace().count;
    slider.focus({ preventScroll: true });
    return document.activeElement === slider;
  })()`;
}

function firstCursorSynchronizedExpression() {
  return `(() => {
    const state = window['${STATE_KEY}'];
    if (!state || state.preCursorHash == null || state.preMapCursorCount == null) return false;
    const snapshot = state.readCursorSnapshot();
    const mapCursor = state.readMapCursorTrace();
    const mapHash = state.overlayHash();
    if (
      !state.cursorSnapshotIsSynchronized(snapshot) ||
      mapHash == null ||
      mapHash === state.preCursorHash ||
      mapCursor.count <= state.preMapCursorCount ||
      !mapCursor.center
    ) {
      return false;
    }
    const first = snapshot[0];
    state.firstCursorValue = first.value;
    state.firstCursorPosition = (first.cursorX1 - first.viewBoxX) / first.viewBoxWidth;
    state.firstCursorHash = mapHash;
    state.firstMapCursorCount = mapCursor.count;
    state.firstMapCursorCenter = mapCursor.center;
    return true;
  })()`;
}

function movedCursorSynchronizedExpression() {
  return `(() => {
    const state = window['${STATE_KEY}'];
    if (
      !state ||
      state.firstCursorValue == null ||
      state.firstCursorPosition == null ||
      state.firstCursorHash == null ||
      state.firstMapCursorCount == null ||
      !state.firstMapCursorCenter
    ) {
      return false;
    }
    const snapshot = state.readCursorSnapshot();
    if (!state.cursorSnapshotIsSynchronized(snapshot)) return false;
    const first = snapshot[0];
    const cursorPosition = (first.cursorX1 - first.viewBoxX) / first.viewBoxWidth;
    const mapCursor = state.readMapCursorTrace();
    const mapHash = state.overlayHash();
    return Boolean(
      first.value !== state.firstCursorValue &&
      Math.abs(cursorPosition - state.firstCursorPosition) > 1e-6 &&
      mapHash != null &&
      mapHash !== state.firstCursorHash &&
      mapCursor.count > state.firstMapCursorCount &&
      mapCursor.center &&
      Math.hypot(
        mapCursor.center[0] - state.firstMapCursorCenter[0],
        mapCursor.center[1] - state.firstMapCursorCenter[1],
      ) > 0.1
    );
  })()`;
}

async function dispatchKey(client, sessionId, key, code, virtualKeyCode) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  await client.send('Input.dispatchKeyEvent', { ...common, type: 'rawKeyDown' }, sessionId);
  await client.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' }, sessionId);
}

async function runBrowserSmoke(runtimeOptions) {
  const deadline = Date.now() + runtimeOptions.timeoutMs;
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'velograph-offline-map-smoke-'));
  let chromium;
  let client;
  let removeEventListener = () => {};

  try {
    chromium = spawn(
      runtimeOptions.chromeExecutable,
      [
        '--headless=new',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        `--user-data-dir=${userDataDirectory}`,
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,Translate',
        '--disable-sync',
        '--force-device-scale-factor=1',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        '--password-store=basic',
        '--use-mock-keychain',
        '--window-size=1440,1000',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const endpoint = await waitForDevToolsEndpoint(
      chromium,
      Math.min(15_000, remainingTime(deadline)),
    );
    chromium.stderr?.resume();
    client = await CdpClient.connect(endpoint, Math.min(10_000, remainingTime(deadline)));

    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    if (typeof targetId !== 'string') throw safeError('cdp_target_creation_failed');
    await client.send('Target.activateTarget', { targetId });
    const { sessionId } = await client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    if (typeof sessionId !== 'string') throw safeError('cdp_target_attachment_failed');

    const requestSummary = emptyMutableRequestSummary();
    const browserErrorEvents = [];
    let targetCrashed = false;
    removeEventListener = client.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.method === 'Network.requestWillBeSent') {
        addRequestSummary(requestSummary, summarizeRequestOrigins([event.params?.request?.url]));
      } else if (event.method === 'Runtime.consoleAPICalled') {
        browserErrorEvents.push({
          source: 'console',
          level: event.params?.type,
        });
      } else if (event.method === 'Runtime.exceptionThrown') {
        browserErrorEvents.push({ source: 'exception' });
      } else if (event.method === 'Log.entryAdded') {
        browserErrorEvents.push({
          source: 'log',
          level: event.params?.entry?.level,
        });
      } else if (event.method === 'Inspector.targetCrashed') {
        targetCrashed = true;
      }
    });

    await Promise.all([
      client.send('Page.enable', {}, sessionId),
      client.send('Runtime.enable', {}, sessionId),
      client.send('Network.enable', {}, sessionId),
      client.send('Log.enable', {}, sessionId),
      client.send('Inspector.enable', {}, sessionId),
    ]);
    await client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: installCanvasTraceExpression() },
      sessionId,
    );
    await client.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    );
    const navigationStarted = performance.now();
    await client.send('Page.navigate', { url: runtimeOptions.rideUrl }, sessionId);

    const mapRendered = await waitForBoolean(
      client,
      sessionId,
      settledRideExpression(),
      Math.min(12_000, remainingTime(deadline)),
    );
    const settledRenderMs = performance.now() - navigationStarted;
    if (runtimeOptions.requireLocalBasemap) {
      await waitForBoolean(
        client,
        sessionId,
        `Boolean(document.querySelector('.leaflet-tile-pane img.leaflet-tile-loaded'))`,
        Math.min(8_000, remainingTime(deadline)),
      );
    } else {
      await waitForBoolean(
        client,
        sessionId,
        `Boolean(
          document.querySelector(
            '.route-map-status.route-map-status-not_configured'
          )?.textContent?.trim() ===
            'No local basemap configured · showing route-only view'
        )`,
        Math.min(8_000, remainingTime(deadline)),
      );
    }

    const mapDom =
      (await evaluate(client, sessionId, mapDomSnapshotExpression())) ?? Object.create(null);
    const mapFocused =
      mapRendered && (await evaluate(client, sessionId, installSmokeStateExpression())) === true;
    if (mapFocused) {
      await dispatchKey(client, sessionId, 'ArrowRight', 'ArrowRight', 39);
    }
    const keyboardPan =
      mapFocused &&
      (await waitForBoolean(
        client,
        sessionId,
        mapPanChangedExpression(),
        Math.min(2_000, remainingTime(deadline)),
      ));
    await delay(350);

    const chartFocused = (await evaluate(client, sessionId, focusChartCursorExpression())) === true;
    const initialCursorSync =
      chartFocused &&
      (await waitForBoolean(
        client,
        sessionId,
        firstCursorSynchronizedExpression(),
        Math.min(3_000, remainingTime(deadline)),
      ));
    if (initialCursorSync) {
      await dispatchKey(client, sessionId, 'PageUp', 'PageUp', 33);
    }
    const movedCursorSync =
      initialCursorSync &&
      (await waitForBoolean(
        client,
        sessionId,
        movedCursorSynchronizedExpression(),
        Math.min(3_000, remainingTime(deadline)),
      ));
    await delay(250);

    const browserErrors = summarizeBrowserErrors(browserErrorEvents);
    const assertions = [
      ['map-rendered', mapRendered],
      ['leaflet-geospatial-ui', mapDom.leafletUi === true],
      ['map-controls', mapDom.controls === true],
      ['map-scale', mapDom.scale === true],
      ['map-markers', mapDom.markers === true],
      ['map-route-geometry', mapDom.routeGeometry === true],
      ['map-keyboard-pan', keyboardPan],
      ['chart-map-cursor-initial-sync', initialCursorSync],
      ['chart-map-cursor-keyboard-sync', movedCursorSync],
      ['browser-console-clean', browserErrors.totalErrorCount === 0],
      ['browser-target-stable', targetCrashed === false],
      ['network-requests-observed', requestSummary.requestCount > 0],
      ['network-loopback-only', requestSummaryIsLoopbackOnly(requestSummary)],
      ...(runtimeOptions.requireLocalBasemap
        ? [
            ['local-basemap-tile-requested', requestSummary.localBasemapTileRequestCount > 0],
            ['local-basemap-tile-loaded', mapDom.localTileLoaded === true],
          ]
        : [
            ['route-only-basemap-not-configured', mapDom.basemapNotConfigured === true],
            [
              'route-only-basemap-tile-not-requested',
              requestSummary.localBasemapTileRequestCount === 0,
            ],
            ['route-only-endpoint-markers', mapDom.endpointMarkerCount === 2],
            ['route-only-direction-marker', mapDom.directionMarkerCount >= 1],
            ['route-only-distance-marker', mapDom.distanceMarkerCount >= 1],
          ]),
    ];
    const failedAssertionCodes = assertions.filter(([, passed]) => !passed).map(([code]) => code);

    await evaluate(
      client,
      sessionId,
      `(() => {
        delete window['${STATE_KEY}'];
        return true;
      })()`,
    ).catch(() => {});

    return Object.freeze({
      passed: failedAssertionCodes.length === 0,
      failedAssertionCodes: Object.freeze(failedAssertionCodes),
      settledRenderMs,
    });
  } finally {
    removeEventListener();
    client?.close();
    await stopChromium(chromium);
    await rm(userDataDirectory, { force: true, recursive: true });
  }
}

export async function runOfflineMapBrowserSmoke(options) {
  const runtimeOptions = validatedRuntimeOptions({
    chromeExecutable: options.chromeExecutable,
    baseUrl: options.baseUrl,
    rideId: String(options.rideId),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return runBrowserSmoke({
    ...runtimeOptions,
    requireLocalBasemap: options.requireLocalBasemap ?? true,
  });
}

async function main() {
  try {
    const parsedOptions = parseArguments(process.argv.slice(2), process.env);
    if (parsedOptions.help) {
      process.stdout.write(usage());
      return;
    }
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
    if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
      throw safeError('node_22_or_newer_required');
    }
    const result = await runOfflineMapBrowserSmoke({
      ...parsedOptions,
      requireLocalBasemap: true,
    });
    if (result.passed) {
      process.stdout.write('offline-map-browser-smoke: PASS\n');
      return;
    }
    process.stderr.write(
      `offline-map-browser-smoke: FAIL (${result.failedAssertionCodes.join(', ')})\n`,
    );
    process.exitCode = 1;
  } catch (error) {
    const code = error instanceof SafeSmokeError ? error.code : 'unexpected_runtime_failure';
    process.stderr.write(`offline-map-browser-smoke: ERROR (${code})\n`);
    process.exitCode = 1;
  }
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) await main();
