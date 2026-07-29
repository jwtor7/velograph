import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Database } from '@velograph/db';
import { Repository, backupDatabase, loadWorkoutData, restoreDatabase } from '@velograph/db';
import {
  DEFAULT_MAX_GROUP_BYTES,
  DEFAULT_ZIP_LIMITS,
  FolderImportError,
  inventoryFiles,
  planFolderImport,
  previewImportFolder,
  readFolderFileGroups,
  runImport,
  runImportGroups,
  type ImportFile,
} from '@velograph/importers';
import {
  getOrComputeAnalytics,
  loadSettings,
  repairWorkout,
  saveSettings,
} from './analytics-service.ts';

export const API_VERSION = '0.1.0';
const MAX_IMPORT_BODY_BYTES = 600 * 1024 * 1024; // base64-encoded uploads
const MAX_PATH_BODY_BYTES = 8 * 1024;
const PATH_IMPORT_ZIP_LIMITS = {
  ...DEFAULT_ZIP_LIMITS,
  maxEntryBytes: DEFAULT_MAX_GROUP_BYTES,
  maxTotalBytes: DEFAULT_MAX_GROUP_BYTES,
};

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
}

export function createApiServer(opts: ApiOptions): Server {
  const now = opts.now ?? Date.now;

  const server = createServer((req, res) => {
    try {
      handle(req, res, opts, now, server);
    } catch {
      send(res, 500, { error: 'internal_error' });
    }
  });
  return server;
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
): void {
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

  if (path.startsWith('/api/')) {
    route(req, res, opts, url, method, now);
    return;
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
): void {
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
    readJsonBody(req, 1024 * 1024)
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
    readJsonBody(req, MAX_IMPORT_BODY_BYTES)
      .then((body) => {
        const files = decodeFiles(body);
        send(res, 200, { inventory: inventoryFiles(files) });
      })
      .catch(() => send(res, 400, { error: 'invalid_body' }));
    return;
  }

  if (method === 'POST' && path === '/api/import') {
    readJsonBody(req, MAX_IMPORT_BODY_BYTES)
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
  // instead of every file as base64. The API plans metadata first, then
  // reads one bounded association group at a time inside one atomic import.
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
          const plan = planFolderImport(p);
          if (plan.totalFiles === 0) {
            send(res, 400, {
              error: 'no_files',
              skipped: plan.skipped,
              truncated: plan.truncated,
            });
            return;
          }
          const result = runImportGroups(db, readFolderFileGroups(plan), {
            now: now(),
            timeZone: loadSettings(db).timeZone,
            zipLimits: PATH_IMPORT_ZIP_LIMITS,
          });
          send(res, 200, {
            result,
            skipped: plan.skipped,
            truncated: plan.truncated,
          });
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
    readJsonBody(req, MAX_PATH_BODY_BYTES)
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
    readJsonBody(req, MAX_PATH_BODY_BYTES)
      .then(async (body) => {
        const source = readPathField(body);
        if (!source) {
          send(res, 400, { error: 'invalid_path' });
          return;
        }
        try {
          const restored = await restoreDatabase(opts.db, opts.dbPath!, source);
          opts.db = restored;
          send(res, 200, { ok: true });
        } catch {
          send(res, 400, { error: 'restore_failed' });
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

function folderErrorCode(err: unknown): string {
  if (err instanceof FolderImportError) {
    return err.code === 'inside_checkout' ? 'path_inside_checkout' : err.code;
  }
  return 'folder_import_failed';
}

function folderErrorStatus(err: unknown): number {
  if (!(err instanceof FolderImportError)) return 500;
  return err.code === 'path_changed' || err.code === 'file_changed' ? 409 : 400;
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
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
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
