import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Database } from '@velograph/db';
import {
  AnalyticsSnapshotConflictError,
  BackupValidationError,
  Repository,
  RestoreDatabaseError,
  RestoreValidationError,
  backupDatabase,
  loadWorkoutData,
  restoreDatabaseWithReport,
} from '@velograph/db';
import {
  FolderImportError,
  inventoryFiles,
  previewImportFolder,
  readFolderFiles,
  runImport,
  type ImportFile,
} from '@velograph/importers';
import { APP_VERSION } from '@velograph/shared';
import {
  getOrComputeAnalytics,
  InvalidAppSettingsError,
  loadSettings,
  mergeAppSettings,
  repairWorkout,
  saveSettings,
} from './analytics-service.ts';
import { BasemapService, type BasemapTile } from './basemap.ts';

export const API_VERSION = APP_VERSION;
const MAX_IMPORT_BODY_BYTES = 600 * 1024 * 1024; // base64-encoded uploads
const MAX_PATH_BODY_BYTES = 8 * 1024;

/**
 * Loopback-only HTTP API (PRD §11.3, §12.3).
 *
 * Hardening, even though we bind 127.0.0.1:
 *  - Host header must be a loopback host with our port.
 *  - Origin, when present, must be a loopback origin with our port
 *    (blocks cross-site requests from other local servers and the web).
 *  - Browser fetch metadata explicitly marked cross-site is rejected, even
 *    for GET image requests that browsers may send without Origin.
 *  - Mutating requests additionally require the custom `x-velograph-request`
 *    header (CSRF: cross-site forms cannot set custom headers).
 *  - Self-only CSP, nosniff, no CORS grants, same-origin resource policy.
 *  - Logs carry method, path, status — never payloads, filenames, or values.
 */
export interface ApiOptions {
  db: Database;
  /**
   * Filesystem path backing `db` (undefined for an in-memory/test db).
   * Required for /api/restore, which must close and reopen the live
   * connection at this exact path.
   */
  dbPath?: string;
  port?: number;
  host?: string;
  /** Directory of built web assets to serve statically (optional). */
  staticDir?: string;
  /** Conventional or explicitly configured read-only MBTiles file. */
  basemapPath?: string;
  /** True only when basemapPath came from VELO_BASEMAP_PATH. */
  basemapPathRequired?: boolean;
  now?: () => number;
  /** @internal Deterministic seam for restore/shutdown integration tests. */
  restoreDatabaseFn?: typeof restoreDatabaseWithReport;
}

interface ApiRuntimeState {
  activeRequests: number;
  databaseAvailable: boolean;
  restoreInProgress: boolean;
  exclusiveWaiters: Set<() => void>;
  idleWaiters: Set<() => void>;
}

export interface VelographApiServer extends Server {
  /** Always returns the current handle, including after a successful restore. */
  getDatabase(): Database;
  isRestoreInProgress(): boolean;
  /** Resolves after all accepted request work has settled, even if a client disconnected. */
  waitForRequests(): Promise<void>;
}

function notifyRequestWaiters(state: ApiRuntimeState): void {
  if (state.activeRequests <= 1) {
    for (const resolve of state.exclusiveWaiters) resolve();
    state.exclusiveWaiters.clear();
  }
  if (state.activeRequests === 0) {
    for (const resolve of state.idleWaiters) resolve();
    state.idleWaiters.clear();
  }
}

function waitForExclusiveRequest(state: ApiRuntimeState): Promise<void> {
  if (state.activeRequests <= 1) return Promise.resolve();
  return new Promise((resolve) => state.exclusiveWaiters.add(resolve));
}

function waitForRequests(state: ApiRuntimeState): Promise<void> {
  if (state.activeRequests === 0) return Promise.resolve();
  return new Promise((resolve) => state.idleWaiters.add(resolve));
}

export function createApiServer(opts: ApiOptions): VelographApiServer {
  const now = opts.now ?? Date.now;
  const state: ApiRuntimeState = {
    activeRequests: 0,
    databaseAvailable: true,
    restoreInProgress: false,
    exclusiveWaiters: new Set(),
    idleWaiters: new Set(),
  };
  const basemap = BasemapService.open({
    ...(opts.basemapPath ? { path: opts.basemapPath } : {}),
    ...(opts.basemapPathRequired === undefined ? {} : { required: opts.basemapPathRequired }),
  });

  const server = createServer((req, res) => {
    state.activeRequests += 1;
    let finished = false;
    let operationPending = false;
    const finishRequest = () => {
      if (finished) return;
      finished = true;
      state.activeRequests -= 1;
      notifyRequestWaiters(state);
    };
    const finishResponse = () => {
      if (!operationPending) finishRequest();
    };
    res.once('finish', finishResponse);
    res.once('close', finishResponse);

    try {
      const operation = handle(req, res, opts, now, server, state, basemap);
      if (operation) {
        operationPending = true;
        void operation
          .catch((error) =>
            send(res, 500, {
              error:
                error instanceof AnalyticsSnapshotConflictError
                  ? 'analytics_snapshot_conflict'
                  : 'internal_error',
            }),
          )
          .finally(() => {
            operationPending = false;
            finishRequest();
          });
      }
    } catch (error) {
      send(res, 500, {
        error:
          error instanceof AnalyticsSnapshotConflictError
            ? 'analytics_snapshot_conflict'
            : 'internal_error',
      });
    }
  });
  server.once('close', () => basemap.close());
  return Object.assign(server, {
    getDatabase: () => opts.db,
    isRestoreInProgress: () => state.restoreInProgress,
    waitForRequests: () => waitForRequests(state),
  });
}

function expectedPort(server: Server): number | null {
  const addr = server.address();
  return addr && typeof addr === 'object' ? addr.port : null;
}

function hostAllowed(header: string | undefined, port: number | null): boolean {
  if (!header) return false;
  const h = header.trim().toLowerCase();
  let name: string;
  let p: number | null = null;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(h);
  if (v6) {
    name = `[${v6[1]}]`;
    p = v6[2] ? Number(v6[2]) : null;
  } else {
    const idx = h.lastIndexOf(':');
    if (idx !== -1 && /^\d+$/.test(h.slice(idx + 1))) {
      name = h.slice(0, idx);
      p = Number(h.slice(idx + 1));
    } else {
      name = h;
    }
  }
  const loopback = name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
  return loopback && (port == null || p === port || (p == null && (port === 80 || port === 443)));
}

function originAllowed(origin: string | undefined, port: number | null): boolean {
  if (!origin) return true; // same-origin fetches and non-browser clients
  try {
    const u = new URL(origin);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    const p = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return loopback && (port == null || p === port);
  } catch {
    return false;
  }
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  securityHeaders(res);
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ApiOptions,
  now: () => number,
  server: Server,
  state: ApiRuntimeState,
  basemap: BasemapService,
): void | Promise<void> {
  const port = expectedPort(server);
  if (!hostAllowed(req.headers.host, port)) {
    send(res, 403, { error: 'host_not_allowed' });
    return;
  }
  if (!originAllowed(req.headers.origin as string | undefined, port)) {
    send(res, 403, { error: 'origin_not_allowed' });
    return;
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port ?? 0}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path.startsWith('/api/') && !fetchSiteAllowed(req.headers['sec-fetch-site'])) {
    send(res, 403, { error: 'cross_site_request' });
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers['x-velograph-request'] !== '1') {
      send(res, 403, { error: 'missing_csrf_header' });
      return;
    }
  }

  if (!state.databaseAvailable) {
    send(res, 503, { error: 'database_unavailable' });
    return;
  }
  if (state.restoreInProgress && path !== '/api/health') {
    send(res, 503, { error: 'restore_in_progress' });
    return;
  }

  if (path.startsWith('/api/')) {
    return route(req, res, opts, url, method, now, state, basemap);
  }
  serveStatic(res, opts.staticDir, path);
}

function route(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ApiOptions,
  url: URL,
  method: string,
  now: () => number,
  state: ApiRuntimeState,
  basemap: BasemapService,
): void | Promise<void> {
  const db = opts.db;
  const path = url.pathname;

  if (method === 'GET' && path === '/api/health') {
    send(res, 200, { ok: true, version: API_VERSION });
    return;
  }

  if (method === 'GET' && path === '/api/basemap') {
    send(res, 200, basemap.getManifest());
    return;
  }

  const basemapTile = /^\/api\/basemap\/tiles\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
  if (method === 'GET' && basemapTile) {
    const tile = basemap.getTile(
      Number(basemapTile[1]),
      Number(basemapTile[2]),
      Number(basemapTile[3]),
    );
    sendBasemapTile(res, tile);
    return;
  }

  if (method === 'GET' && path === '/api/workouts') {
    const repo = new Repository(db);
    const list = repo.listWorkouts().map((w) => {
      const a = getOrComputeAnalytics(db, w.id, now());
      return {
        id: w.id,
        type: w.type,
        startUtc: w.start_utc,
        endUtc: w.end_utc,
        durationS: w.duration_s,
        qualityState: w.quality_state,
        distanceM: a?.distanceM ?? null,
        avgSpeedMs: a?.avgSpeedMs ?? null,
        avgHr: a?.heartRate.avg ?? null,
        elevationGainM: a?.elevation.gainM ?? null,
        hasRoute: new Repository(db).workoutRouteFormat(w.id) !== undefined,
      };
    });
    send(res, 200, { workouts: list });
    return;
  }

  const detail = /^\/api\/workouts\/(\d+)$/.exec(path);
  if (method === 'GET' && detail) {
    const id = Number(detail[1]);
    const data = loadWorkoutData(db, id);
    if (!data) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    const analytics = getOrComputeAnalytics(db, id, now());
    send(res, 200, { workout: data.workout, metrics: data.metrics, route: data.route, analytics });
    return;
  }

  // Delete a workout and every row that belongs to it, in one transaction
  // (issue #38 scope). Irreversible without a backup — the UI confirmation
  // step says so explicitly before this ever fires.
  if (method === 'DELETE' && detail) {
    const id = Number(detail[1]);
    const repo = new Repository(db);
    const result = repo.deleteWorkout(id);
    if (!result) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    send(res, 200, {
      deleted: true,
      workoutId: id,
      removedSourceFiles: result.removedSourceFileIds.length,
    });
    return;
  }

  const repairMatch = /^\/api\/workouts\/(\d+)\/repair$/.exec(path);
  if (method === 'POST' && repairMatch) {
    const id = Number(repairMatch[1]);
    const analytics = repairWorkout(db, id, now());
    if (!analytics) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    send(res, 200, { repaired: true, analytics });
    return;
  }

  if (method === 'GET' && path === '/api/trends') {
    send(res, 200, buildTrends(db, now));
    return;
  }

  if (method === 'GET' && path === '/api/settings') {
    send(res, 200, { settings: loadSettings(db) });
    return;
  }

  if (method === 'PUT' && path === '/api/settings') {
    return readJsonBody(req, 1024 * 1024)
      .then((body) => {
        try {
          if (
            typeof body !== 'object' ||
            body === null ||
            Array.isArray(body) ||
            Object.keys(body).length !== 1 ||
            !Object.hasOwn(body, 'settings')
          ) {
            throw new InvalidAppSettingsError();
          }
          const patch = (body as { settings: unknown }).settings;
          const merged = mergeAppSettings(loadSettings(db), patch);
          const settings = saveSettings(db, merged);
          send(res, 200, { settings });
        } catch (error) {
          if (error instanceof InvalidAppSettingsError) {
            send(res, 400, { error: 'invalid_settings' });
            return;
          }
          send(res, 500, { error: 'internal_error' });
        }
      })
      .catch(() => {
        if (!res.headersSent) send(res, 400, { error: 'invalid_body' });
      });
    return;
  }

  if (method === 'POST' && path === '/api/import/inventory') {
    return readJsonBody(req, MAX_IMPORT_BODY_BYTES)
      .then((body) => {
        const files = decodeFiles(body);
        send(res, 200, { inventory: inventoryFiles(files) });
      })
      .catch(() => send(res, 400, { error: 'invalid_body' }));
    return;
  }

  if (method === 'POST' && path === '/api/import') {
    return readJsonBody(req, MAX_IMPORT_BODY_BYTES)
      .then((body) => {
        const files = decodeFiles(body);
        if (files.length === 0) {
          send(res, 400, { error: 'no_files' });
          return;
        }
        const result = runImport(db, files, { now: now(), timeZone: loadSettings(db).timeZone });
        send(res, 200, { result });
      })
      .catch(() => send(res, 400, { error: 'invalid_body' }));
    return;
  }

  // Path-based folder import (issue #51): the client posts a folder path
  // instead of every file as base64. The API reads it directly from disk,
  // the same way the CLI already does, bounded by walkImportFolder's caps.
  // Never a folder that resolves inside this checkout (guardAgainstCheckout,
  // reused — not reimplemented — from @velograph/db).
  if (method === 'POST' && path === '/api/import/path/inventory') {
    readJsonBody(req, MAX_PATH_BODY_BYTES)
      .then((body) => {
        const p = readPathField(body);
        if (!p) {
          send(res, 400, { error: 'invalid_path' });
          return;
        }
        try {
          send(res, 200, { preview: previewImportFolder(p) });
        } catch (err) {
          send(res, folderErrorStatus(err), { error: folderErrorCode(err) });
        }
      })
      .catch(() => send(res, 400, { error: 'invalid_body' }));
    return;
  }

  if (method === 'POST' && path === '/api/import/path') {
    readJsonBody(req, MAX_PATH_BODY_BYTES)
      .then((body) => {
        const p = readPathField(body);
        if (!p) {
          send(res, 400, { error: 'invalid_path' });
          return;
        }
        try {
          const { files, skipped, truncated } = readFolderFiles(p);
          if (files.length === 0) {
            send(res, 400, { error: 'no_files' });
            return;
          }
          const result = runImport(db, files, { now: now(), timeZone: loadSettings(db).timeZone });
          send(res, 200, { result, skipped, truncated });
        } catch (err) {
          send(res, folderErrorStatus(err), { error: folderErrorCode(err) });
        }
      })
      .catch(() => send(res, 400, { error: 'invalid_body' }));
    return;
  }

  // Export the database to a user-chosen path via SQLite's backup API
  // (never a raw copy of the live WAL files). The destination must not
  // resolve inside a git checkout — enforced by guardAgainstCheckout inside
  // backupDatabase — because backups carry real health data.
  if (method === 'POST' && path === '/api/backup') {
    return readJsonBody(req, MAX_PATH_BODY_BYTES)
      .then(async (body) => {
        const dest = readPathField(body);
        if (!dest) {
          send(res, 400, { error: 'invalid_path' });
          return;
        }
        try {
          const result = await backupDatabase(db, dest);
          send(res, 200, {
            ok: true,
            totalPages: result.totalPages,
            manifest: {
              formatVersion: result.manifest.formatVersion,
              appVersion: result.manifest.appVersion,
              schemaVersion: result.manifest.schemaVersion,
              includedCategories: result.manifest.includedCategories,
            },
          });
        } catch (err) {
          if (err instanceof BackupValidationError) {
            send(res, 400, { error: err.code });
            return;
          }
          send(res, 500, { error: 'backup_failed' });
        }
      })
      .catch(() => send(res, 400, { error: 'invalid_body' }));
    return;
  }

  // Restore the live database from a previously exported backup file. Only
  // available when the server was started against a real database file
  // (never for the in-memory db used in tests that don't opt in via dbPath).
  if (method === 'POST' && path === '/api/restore') {
    if (!opts.dbPath) {
      send(res, 400, { error: 'restore_unsupported' });
      return;
    }
    return readJsonBody(req, MAX_PATH_BODY_BYTES)
      .then(async (body) => {
        const source = readPathField(body);
        if (!source) {
          send(res, 400, { error: 'invalid_path' });
          return;
        }
        if ((body as { confirmed?: unknown }).confirmed !== true) {
          send(res, 409, { error: 'restore_confirmation_required' });
          return;
        }
        if (state.restoreInProgress) {
          send(res, 409, { error: 'restore_in_progress' });
          return;
        }
        state.restoreInProgress = true;
        try {
          // Stop admitting new work and wait for every request that began
          // before this restore to finish before the live handle is
          // checkpointed and swapped.
          await waitForExclusiveRequest(state);
          const restored = await (opts.restoreDatabaseFn ?? restoreDatabaseWithReport)(
            opts.db,
            opts.dbPath!,
            source,
          );
          opts.db = restored.database;
          send(res, 200, { ok: true, report: restored.report });
        } catch (error) {
          let status = 400;
          let code = 'restore_failed';
          if (error instanceof RestoreValidationError) {
            code = error.code;
          } else if (error instanceof RestoreDatabaseError) {
            status = 500;
            code = error.code;
            if (error.recoveredDatabase) {
              opts.db = error.recoveredDatabase;
            } else {
              state.databaseAvailable = false;
              code = 'database_unavailable';
            }
          }
          if (!opts.db.open) {
            state.databaseAvailable = false;
            status = 500;
            code = 'database_unavailable';
          }
          send(res, status, { error: code });
        } finally {
          state.restoreInProgress = false;
        }
      })
      .catch(() => send(res, 400, { error: 'invalid_body' }));
    return;
  }

  send(res, 404, { error: 'not_found' });
}

function sendBasemapTile(res: ServerResponse, tile: BasemapTile): void {
  if (tile.state !== 'ok') {
    const statuses: Record<Exclude<BasemapTile['state'], 'ok'>, number> = {
      unavailable: 404,
      not_found: 404,
      too_large: 413,
      invalid: 400,
    };
    const errors: Record<Exclude<BasemapTile['state'], 'ok'>, string> = {
      unavailable: 'basemap_unavailable',
      not_found: 'tile_not_found',
      too_large: 'tile_too_large',
      invalid: 'invalid_tile',
    };
    send(res, statuses[tile.state], { error: errors[tile.state] });
    return;
  }

  securityHeaders(res);
  res.writeHead(200, {
    'Content-Type': tile.contentType,
    'Content-Length': tile.data.byteLength,
  });
  res.end(tile.data);
}

function fetchSiteAllowed(value: string | string[] | undefined): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return false;
  return ['same-origin', 'same-site', 'none'].includes(value.trim().toLowerCase());
}

function readPathField(body: unknown): string | undefined {
  const p = (body as { path?: unknown } | null)?.path;
  return typeof p === 'string' && p.trim() !== '' ? p : undefined;
}

function folderErrorCode(err: unknown): string {
  if (err instanceof FolderImportError) {
    return err.code === 'inside_checkout' ? 'path_inside_checkout' : err.code;
  }
  return 'folder_import_failed';
}

function folderErrorStatus(err: unknown): number {
  return err instanceof FolderImportError ? 400 : 500;
}

function decodeFiles(body: unknown): ImportFile[] {
  const list = (body as { files?: { name?: unknown; dataBase64?: unknown }[] }).files;
  if (!Array.isArray(list)) return [];
  const out: ImportFile[] = [];
  for (const f of list) {
    if (typeof f?.name !== 'string' || typeof f?.dataBase64 !== 'string') continue;
    out.push({ name: f.name, data: Buffer.from(f.dataBase64, 'base64') });
  }
  return out;
}

/** Rolling 7/28/90-day + weekly aggregates for the dashboard (ANA-007 subset). */
function buildTrends(db: Database, now: () => number) {
  const repo = new Repository(db);
  const workouts = repo.listWorkouts();
  const rides = workouts.map((w) => {
    const a = getOrComputeAnalytics(db, w.id, now());
    return {
      id: w.id,
      startUtc: w.start_utc,
      durationS: w.duration_s,
      distanceM: a?.distanceM ?? null,
      avgHr: a?.heartRate.avg ?? null,
      avgSpeedMs: a?.avgSpeedMs ?? null,
      efficiency: a?.efficiency ?? null,
      zones: a?.zones ?? null,
      elevationGainM: a?.elevation.gainM ?? null,
    };
  });

  // ISO-week buckets keyed by the Monday date (UTC) of each ride's week.
  const weeks = new Map<
    string,
    { weekStartUtc: number; rideCount: number; distanceM: number; durationS: number }
  >();
  for (const r of rides) {
    const d = new Date(r.startUtc);
    const day = (d.getUTCDay() + 6) % 7;
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    const key = new Date(monday).toISOString().slice(0, 10);
    const bucket = weeks.get(key) ?? {
      weekStartUtc: monday,
      rideCount: 0,
      distanceM: 0,
      durationS: 0,
    };
    bucket.rideCount++;
    bucket.distanceM += r.distanceM ?? 0;
    bucket.durationS += r.durationS;
    weeks.set(key, bucket);
  }

  return {
    rides,
    weekly: [...weeks.values()].sort((a, b) => a.weekStartUtc - b.weekStartUtc),
  };
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        rejectOnce(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        settled = true;
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('aborted', () => rejectOnce(new Error('request_aborted')));
    req.on('close', () => {
      if (!req.complete) rejectOnce(new Error('request_closed'));
    });
    req.on('error', (error) => rejectOnce(error));
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res: ServerResponse, staticDir: string | undefined, path: string): void {
  securityHeaders(res);
  if (!staticDir) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Velograph API. Web client not built.');
    return;
  }
  const rel = normalize(path).replace(/^([/\\])+/, '');
  let file = join(staticDir, rel);
  if (!file.startsWith(normalize(staticDir))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(staticDir, 'index.html'); // SPA fallback
    if (!existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(file));
}
