import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { databasePath, openDatabase, resolveDataDir } from '@velograph/db';
import { createApiServer } from './server.ts';

const dataDir = resolveDataDir();
const dbPath = databasePath(dataDir);
const db = openDatabase(dbPath);
const port = Number(process.env['VELO_PORT'] ?? 5123);
const host = process.env['VELO_HOST'] ?? '127.0.0.1';

if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  // Non-loopback binding requires authentication before release (PRD §11.3).
  console.error('Refusing non-loopback bind: authentication is not implemented yet.');
  process.exit(1);
}

const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const server = createApiServer({
  db,
  dbPath,
  ...(existsSync(webDist) ? { staticDir: webDist } : {}),
});
server.listen(port, host, () => {
  console.log(
    `Velograph listening on http://${host}:${port} (data dir configured via VELO_DATA_DIR)`,
  );
});

/**
 * Graceful shutdown (issue #51): stop accepting new connections, close the
 * database, then exit. A real terminal Ctrl-C delivers SIGINT to every
 * process in the foreground process group at once — this process included,
 * not just `scripts/app.mjs dev`'s wrapper — so handling the signal
 * directly here, rather than relying solely on the wrapper to forward it,
 * is what actually guarantees the port is released. `server.close()` waits
 * for in-flight requests to finish but stops accepting new ones; a short
 * watchdog forces the exit if something keeps a connection open.
 */
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Velograph: ${reason}, shutting down…`);
  const forceExit = setTimeout(() => process.exit(1), 3000);
  forceExit.unref();
  server.close(() => {
    try {
      db.close();
    } catch {
      // Already closed, or closing failed — nothing more to safely do.
    }
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('received SIGINT'));
process.on('SIGTERM', () => shutdown('received SIGTERM'));

/**
 * Parent-liveness watchdog, active only when `scripts/app.mjs dev` spawns
 * this process (it sets VELO_EXIT_WITH_PARENT_PID to its own pid). A killed
 * (SIGKILL), crashed, or otherwise-uncooperative parent cannot run any
 * cleanup code of its own — the signal handlers above cannot help in that
 * case, because they never run. The only reliable way to avoid this process
 * outliving its parent and holding the port is to notice independently:
 * poll whether the parent pid still exists and shut down the moment it
 * doesn't. `app:start`'s detached background server does not set this
 * variable and is unaffected — it is meant to outlive the shell that
 * started it.
 */
const watchParentPid = Number(process.env['VELO_EXIT_WITH_PARENT_PID'] ?? '');
if (Number.isInteger(watchParentPid) && watchParentPid > 0) {
  const watchdog = setInterval(() => {
    try {
      process.kill(watchParentPid, 0); // signal 0: existence check only
    } catch (err) {
      // ESRCH: the parent is gone. EPERM (exists, different user) or any
      // other error is inconclusive — assume the parent is still alive
      // rather than shut down on a false positive.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        clearInterval(watchdog);
        shutdown('parent process exited');
      }
    }
  }, 1000);
  watchdog.unref(); // never itself the reason this process stays alive
}
