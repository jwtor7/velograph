import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { databasePath, openDatabase, resolveDataDir, type Database } from '@velograph/db';
import { createApiServer, type VelographApiServer } from './server.ts';
import { createShutdownCoordinator } from './shutdown-coordinator.ts';
import { shutdownApiServer } from './shutdown.ts';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5123;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ApiRuntimeConfig {
  host: string;
  port: number;
}

class ApiConfigurationError extends Error {
  readonly field: 'host' | 'port';

  constructor(field: 'host' | 'port') {
    super(`invalid_${field}`);
    this.name = 'ApiConfigurationError';
    this.field = field;
  }
}

/**
 * Parse only lexical configuration. Callers must do this before resolving a
 * data directory because that operation may create a directory.
 */
export function readApiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ApiRuntimeConfig {
  const host = env['VELO_HOST'] ?? DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(host)) throw new ApiConfigurationError('host');

  const rawPort = env['VELO_PORT'] ?? String(DEFAULT_PORT);
  if (!/^(?:0|[1-9]\d{0,4})$/.test(rawPort)) throw new ApiConfigurationError('port');
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new ApiConfigurationError('port');
  }
  return { host, port };
}

function configuredParentPid(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env['VELO_EXIT_WITH_PARENT_PID'];
  if (!raw || !/^[1-9]\d*$/.test(raw)) return undefined;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

/** Prefer the web client copied beside the packaged runtime. */
export function resolveWebDist(moduleUrl = import.meta.url): string | undefined {
  const runtimeDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(runtimeDirectory, 'web'),
    join(runtimeDirectory, '..', '..', 'web', 'dist'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
}

function closeDatabaseWithoutThrow(db: Database | undefined): void {
  if (!db?.open) return;
  try {
    db.close();
  } catch {
    // Preserve the startup failure; paths from a cleanup error stay private.
  }
}

function listen(server: VelographApiServer, config: ApiRuntimeConfig): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('listen_address_unavailable'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let config: ApiRuntimeConfig;
  try {
    config = readApiRuntimeConfig(env);
  } catch (error) {
    if (error instanceof ApiConfigurationError && error.field === 'host') {
      console.error('Refusing non-loopback bind: authentication is not implemented yet.');
    } else {
      console.error('Refusing invalid port.');
    }
    return 1;
  }

  let db: Database | undefined;
  let server: VelographApiServer;
  try {
    const dataDir = resolveDataDir(env);
    const dbPath = databasePath(dataDir);
    db = openDatabase(dbPath);
    const basemapOverride = env['VELO_BASEMAP_PATH']?.trim();
    const basemapPath = basemapOverride || join(dataDir, 'basemap.mbtiles');
    const staticDir = resolveWebDist();
    server = createApiServer({
      db,
      dbPath,
      basemapPath,
      basemapPathRequired: Boolean(basemapOverride),
      log: (record) => console.log(JSON.stringify(record)),
      ...(staticDir ? { staticDir } : {}),
    });
  } catch (error) {
    closeDatabaseWithoutThrow(db);
    throw error;
  }

  let boundPort: number;
  try {
    boundPort = await listen(server, config);
  } catch (error) {
    try {
      await shutdownApiServer(server);
    } catch {
      // Keep the original create/listen failure as the public failure.
    }
    throw error;
  }

  const shutdown = createShutdownCoordinator({
    shutdown: () => shutdownApiServer(server),
    exit: (code) => process.exit(code),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  process.on('SIGINT', () => shutdown('received SIGINT'));
  process.on('SIGTERM', () => shutdown('received SIGTERM'));
  server.on('error', () => shutdown('server error'));

  /**
   * A foreground lifecycle parent may die without forwarding a signal. The
   * child independently observes that exact PID and drains itself. Detached
   * app:start processes do not receive this environment value.
   */
  const watchParentPid = configuredParentPid(env);
  if (watchParentPid !== undefined) {
    const watchdog = setInterval(() => {
      try {
        process.kill(watchParentPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          clearInterval(watchdog);
          shutdown('parent process exited');
        }
      }
    }, 1000);
    watchdog.unref();
  }

  console.log(
    `Velograph listening on http://${config.host}:${boundPort} (data dir configured via VELO_DATA_DIR)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('Server failed: unexpected_error');
      process.exitCode = 1;
    },
  );
}
