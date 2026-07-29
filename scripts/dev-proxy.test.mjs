import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PREFERRED_API_PORT = 5123;
const PREFERRED_WEB_PORT = 5124;

async function availablePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const probe = createNetServer();
      probe.once('error', () => resolve(null));
      probe.listen(port, HOST, () => {
        const address = probe.address();
        const selected = typeof address === 'object' && address ? address.port : null;
        probe.close(() => resolve(selected));
      });
    });
  return (await tryPort(preferred)) ?? (await tryPort(0));
}

async function waitForProxy(url, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error('vite_exited_before_ready');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Expected while Vite starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('vite_proxy_not_ready');
}

async function waitForPortsClosed(ports) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const probes = await Promise.all(ports.map((port) => availablePort(port)));
    if (probes.every((port, index) => port === ports[index])) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('development_process_left_listener');
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
}

let devProcess;
let dataDir;
let apiPort;
let webPort;
let webOrigin;

beforeAll(async () => {
  apiPort = await availablePort(PREFERRED_API_PORT);
  webPort = await availablePort(PREFERRED_WEB_PORT);
  if (apiPort == null || webPort == null || apiPort === webPort) {
    throw new Error('development_ports_unavailable');
  }
  dataDir = await mkdtemp(join(tmpdir(), 'velograph-dev-proxy-'));
  devProcess = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'dev.mjs')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      VELO_DATA_DIR: dataDir,
      VELO_PORT: String(apiPort),
      VELO_DEV_API_PORT: String(apiPort),
      VELO_DEV_WEB_PORT: String(webPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  devProcess.stdout?.resume();
  devProcess.stderr?.resume();
  webOrigin = `http://${HOST}:${webPort}`;
  await waitForProxy(`${webOrigin}/api/health`, devProcess);
}, 20_000);

afterAll(async () => {
  if (devProcess) await stopChild(devProcess);
  if (apiPort && webPort) await waitForPortsClosed([apiPort, webPort]);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('root development coordinator and real Vite proxy', () => {
  it('passes GET and mutating requests through the strict loopback API', async () => {
    const health = await fetch(`${webOrigin}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const settings = await fetch(`${webOrigin}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: webOrigin,
        'x-velograph-request': '1',
      },
      body: JSON.stringify({ settings: { timeZone: 'Etc/UTC' } }),
    });
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ settings: { timeZone: 'Etc/UTC' } });
  });

  it('does not rewrite an untrusted Origin into an allowed proxy origin', async () => {
    const response = await fetch(`${webOrigin}/api/settings`, {
      headers: { Origin: 'https://untrusted.invalid' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin_not_allowed' });
  });
});
