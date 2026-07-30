#!/usr/bin/env node
/**
 * Identity-safe local app lifecycle: start / stop / status / restart / dev.
 *
 * Every supported mode builds and runs the packaged API launcher. A listening
 * port is never enough to identify Velograph: health, PID, and the exact
 * built-entrypoint command must agree.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, platform, tmpdir } from 'node:os';
import { buildApiRuntime } from './build-api-runtime.mjs';
import { openBrowser } from './open-browser.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 5123;
const STOP_GRACE_MS = 12_000;
const STOP_POLL_MS = 200;
const START_TIMEOUT_MS = 20_000;
const LOG_SINK_READY_TIMEOUT_MS = 5000;
export const MAX_SERVER_LOG_BYTES = 5 * 1024 * 1024;
export const MIN_SERVER_LOG_BYTES = 64 * 1024;
export const MAX_CONFIGURABLE_SERVER_LOG_BYTES = 100 * 1024 * 1024;
const API_ENTRYPOINT = join(REPO_ROOT, 'apps', 'api', 'dist', 'velograph-api.mjs');
const LOG_SINK_ENTRYPOINT = join(REPO_ROOT, 'scripts', 'server-log-sink.mjs');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

export function readManagedPort(raw = process.env['VELO_PORT'] ?? String(DEFAULT_PORT)) {
  if (!/^[1-9]\d{0,4}$/.test(raw)) {
    throw new Error('invalid_port');
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error('invalid_port');
  return port;
}

export function readManagedLogMaxBytes(
  raw = process.env['VELO_LOG_MAX_BYTES'] ?? String(MAX_SERVER_LOG_BYTES),
) {
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('invalid_log_limit');
  const maxBytes = Number(raw);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < MIN_SERVER_LOG_BYTES ||
    maxBytes > MAX_CONFIGURABLE_SERVER_LOG_BYTES
  ) {
    throw new Error('invalid_log_limit');
  }
  return maxBytes;
}

function logPath(port) {
  return join(tmpdir(), `velograph-server-${port}.log`);
}

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

/** PID listening on a port, or null. Returns null (never throws) when unsupported. */
function listenerPid(port) {
  if (platform() === 'win32') return null;
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = Number(out.split('\n').filter(Boolean)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
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

export function isExpectedVelographRuntime({
  health,
  listener,
  expectedPid,
  command,
  entrypoint = API_ENTRYPOINT,
  expectedVersion = PACKAGE_VERSION,
}) {
  return (
    health?.ok === true &&
    health.version === expectedVersion &&
    listener === expectedPid &&
    Number.isInteger(expectedPid) &&
    expectedPid > 0 &&
    isVelographCommand(command, entrypoint)
  );
}

async function fetchJson(port, path, timeoutMs = 1000) {
  try {
    const response = await fetch(`http://${HOST}:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function inspectListener(port) {
  const pid = listenerPid(port);
  if (!pid) return { pid: null, verified: false, command: null, health: null };
  const command = processCommand(pid);
  const health = isVelographCommand(command) ? await fetchJson(port, '/api/health') : null;
  return {
    pid,
    command,
    health,
    verified: isExpectedVelographRuntime({
      health,
      listener: pid,
      expectedPid: pid,
      command,
    }),
  };
}

async function status(port) {
  const inspected = await inspectListener(port);
  const dataDir = resolveDataDir();
  if (!inspected.pid) {
    console.log('Velograph: not running');
    console.log(`  port:      ${port} (free)`);
    console.log(`  data dir:  ${dataDir}${existsSync(dataDir) ? '' : ' (not created yet)'}`);
    console.log('\nStart it with: pnpm app:start');
    return 0;
  }
  if (!inspected.verified) {
    console.error(`Velograph: not verified (port ${port} is held by pid ${inspected.pid}).`);
    console.error('No process was signalled.');
    return 1;
  }

  const [workouts, settings] = await Promise.all([
    fetchJson(port, '/api/workouts', 3000),
    fetchJson(port, '/api/settings', 3000),
  ]);
  console.log('Velograph: running');
  console.log(`  url:       http://${HOST}:${port}`);
  console.log(`  pid:       ${inspected.pid}`);
  console.log(`  data dir:  ${dataDir}`);
  console.log(
    `  rides:     ${workouts ? workouts.workouts.length : 'unknown (API not responding)'}`,
  );
  if (settings?.settings?.timeZone) console.log(`  timezone:  ${settings.settings.timeZone}`);
  console.log(`  log:       ${logPath(port)}`);
  return 0;
}

function buildApp() {
  console.log('Building web client and API…');
  buildApiRuntime({ stdio: ['ignore', 'ignore', 'inherit'] });
}

function childEnvironment(port, parentPid) {
  const env = {
    ...process.env,
    VELO_HOST: HOST,
    VELO_PORT: String(port),
  };
  if (parentPid === undefined) {
    delete env['VELO_EXIT_WITH_PARENT_PID'];
  } else {
    env['VELO_EXIT_WITH_PARENT_PID'] = String(parentPid);
  }
  return env;
}

function observeChild(child) {
  let outcome;
  const completion = new Promise((resolve) => {
    const finish = (next) => {
      if (outcome !== undefined) return;
      outcome = next;
      resolve(next);
    };
    child.once('error', (error) => finish({ type: 'error', error }));
    child.once('exit', (code, signal) => finish({ type: 'exit', code, signal }));
  });
  return { completion, getOutcome: () => outcome };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function startManagedLogSink(
  path,
  { maxBytes = MAX_SERVER_LOG_BYTES, readyTimeoutMs = LOG_SINK_READY_TIMEOUT_MS } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('server_log_limit_invalid');
  }
  const child = spawn(process.execPath, [LOG_SINK_ENTRYPOINT, path, String(maxBytes)], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
  });
  const observation = observeChild(child);
  const ready = await Promise.race([
    new Promise((resolve) => {
      child.once('message', (message) => resolve(message?.type === 'ready'));
    }),
    observation.completion.then(() => false),
    delay(readyTimeoutMs).then(() => false),
  ]);
  if (!ready || !child.stdin) {
    child.stdin?.end();
    await terminateSpawnedChild(child, observation);
    throw new Error('server_log_sink_start_failed');
  }
  return { child, input: child.stdin, observation };
}

async function waitForChildReadiness(child, observation, port) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const outcome = observation.getOutcome();
    if (outcome) return { ready: false, reason: outcome.type, outcome };

    await delay(200);
    const expectedPid = child.pid;
    if (!Number.isInteger(expectedPid) || expectedPid <= 0) continue;
    const listener = listenerPid(port);
    if (listener !== null && listener !== expectedPid) {
      return { ready: false, reason: 'occupied' };
    }
    if (listener !== expectedPid) continue;
    const command = processCommand(expectedPid);
    if (!isVelographCommand(command)) continue;
    const health = await fetchJson(port, '/api/health');
    if (isExpectedVelographRuntime({ health, listener, expectedPid, command })) {
      return { ready: true };
    }
  }
  return { ready: false, reason: 'timeout' };
}

async function terminateSpawnedChild(child, observation) {
  if (observation.getOutcome()) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const graceful = await Promise.race([
    observation.completion.then(() => true),
    delay(STOP_GRACE_MS).then(() => false),
  ]);
  if (graceful || observation.getOutcome()) return;
  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  await Promise.race([observation.completion, delay(2000)]);
}

function reportStartupFailure(result, port) {
  switch (result.reason) {
    case 'error':
      console.error('Unable to start the Velograph API process.');
      break;
    case 'exit':
      console.error('Velograph API exited before it became ready.');
      break;
    case 'occupied':
      console.error(`Port ${port} became occupied by a different process during startup.`);
      break;
    default:
      console.error(
        `Server did not become ready within ${START_TIMEOUT_MS / 1000}s. Check the log: ${logPath(port)}`,
      );
  }
}

async function start(port) {
  const existing = await inspectListener(port);
  if (existing.pid) {
    if (existing.verified) {
      console.error(`Velograph is already running on port ${port} (pid ${existing.pid}).`);
      console.error('Use `pnpm app:restart` to pick up code changes, or `pnpm app:status`.');
    } else {
      console.error(`Port ${port} is held by an unverified process (pid ${existing.pid}).`);
      console.error('Velograph will not start or signal that process.');
    }
    return 1;
  }

  buildApp();
  const logSink = await startManagedLogSink(logPath(port), {
    maxBytes: readManagedLogMaxBytes(),
  });
  let child;
  try {
    child = spawn(process.execPath, [API_ENTRYPOINT], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', logSink.input, logSink.input],
      env: childEnvironment(port),
    });
  } catch (error) {
    logSink.input.end();
    await terminateSpawnedChild(logSink.child, logSink.observation);
    throw error;
  }
  // Close only the launcher's duplicate of the pipe. `end()` would issue a
  // shared write-side shutdown and cut off the detached API's descriptors.
  logSink.input.destroy();
  const observation = observeChild(child);
  const ready = await waitForChildReadiness(child, observation, port);
  if (!ready.ready || logSink.observation.getOutcome()) {
    if (ready.ready) {
      console.error('Velograph log sink exited before startup completed.');
    } else {
      reportStartupFailure(ready, port);
    }
    await terminateSpawnedChild(child, observation);
    await Promise.race([logSink.observation.completion, delay(2000)]);
    await terminateSpawnedChild(logSink.child, logSink.observation);
    return 1;
  }

  child.unref();
  logSink.child.unref();
  console.log(`Velograph running at http://${HOST}:${port}`);
  console.log(`  data dir: ${resolveDataDir()}`);
  console.log(`  log:      ${logPath(port)}`);
  return 0;
}

export async function stopProcess(
  pid,
  {
    getListenerPid = () => null,
    getProcessIdentity = processIdentity,
    getProcessCommand = processCommand,
    expectedCommand,
    kill = (target, signal) => process.kill(target, signal),
    sleep = delay,
    graceMs = STOP_GRACE_MS,
    pollMs = STOP_POLL_MS,
    forceWaitMs = 2000,
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

async function dev(port) {
  const existing = await inspectListener(port);
  if (existing.pid) {
    if (existing.verified) {
      console.error(`Velograph is already running on port ${port} (pid ${existing.pid}).`);
      console.error('Stop it first with `pnpm app:stop`, or inspect it with `pnpm app:status`.');
    } else {
      console.error(`Port ${port} is held by an unverified process (pid ${existing.pid}).`);
    }
    return 1;
  }
  buildApp();
  console.log(`Starting Velograph on http://${HOST}:${port} (foreground; Ctrl-C to stop)…`);

  const child = spawn(process.execPath, [API_ENTRYPOINT], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: childEnvironment(port, process.pid),
  });
  const observation = observeChild(child);
  let shuttingDown = false;
  let forceStopTimer;
  const shutdown = (signal) => {
    if (observation.getOutcome() || shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, stopping Velograph…`);
    child.kill('SIGTERM');
    forceStopTimer = setTimeout(() => {
      if (!observation.getOutcome()) child.kill('SIGKILL');
    }, STOP_GRACE_MS);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const ready = await waitForChildReadiness(child, observation, port);
  if (!ready.ready) {
    reportStartupFailure(ready, port);
    await terminateSpawnedChild(child, observation);
    if (forceStopTimer) clearTimeout(forceStopTimer);
    return 1;
  }
  openBrowser(`http://${HOST}:${port}`);

  const outcome = await observation.completion;
  if (forceStopTimer) clearTimeout(forceStopTimer);
  if (shuttingDown) return 0;
  return outcome.type === 'exit' && outcome.code !== null && !outcome.signal ? outcome.code : 1;
}

async function stop(port) {
  const inspected = await inspectListener(port);
  if (!inspected.pid) {
    console.log(`Velograph is not running (port ${port} is free). Nothing to stop.`);
    return 0;
  }
  if (!inspected.verified || !inspected.command) {
    console.error(
      `Refusing to stop pid ${inspected.pid}: the listener on port ${port} is not a verified Velograph API process.`,
    );
    return 1;
  }
  return stopProcess(inspected.pid, {
    expectedCommand: inspected.command,
    getListenerPid: () => listenerPid(port),
  });
}

const COMMANDS = {
  start,
  stop,
  status,
  dev,
  restart: async (port) => (await stop(port)) || start(port),
};

export async function main(argv = process.argv.slice(2)) {
  let port;
  try {
    port = readManagedPort();
  } catch {
    console.error('VELO_PORT must be an integer from 1 to 65535.');
    return 2;
  }

  const cmd = argv[0] ?? 'status';
  const command = COMMANDS[cmd];
  if (!command) {
    console.error(`Unknown command "${cmd}". Use: ${Object.keys(COMMANDS).join(' | ')}`);
    return 2;
  }
  try {
    return await command(port);
  } catch {
    console.error('Velograph lifecycle command failed.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
