import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Database } from '@velograph/db';
import {
  Repository,
  RestoreDatabaseError,
  RestoreValidationError,
  backupDatabase,
  loadWorkoutData,
  restoreDatabase,
} from '@velograph/db';
import { inventoryFiles, runImport, type ImportFile } from '@velograph/importers';
import {
  getOrComputeAnalytics,
  loadSettings,
  repairWorkout,
  saveSettings,
} from './analytics-service.ts';

export const API_VERSION = '0.1.0';
const MAX_IMPORT_BODY_BYTES = 600 * 1024 * 1024; // base64-encoded uploads
const MAX_PATH_BODY_BYTES = 8 * 1024;

/**
 * Loopback-only HTTP API (PRD §11.3, §12.3).
 *
 * Hardening, even though we bind 127.0.0.1:
 *  - Host header must be a loopback host with our port.
 *  - Origin, when present, must be a loopback origin with our port
 *    (blocks cross-site requests from other local servers and the web).
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
  now?: () => number;
  /** @internal Deterministic seam for restore/shutdown integration tests. */
  restoreDatabaseFn?: typeof restoreDatabase;
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
      const operation = handle(req, res, opts, now, server, state);
      if (operation) {
        operationPending = true;
        void operation
          .catch(() => send(res, 500, { error: 'internal_error' }))
          .finally(() => {
            operationPending = false;
            finishRequest();
          });
      }
    } catch {
      send(res, 500, { error: 'internal_error' });
    }
  });
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
    return route(req, res, opts, url, method, now, state);
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
): void | Promise<void> {
  const db = opts.db;
  const path = url.pathname;

  if (method === 'GET' && path === '/api/health') {
    send(res, 200, { ok: true, version: API_VERSION });
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
        const s = (body as { settings?: unknown }).settings;
        if (!s || typeof s !== 'object') {
          send(res, 400, { error: 'invalid_settings' });
          return;
        }
        saveSettings(db, { ...loadSettings(db), ...(s as object) });
        send(res, 200, { settings: loadSettings(db) });
      })
      .catch(() => send(res, 400, { error: 'invalid_body' }));
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
          send(res, 200, { ok: true, totalPages: result.totalPages });
        } catch (err) {
          const insideCheckout = err instanceof Error && /checkout/.test(err.message);
          send(res, insideCheckout ? 400 : 500, {
            error: insideCheckout ? 'destination_inside_checkout' : 'backup_failed',
          });
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
          const restored = await (opts.restoreDatabaseFn ?? restoreDatabase)(
            opts.db,
            opts.dbPath!,
            source,
          );
          opts.db = restored;
          send(res, 200, { ok: true });
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

function readPathField(body: unknown): string | undefined {
  const p = (body as { path?: unknown } | null)?.path;
  return typeof p === 'string' && p.trim() !== '' ? p : undefined;
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
