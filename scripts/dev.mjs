#!/usr/bin/env node
/**
 * One foreground development command for the built API and live Vite UI.
 * The coordinator owns both exact children and gives the API's ten-second
 * drain/checkpoint deadline twelve seconds before escalation.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_ENTRY = join(REPO_ROOT, 'apps', 'api', 'dist', 'velograph-api.mjs');
const HOST = '127.0.0.1';
const FORCE_STOP_MS = 12_000;

function readPort(raw, fallback, name) {
  const value = raw ?? String(fallback);
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

function buildApiRuntime() {
  execFileSync('pnpm', ['--filter', '@velograph/web', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  execFileSync('pnpm', ['--filter', '@velograph/api', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

async function main() {
  let apiPort;
  let webPort;
  try {
    apiPort = readPort(process.env['VELO_PORT'], 5123, 'VELO_PORT');
    webPort = readPort(process.env['VELO_DEV_WEB_PORT'], 5124, 'VELO_DEV_WEB_PORT');
  } catch {
    console.error('Development ports must be integers from 1 to 65535.');
    return 2;
  }
  if (apiPort === webPort) {
    console.error('VELO_PORT and VELO_DEV_WEB_PORT must use different ports.');
    return 2;
  }

  try {
    buildApiRuntime();
  } catch {
    console.error('Unable to build the Velograph development runtime.');
    return 1;
  }

  const webRequire = createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'));
  const viteModule = webRequire.resolve('vite');
  const viteEntry = join(dirname(viteModule), '..', '..', 'bin', 'vite.js');
  const commonEnvironment = {
    ...process.env,
    VELO_HOST: HOST,
    VELO_PORT: String(apiPort),
    VELO_DEV_API_PORT: String(apiPort),
    VELO_DEV_WEB_PORT: String(webPort),
  };

  function start(label, entry, cwd, extraEnvironment = {}) {
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: { ...commonEnvironment, ...extraEnvironment },
      stdio: 'inherit',
    });
    const completion = new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      child.once('error', (error) => finish({ label, code: 1, error }));
      child.once('exit', (code, signal) => finish({ label, code, signal }));
    });
    return { child, completion };
  }

  const services = [
    start('api', API_ENTRY, REPO_ROOT, {
      VELO_EXIT_WITH_PARENT_PID: String(process.pid),
    }),
    start('web', viteEntry, join(REPO_ROOT, 'apps', 'web')),
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
    forceStopTimer = setTimeout(() => signalRunning('SIGKILL'), FORCE_STOP_MS);
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

  console.log(`Velograph development UI: http://${HOST}:${webPort}`);
  console.log(`Velograph development API: http://${HOST}:${apiPort}`);

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

  return (
    requestedExitCode ?? (unexpectedExit || first.error || first.code == null ? 1 : first.code)
  );
}

process.exitCode = await main();
