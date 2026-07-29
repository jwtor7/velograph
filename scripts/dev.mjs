#!/usr/bin/env node
/**
 * One foreground development command for the API and Vite UI (issue #25).
 * The coordinator owns both children: when either exits or the terminal sends
 * a signal, it terminates the other before returning.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_ENTRY = join(REPO_ROOT, 'apps', 'api', 'src', 'main.ts');
const webRequire = createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'));
const viteModule = webRequire.resolve('vite');
const VITE_ENTRY = join(dirname(viteModule), '..', '..', 'bin', 'vite.js');

function readPort(raw, fallback, name) {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

const API_PORT = readPort(process.env['VELO_PORT'], 5123, 'VELO_PORT');
const WEB_PORT = readPort(process.env['VELO_DEV_WEB_PORT'], 5124, 'VELO_DEV_WEB_PORT');
if (API_PORT === WEB_PORT) {
  throw new Error('VELO_PORT and VELO_DEV_WEB_PORT must use different ports');
}
const env = {
  ...process.env,
  VELO_PORT: String(API_PORT),
  VELO_DEV_API_PORT: String(API_PORT),
  VELO_DEV_WEB_PORT: String(WEB_PORT),
};

function start(label, entry, cwd) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env,
    stdio: 'inherit',
  });
  const completion = new Promise((resolve) => {
    child.once('error', (error) => resolve({ label, code: 1, error }));
    child.once('exit', (code, signal) => resolve({ label, code, signal }));
  });
  return { child, completion };
}

const services = [
  start('api', API_ENTRY, REPO_ROOT),
  start('web', VITE_ENTRY, join(REPO_ROOT, 'apps', 'web')),
];

let stopping = false;
let requestedExitCode = null;
let forceStopTimer = null;

function signalRunning(signal) {
  for (const service of services) {
    if (service.child.exitCode == null && service.child.signalCode == null) {
      service.child.kill(signal);
    }
  }
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  signalRunning('SIGTERM');
  forceStopTimer = setTimeout(() => signalRunning('SIGKILL'), 3_000);
  forceStopTimer.unref();
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    requestedExitCode = code;
    if (stopping) {
      signalRunning('SIGKILL');
      return;
    }
    stopAll();
  });
}

console.log(`Velograph development UI: http://127.0.0.1:${WEB_PORT}`);
console.log(`Velograph development API: http://127.0.0.1:${API_PORT}`);

const first = await Promise.race(services.map((service) => service.completion));
const unexpectedExit = !stopping;
if (!stopping) {
  if (first.error) {
    console.error(`Unable to start the ${first.label} development service.`);
  } else {
    console.error(`${first.label} development service exited unexpectedly.`);
  }
  stopAll();
}
await Promise.allSettled(services.map((service) => service.completion));
if (forceStopTimer) clearTimeout(forceStopTimer);

process.exitCode =
  requestedExitCode ?? (unexpectedExit || first.error || first.code == null ? 1 : first.code);
