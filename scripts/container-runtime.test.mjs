import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entrypointPath = join(repositoryRoot, 'docker-entrypoint.sh');
const activeSupervisors = new Set();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error(`timed_out_waiting_for_${path.split('/').at(-1)}`);
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => null),
  ]);
}

function killSupervisorGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function createFakeNode(directory) {
  const fakeNode = join(directory, 'node');
  await writeFile(
    fakeNode,
    `#!/bin/sh
set -eu

role=api
case "\${1:-}" in
  *docker-proxy.mjs) role=proxy ;;
esac

if [ "$role" = api ]; then
  behavior="\${VELO_TEST_API_BEHAVIOR:-wait}"
  sibling=proxy
else
  behavior="\${VELO_TEST_PROXY_BEHAVIOR:-wait}"
  sibling=api
fi

ready="\${VELO_TEST_MARKER_DIR}/\${role}.ready"
terminated="\${VELO_TEST_MARKER_DIR}/\${role}.terminated"
drained="\${VELO_TEST_MARKER_DIR}/\${role}.drained"
: > "$ready"

drain() {
  trap '' INT TERM
  : > "$terminated"
  sleep "\${VELO_TEST_DRAIN_SECONDS:-0.05}"
  : > "$drained"
  exit 0
}
trap drain INT TERM

case "$behavior" in
  exit:*)
    while [ ! -f "\${VELO_TEST_MARKER_DIR}/\${sibling}.ready" ]; do
      sleep 0.01
    done
    exit "\${behavior#exit:}"
    ;;
  wait)
    while :; do sleep 1; done
    ;;
  *)
    exit 97
    ;;
esac
`,
  );
  await chmod(fakeNode, 0o755);
}

async function startSupervisor({ apiBehavior = 'wait', proxyBehavior = 'wait' } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), 'velograph-container-runtime-'));
  const binDirectory = join(sandbox, 'bin');
  const markerDirectory = join(sandbox, 'markers');
  await Promise.all([mkdir(binDirectory), mkdir(markerDirectory)]);
  await createFakeNode(binDirectory);

  const child = spawn('/bin/sh', [entrypointPath], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      VELO_TEST_API_BEHAVIOR: apiBehavior,
      VELO_TEST_PROXY_BEHAVIOR: proxyBehavior,
      VELO_TEST_MARKER_DIR: markerDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeSupervisors.add(child);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  child.once('exit', () => activeSupervisors.delete(child));

  return {
    child,
    markerDirectory,
    output: () => output,
    remove: () => rm(sandbox, { force: true, recursive: true }),
  };
}

function parsedServiceScalar(compose, service, key) {
  const lines = compose.split(/\r?\n/);
  const servicesIndex = lines.findIndex((line) => line === 'services:');
  if (servicesIndex < 0) return undefined;
  const serviceIndex = lines.findIndex(
    (line, index) => index > servicesIndex && line === `  ${service}:`,
  );
  if (serviceIndex < 0) return undefined;

  for (let index = serviceIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) break;
    const match = new RegExp(`^ {4}${key}:\\s*([^#]+?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

afterEach(async () => {
  for (const child of activeSupervisors) {
    killSupervisorGroup(child);
    await waitForExit(child);
  }
  activeSupervisors.clear();
});

describe('container entrypoint child supervision', () => {
  it.each([
    {
      failedRole: 'api',
      apiBehavior: 'exit:23',
      proxyBehavior: 'wait',
      siblingRole: 'proxy',
      status: 23,
    },
    {
      failedRole: 'proxy',
      apiBehavior: 'wait',
      proxyBehavior: 'exit:29',
      siblingRole: 'api',
      status: 29,
    },
    {
      failedRole: 'api',
      apiBehavior: 'exit:0',
      proxyBehavior: 'wait',
      siblingRole: 'proxy',
      status: 1,
    },
    {
      failedRole: 'proxy',
      apiBehavior: 'wait',
      proxyBehavior: 'exit:0',
      siblingRole: 'api',
      status: 1,
    },
  ])(
    'reports $failedRole exit as status $status and drains the $siblingRole sibling',
    async ({ apiBehavior, proxyBehavior, siblingRole, status }) => {
      const runtime = await startSupervisor({ apiBehavior, proxyBehavior });
      try {
        const outcome = await waitForExit(runtime.child);
        expect(outcome, runtime.output()).toEqual({ code: status, signal: null });
        await expect(
          readFile(join(runtime.markerDirectory, `${siblingRole}.terminated`)),
        ).resolves.toBeInstanceOf(Buffer);
        await expect(
          readFile(join(runtime.markerDirectory, `${siblingRole}.drained`)),
        ).resolves.toBeInstanceOf(Buffer);
      } finally {
        killSupervisorGroup(runtime.child);
        await runtime.remove();
      }
    },
  );

  it.each(['SIGINT', 'SIGTERM'])('drains both children and exits cleanly on %s', async (signal) => {
    const runtime = await startSupervisor();
    try {
      await Promise.all([
        waitForFile(join(runtime.markerDirectory, 'api.ready')),
        waitForFile(join(runtime.markerDirectory, 'proxy.ready')),
      ]);
      runtime.child.kill(signal);
      const outcome = await waitForExit(runtime.child);
      expect(outcome, runtime.output()).toEqual({ code: 0, signal: null });
      for (const role of ['api', 'proxy']) {
        await expect(
          readFile(join(runtime.markerDirectory, `${role}.terminated`)),
        ).resolves.toBeInstanceOf(Buffer);
        await expect(
          readFile(join(runtime.markerDirectory, `${role}.drained`)),
        ).resolves.toBeInstanceOf(Buffer);
      }
    } finally {
      killSupervisorGroup(runtime.child);
      await runtime.remove();
    }
  });
});

describe('container runtime declarations', () => {
  it('keeps proxy ingress loopback-only unless the container explicitly opts in', async () => {
    const proxy = await readFile(join(repositoryRoot, 'docker-proxy.mjs'), 'utf8');
    expect(proxy).toContain("process.env['VELO_PROXY_HOST'] ?? '127.0.0.1'");
    expect(proxy).toContain("new Set(['127.0.0.1', '0.0.0.0'])");
    expect(proxy).toContain('proxy.listen(proxyPort, proxyHost)');
    expect(proxy).not.toContain("proxy.listen(proxyPort, '0.0.0.0')");
  });

  it('health-checks proxy ingress and deploys one authoritative web asset tree', async () => {
    const dockerfile = await readFile(join(repositoryRoot, 'Dockerfile'), 'utf8');
    const normalized = dockerfile.replace(/\\\r?\n\s*/g, ' ');

    expect(normalized).toMatch(/HEALTHCHECK .*fetch\('http:\/\/127\.0\.0\.1:5123\/api\/health'\)/);
    expect(dockerfile).toContain('RUN pnpm api:build');
    expect(dockerfile).not.toContain('RUN pnpm package:web');
    expect(dockerfile).not.toContain('RUN pnpm --filter @velograph/api run build');
    expect(dockerfile).not.toContain('--if-present run build');
    expect(dockerfile).toContain('COPY --from=build --chown=node:node /opt/velograph/api /app/api');
    expect(dockerfile).not.toMatch(/COPY .*apps\/web\/dist/);
    expect(dockerfile).not.toContain('/app/web/dist');
    expect(dockerfile).toContain('VELO_PROXY_HOST=127.0.0.1');
    expect(dockerfile).not.toContain('VELO_PROXY_HOST=0.0.0.0');
  });

  it('makes container-network proxy ingress an explicit Compose-only opt-in', async () => {
    const compose = await readFile(join(repositoryRoot, 'docker-compose.yml'), 'utf8');
    expect(parsedServiceScalar(compose, 'velograph', 'stop_grace_period')).toBe('25s');
    expect(compose).toContain('      VELO_PROXY_HOST: 0.0.0.0');
    expect(compose).toContain("'127.0.0.1:5123:5123'");
  });

  it('keeps the release smoke test ephemeral, loopback-only, and lifecycle-aware', async () => {
    const workflow = await readFile(
      join(repositoryRoot, '.github', 'workflows', 'release-governance.yml'),
      'utf8',
    );
    const nativeAudit = workflow.indexOf('Audit every native image layer');
    const runtimeSmoke = workflow.indexOf(
      'Smoke-test the native container lifecycle through proxy ingress',
    );
    const multiArchitectureBuild = workflow.indexOf('Set up QEMU for linux/arm64 verification');

    expect(nativeAudit).toBeGreaterThanOrEqual(0);
    expect(runtimeSmoke).toBeGreaterThan(nativeAudit);
    expect(multiArchitectureBuild).toBeGreaterThan(runtimeSmoke);
    const smokeStep = workflow.slice(runtimeSmoke, multiArchitectureBuild);
    expect(smokeStep).toContain('--env VELO_DATA_DIR=/var/lib/velograph');
    expect(smokeStep).toContain('--env VELO_PROXY_HOST=0.0.0.0');
    expect(smokeStep).toContain('--tmpfs /var/lib/velograph:rw,noexec,nosuid,nodev,size=64m');
    expect(smokeStep).toContain('--publish 127.0.0.1::5123');
    expect(smokeStep).toContain('"${proxy_origin}/api/health"');
    expect(smokeStep).toContain('"${proxy_origin}/"');
    expect(smokeStep.match(/--connect-timeout 2/g)).toHaveLength(2);
    expect(smokeStep.match(/--max-time 3/g)).toHaveLength(2);
    expect(smokeStep).toContain("'running healthy'");
    expect(smokeStep).toContain('docker stop --time 25');
    expect(smokeStep).toContain('trap cleanup EXIT');
    expect(smokeStep).not.toMatch(/--volume| -v /);
  });
});
