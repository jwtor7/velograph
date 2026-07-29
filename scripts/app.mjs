#!/usr/bin/env node
/**
 * Local app lifecycle: start / stop / status / restart / dev (issue #49,
 * dev mode added in #51).
 *
 * Exists because there was previously no supported way to tell whether a
 * Velograph server was running, which port it held, or which data directory
 * it was serving. Stale servers running pre-rebuild code caused real
 * confusion: a freshly built web client was served by an older API whose
 * endpoints did not exist yet.
 *
 * `start`/`stop`/`status`/`restart` run the API detached, in the
 * background, and outlive the invoking shell — useful for leaving a server
 * up across sessions, but it's easy to forget one is still running against
 * stale code. `dev` is the alternative: it runs the API in the foreground
 * of the current shell, so Ctrl-C (SIGINT) or a `kill` (SIGTERM) tears the
 * whole thing down immediately, with nothing left holding the port.
 *
 * No dependencies. Process discovery is by listening port rather than a
 * pidfile, so a server started by any means (this script, `pnpm --filter`,
 * an editor task) is still found and reported.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, tmpdir } from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env['VELO_PORT'] ?? 5123);
const HOST = '127.0.0.1';
const LOG_PATH = join(tmpdir(), `velograph-server-${PORT}.log`);

/** Resolve the data directory the same way packages/db does, without importing it. */
function resolveDataDir() {
  const fromEnv = process.env['VELO_DATA_DIR'];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  if (platform() === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'velograph');
  if (platform() === 'win32') {
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'velograph');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'velograph');
}

/** PID listening on PORT, or null. Returns null (never throws) when unsupported. */
function listenerPid() {
  if (platform() === 'win32') return null; // documented gap; use Task Manager
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number(out.split('\n').filter(Boolean)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // lsof exits non-zero when nothing matches
  }
}

async function fetchJson(path) {
  try {
    const res = await fetch(`http://${HOST}:${PORT}${path}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function status() {
  const pid = listenerPid();
  const dataDir = resolveDataDir();
  if (!pid) {
    console.log('Velograph: not running');
    console.log(`  port:      ${PORT} (free)`);
    console.log(`  data dir:  ${dataDir}${existsSync(dataDir) ? '' : ' (not created yet)'}`);
    console.log('\nStart it with: pnpm app:start');
    return 0;
  }
  const workouts = await fetchJson('/api/workouts');
  const settings = await fetchJson('/api/settings');
  console.log('Velograph: running');
  console.log(`  url:       http://${HOST}:${PORT}`);
  console.log(`  pid:       ${pid}`);
  console.log(`  data dir:  ${dataDir}`);
  console.log(
    `  rides:     ${workouts ? workouts.workouts.length : 'unknown (API not responding)'}`,
  );
  if (settings?.settings?.timeZone) console.log(`  timezone:  ${settings.settings.timeZone}`);
  console.log(`  log:       ${LOG_PATH}`);
  return 0;
}

function buildWeb() {
  console.log('Building web client…');
  execFileSync('pnpm', ['--filter', '@velograph/web', 'build'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function start() {
  const existing = listenerPid();
  if (existing) {
    console.error(`Velograph is already running on port ${PORT} (pid ${existing}).`);
    console.error('Use `pnpm app:restart` to pick up code changes, or `pnpm app:status`.');
    return 1;
  }
  buildWeb();
  const log = openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [join(REPO_ROOT, 'apps', 'api', 'src', 'main.ts')], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();

  // Wait for the port to actually accept a request before claiming success.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await fetchJson('/api/health')) {
      console.log(`Velograph running at http://${HOST}:${PORT}`);
      console.log(`  data dir: ${resolveDataDir()}`);
      console.log(`  log:      ${LOG_PATH}`);
      return 0;
    }
  }
  console.error(`Server did not become ready within 10s. Check the log: ${LOG_PATH}`);
  return 1;
}

/** Open `url` in the OS default browser. Best-effort — never fatal. */
function openBrowser(url) {
  const plat = platform();
  const [cmd, args] =
    plat === 'darwin'
      ? ['open', [url]]
      : plat === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

/**
 * Foreground dev mode (issue #51): build the web client, run the API in the
 * foreground (inherited stdio, no detach), open the browser once it
 * answers, and tear the child down on Ctrl-C. One command starts
 * everything; killing it tears everything down — no separate `app:stop`
 * needed, and nothing is left holding the port after Ctrl-C.
 */
async function dev() {
  const existing = listenerPid();
  if (existing) {
    console.error(`Velograph is already running on port ${PORT} (pid ${existing}).`);
    console.error('Stop it first with `pnpm app:stop`, or inspect it with `pnpm app:status`.');
    return 1;
  }
  buildWeb();
  console.log(`Starting Velograph on http://${HOST}:${PORT} (foreground; Ctrl-C to stop)…`);

  const child = spawn(process.execPath, [join(REPO_ROOT, 'apps', 'api', 'src', 'main.ts')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  let exited = false;
  let exitCode = 0;
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
    child.on('error', () => {
      exited = true;
      exitCode = 1;
      resolve();
    });
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (exited || shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, stopping Velograph…`);
    child.kill('SIGTERM');
    // Belt-and-braces: if the child ignores SIGTERM, force it so nothing is
    // ever left holding the port.
    const killer = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 5000);
    killer.unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Open the browser once the API actually answers, without blocking
  // shutdown handling above.
  void (async () => {
    for (let i = 0; i < 40 && !exited; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await fetchJson('/api/health')) {
        openBrowser(`http://${HOST}:${PORT}`);
        return;
      }
    }
  })();

  await exitPromise;
  // A requested Ctrl-C/SIGTERM shutdown is success, not failure, even
  // though the child's own exit is signal-terminated (code null) — don't
  // surface that as a nonzero exit for an intentional, clean stop.
  return shuttingDown ? 0 : exitCode;
}

async function stop() {
  const pid = listenerPid();
  if (!pid) {
    console.log(`Velograph is not running (port ${PORT} is free). Nothing to stop.`);
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!listenerPid()) {
      console.log(`Stopped Velograph (pid ${pid}).`);
      return 0;
    }
  }
  process.kill(pid, 'SIGKILL');
  console.log(`Force-stopped Velograph (pid ${pid}).`);
  return 0;
}

const COMMANDS = { start, stop, status, dev, restart: async () => (await stop()) || start() };

const cmd = process.argv[2] ?? 'status';
const fn = COMMANDS[cmd];
if (!fn) {
  console.error(`Unknown command "${cmd}". Use: ${Object.keys(COMMANDS).join(' | ')}`);
  process.exit(2);
}
process.exit(await fn());
