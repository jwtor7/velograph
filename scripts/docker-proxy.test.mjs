import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const proxyPath = join(repositoryRoot, 'docker-proxy.mjs');
const host = '127.0.0.1';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function rawRequest(port, { hosts = [], origins = [], version = '1.1' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, host, () => {
      const headers = [
        ...hosts.map((value) => `Host: ${value}`),
        ...origins.map((value) => `Origin: ${value}`),
        'Connection: close',
      ];
      socket.write(`GET /api/health HTTP/${version}\r\n${headers.join('\r\n')}\r\n\r\n`);
    });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => {
      const [head, body = ''] = response.split('\r\n\r\n', 2);
      const lines = head.split('\r\n');
      const status = Number(lines[0]?.split(' ')[1]);
      const headers = Object.fromEntries(
        lines.slice(1).map((line) => {
          const separator = line.indexOf(':');
          return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
        }),
      );
      resolve({ body, headers, status });
    });
    socket.on('error', reject);
  });
}

async function waitForProxy(port, child, output) {
  const deadline = Date.now() + 5000;
  let lastAttempt = 'no_connection_attempt_completed';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`docker_proxy_exited_before_ready\n${output()}`);
    }
    try {
      const response = await rawRequest(port, { hosts: [`127.0.0.1:${port}`] });
      if (response.status === 200) return;
      lastAttempt = JSON.stringify(response);
    } catch (error) {
      lastAttempt = error instanceof Error ? error.message : String(error);
    }
    await delay(20);
  }
  throw new Error(`docker_proxy_not_ready\n${lastAttempt}\n${output()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(5000).then(() => false),
  ]);
  if (!exited) child.kill('SIGKILL');
}

let internalServer;
let internalPort;
let proxyPort;
let proxyProcess;
let proxyOutput = '';
let upstreamRequests = [];

beforeAll(async () => {
  internalServer = createHttpServer((request, response) => {
    const received = {
      host: request.headers.host,
      origin: request.headers.origin,
    };
    upstreamRequests.push(received);
    const body = JSON.stringify(received);
    response.writeHead(200, {
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    internalServer.once('error', reject);
    internalServer.listen(0, host, resolve);
  });
  const address = internalServer.address();
  internalPort = typeof address === 'object' && address ? address.port : null;
  proxyPort = await availablePort();
  if (internalPort === null || proxyPort === null) throw new Error('proxy_test_ports_unavailable');

  proxyProcess = spawn(process.execPath, [proxyPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      VELO_INTERNAL_PORT: String(internalPort),
      VELO_PROXY_HOST: host,
      VELO_PROXY_PORT: String(proxyPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxyProcess.stdout?.on('data', (chunk) => {
    proxyOutput += chunk.toString();
  });
  proxyProcess.stderr?.on('data', (chunk) => {
    proxyOutput += chunk.toString();
  });
  await waitForProxy(proxyPort, proxyProcess, () => proxyOutput);
  upstreamRequests = [];
}, 10_000);

afterAll(async () => {
  await stopChild(proxyProcess);
  if (internalServer) {
    internalServer.closeAllConnections();
    await new Promise((resolve, reject) => {
      internalServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
}, 10_000);

describe('container ingress proxy authority validation', () => {
  it.each([
    ['IPv4', '127.0.0.1:43121', 'http://127.0.0.1:43121'],
    ['localhost', 'LOCALHOST:43122', 'http://localhost:43122'],
    ['bracketed IPv6', '[::1]:43123', 'http://[::1]:43123'],
    ['default HTTP port', 'localhost', 'http://localhost'],
  ])('allows a lexical loopback %s Host', async (_label, publishedHost, origin) => {
    const response = await rawRequest(proxyPort, {
      hosts: [publishedHost],
      origins: [origin],
    });

    expect(response.status, proxyOutput).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      host: `127.0.0.1:${internalPort}`,
      origin: `http://127.0.0.1:${internalPort}`,
    });
  });

  it.each([
    'rebind.invalid:43121',
    '127.0.0.2:43121',
    'rider.localhost:43121',
    'localhost.:43121',
    '[0:0:0:0:0:0:0:1]:43121',
    'localhost:0',
    'localhost:65536',
    'localhost:not-a-port',
  ])('rejects the non-allowlisted or malformed Host %s without forwarding it', async (value) => {
    const forwardedBefore = upstreamRequests.length;
    const response = await rawRequest(proxyPort, { hosts: [value] });

    expect(response.status, proxyOutput).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe('{"error":"host_not_allowed"}');
    expect(upstreamRequests).toHaveLength(forwardedBefore);
  });

  it('rejects missing, comma-combined, and duplicate Host values', async () => {
    const cases = [
      { hosts: [], version: '1.0' },
      { hosts: ['localhost:43121, rebind.invalid:43121'] },
      { hosts: ['localhost:43121', 'localhost:43121'] },
      { hosts: ['localhost:43121', 'rebind.invalid:43121'] },
    ];

    for (const request of cases) {
      const forwardedBefore = upstreamRequests.length;
      const response = await rawRequest(proxyPort, request);
      expect(response.status, proxyOutput).toBe(403);
      expect(response.body).toBe('{"error":"host_not_allowed"}');
      expect(upstreamRequests).toHaveLength(forwardedBefore);
    }
  });

  it.each([
    ['a different loopback port', 'http://localhost:43122'],
    ['a different loopback name', 'http://127.0.0.1:43121'],
    ['a non-HTTP scheme', 'https://localhost:43121'],
    ['a malformed serialized origin', 'http://localhost:43121/path'],
  ])('rejects Origin from %s without forwarding it', async (_label, origin) => {
    const forwardedBefore = upstreamRequests.length;
    const response = await rawRequest(proxyPort, {
      hosts: ['localhost:43121'],
      origins: [origin],
    });

    expect(response.status, proxyOutput).toBe(403);
    expect(response.body).toBe('{"error":"origin_not_allowed"}');
    expect(upstreamRequests).toHaveLength(forwardedBefore);
  });

  it('rejects an Origin matching the internal API authority after Host rewriting', async () => {
    const forwardedBefore = upstreamRequests.length;
    const response = await rawRequest(proxyPort, {
      hosts: ['localhost:43121'],
      origins: [`http://127.0.0.1:${internalPort}`],
    });

    expect(response.status, proxyOutput).toBe(403);
    expect(response.body).toBe('{"error":"origin_not_allowed"}');
    expect(upstreamRequests).toHaveLength(forwardedBefore);
  });

  it('rejects duplicate Origin values without forwarding them', async () => {
    const forwardedBefore = upstreamRequests.length;
    const response = await rawRequest(proxyPort, {
      hosts: ['localhost:43121'],
      origins: ['http://localhost:43121', 'http://localhost:43121'],
    });

    expect(response.status, proxyOutput).toBe(403);
    expect(response.body).toBe('{"error":"origin_not_allowed"}');
    expect(upstreamRequests).toHaveLength(forwardedBefore);
  });
});
