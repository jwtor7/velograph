#!/usr/bin/env node
/**
 * Local app lifecycle: start / stop / status / restart (issue #49).
 *
 * Exists because there was previously no supported way to tell whether a
 * Velograph server was running, which port it held, or which data directory
 * it was serving. Stale servers running pre-rebuild code caused real
 * confusion: a freshly built web client was served by an older API whose
 * endpoints did not exist yet.
 *
 * No dependencies. Process discovery is by listening port rather than a
 * pidfile, so a server started by any means (this script, `pnpm --filter`,
 * an editor task) is still found and reported.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, platform, tmpdir } from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env['VELO_PORT'] ?? 5123);
const HOST = '127.0.0.1';
const LOG_PATH = join(tmpdir(), `velograph-server-${PORT}.log`);
const STOP_GRACE_MS = 12_000;
const STOP_POLL_MS = 200;
const API_ENTRYPOINT = join(REPO_ROOT, 'apps', 'api', 'src', 'main.ts');

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

/** Stable start-time token for a PID, or null once that exact process is gone. */
function processIdentity(pid) {
  if (platform() === 'win32') return null;
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return started ? `${pid}:${started}` : null;
  } catch {
    return null;
  }
}

function processCommand(pid) {
  if (platform() === 'win32') return null;
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isVelographCommand(command, entrypoint = API_ENTRYPOINT) {
  if (!command) return false;
  const normalizedCommand = command.replaceAll('\\', '/');
  const normalizedEntrypoint = entrypoint.replaceAll('\\', '/');
  return new RegExp(`(?:^|[\\s"'])${escapeRegExp(normalizedEntrypoint)}(?=$|[\\s"'])`).test(
    normalizedCommand,
  );
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

export async function stopProcess(
  pid,
  {
    getListenerPid = listenerPid,
    getProcessIdentity = processIdentity,
    getProcessCommand = processCommand,
    expectedCommand,
    kill = (target, signal) => process.kill(target, signal),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    graceMs = STOP_GRACE_MS,
    pollMs = STOP_POLL_MS,
    forceWaitMs = 2_000,
  } = {},
) {
  const identity = getProcessIdentity(pid);
  if (!identity) {
    if (getListenerPid() !== pid) {
      console.log(`Stopped Velograph (pid ${pid}).`);
      return 0;
    }
    console.error(
      `Cannot verify Velograph process identity for pid ${pid}; refusing to signal it.`,
    );
    return 1;
  }
  if (
    expectedCommand !== undefined &&
    (getListenerPid() !== pid ||
      getProcessCommand(pid) !== expectedCommand ||
      !isVelographCommand(expectedCommand) ||
      getProcessIdentity(pid) !== identity)
  ) {
    console.error(`Velograph process identity changed before pid ${pid} could be signalled.`);
    return 1;
  }

  try {
    kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      console.log(`Stopped Velograph (pid ${pid}).`);
      return 0;
    }
    throw error;
  }

  const attempts = Math.max(1, Math.ceil(graceMs / pollMs));
  for (let i = 0; i < attempts; i++) {
    await sleep(pollMs);
    if (getProcessIdentity(pid) !== identity) {
      console.log(`Stopped Velograph (pid ${pid}).`);
      return 0;
    }
  }

  console.error(`Velograph did not finish graceful shutdown within ${graceMs}ms; sending SIGKILL.`);
  // Recheck stable identity immediately before escalation so PID reuse can
  // never target an unrelated replacement process.
  if (getProcessIdentity(pid) !== identity) {
    console.log(`Stopped Velograph (pid ${pid}).`);
    return 0;
  }
  if (
    expectedCommand !== undefined &&
    (getProcessCommand(pid) !== expectedCommand || !isVelographCommand(expectedCommand))
  ) {
    console.error(`Velograph process identity changed before pid ${pid} could be force-stopped.`);
    return 1;
  }
  try {
    kill(pid, 'SIGKILL');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      console.log(`Force-stopped Velograph (pid ${pid}).`);
      return 0;
    }
    throw error;
  }

  const forceAttempts = Math.max(1, Math.ceil(forceWaitMs / pollMs));
  for (let i = 0; i < forceAttempts; i++) {
    await sleep(pollMs);
    if (getProcessIdentity(pid) !== identity) {
      console.log(`Force-stopped Velograph (pid ${pid}).`);
      return 0;
    }
  }
  console.error(`SIGKILL was sent to Velograph pid ${pid}, but process exit was not confirmed.`);
  return 1;
}

async function stop() {
  const pid = listenerPid();
  if (!pid) {
    console.log(`Velograph is not running (port ${PORT} is free). Nothing to stop.`);
    return 0;
  }
  const command = processCommand(pid);
  if (!isVelographCommand(command)) {
    console.error(
      `Refusing to stop pid ${pid}: the listener on port ${PORT} is not a verified Velograph API process.`,
    );
    return 1;
  }
  return stopProcess(pid, { expectedCommand: command });
}

const COMMANDS = { start, stop, status, restart: async () => (await stop()) || start() };

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] ?? 'status';
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`Unknown command "${cmd}". Use: ${Object.keys(COMMANDS).join(' | ')}`);
    return 2;
  }
  return fn();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
