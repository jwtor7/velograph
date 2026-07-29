import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isExpectedVelographRuntime,
  isVelographCommand,
  readManagedPort,
  startManagedLogSink,
  stopProcess,
} from './app.mjs';
import { BoundedLogFile, runServerLogSink } from './server-log-sink.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'velograph-log-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('app:start managed server log', () => {
  it('tightens retained current and previous targets to owner-only permissions', () => {
    const path = join(temporaryDirectory(), 'server.log');
    writeFileSync(path, 'existing');
    writeFileSync(`${path}.previous`, 'previous');
    chmodSync(path, 0o644);
    chmodSync(`${path}.previous`, 0o644);

    const writer = new BoundedLogFile(path, { maxBytes: 64 });
    writer.close();

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.previous`).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('existing');
  });

  it('caps and tightens a permissive legacy log before retaining it as the rotated generation', () => {
    const path = join(temporaryDirectory(), 'server.log');
    writeFileSync(path, 'current-generation');
    writeFileSync(`${path}.previous`, 'older-generation');
    chmodSync(path, 0o644);
    chmodSync(`${path}.previous`, 0o644);

    const writer = new BoundedLogFile(path, { maxBytes: 8 });
    writer.write('new');
    writer.close();

    expect(readFileSync(`${path}.previous`, 'utf8')).toBe('current-');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.previous`).mode & 0o777).toBe(0o600);
    expect(statSync(path).size).toBeLessThanOrEqual(8);
    expect(statSync(`${path}.previous`).size).toBeLessThanOrEqual(8);
  });

  it('rejects symlink and non-regular log targets without following them', () => {
    const directory = temporaryDirectory();
    const outside = join(directory, 'outside');
    const symlink = join(directory, 'server.log');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, symlink);
    expect(() => new BoundedLogFile(symlink, { maxBytes: 8 })).toThrow('server_log_target_invalid');
    expect(readFileSync(outside, 'utf8')).toBe('outside');

    const nonRegular = join(directory, 'directory.log');
    mkdirSync(nonRegular);
    expect(() => new BoundedLogFile(nonRegular, { maxBytes: 8 })).toThrow(
      'server_log_target_invalid',
    );
  });

  it('rejects a symlinked rotation target before replacing it', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'server.log');
    const outside = join(directory, 'outside');
    writeFileSync(path, 'rotate-me');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, `${path}.previous`);

    expect(() => new BoundedLogFile(path, { maxBytes: 1 })).toThrow(
      'server_log_rotation_target_invalid',
    );
    expect(readFileSync(path, 'utf8')).toBe('rotate-me');
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('fails closed if the active log path is replaced before runtime rotation', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'server.log');
    const outside = join(directory, 'outside');
    writeFileSync(outside, 'outside');
    const writer = new BoundedLogFile(path, { maxBytes: 8 });
    writer.write('12345678');
    rmSync(path);
    symlinkSync(outside, path);
    try {
      expect(() => writer.write('x')).toThrow('server_log_target_invalid');
      expect(readFileSync(outside, 'utf8')).toBe('outside');
    } finally {
      writer.close();
    }
  });

  it('keeps both generations bounded while draining a producer after the launcher closes its pipe', async () => {
    const path = join(temporaryDirectory(), 'server.log');
    const sink = await startManagedLogSink(path, { maxBytes: 8 });
    const producer = spawn(
      process.execPath,
      ['-e', "process.stdout.write('abcdefghijklmnopqrst')"],
      {
        stdio: ['ignore', sink.input, sink.input],
      },
    );
    sink.input.destroy();

    const producerOutcome = await new Promise((resolve) => {
      producer.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const sinkOutcome = await sink.observation.completion;

    expect(producerOutcome).toEqual({ code: 0, signal: null });
    expect(sinkOutcome).toEqual({ type: 'exit', code: 0, signal: null });
    expect(readFileSync(`${path}.previous`, 'utf8')).toBe('ijklmnop');
    expect(readFileSync(path, 'utf8')).toBe('qrst');
    expect(statSync(path).size).toBeLessThanOrEqual(8);
    expect(statSync(`${path}.previous`).size).toBeLessThanOrEqual(8);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.previous`).mode & 0o777).toBe(0o600);
  });

  it('reports sink failures without exposing the rejected path or content', async () => {
    const directory = temporaryDirectory();
    const outside = join(directory, 'outside');
    const path = join(directory, 'server.log');
    writeFileSync(outside, 'invented sensitive content');
    symlinkSync(outside, path);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runServerLogSink([path, '8'])).toBe(1);
      const output = JSON.stringify(error.mock.calls);
      expect(output).toContain('Velograph log sink failed.');
      expect(output).not.toContain(path);
      expect(output).not.toContain('invented sensitive content');
    } finally {
      error.mockRestore();
    }
  });
});

describe('app:stop graceful-shutdown escalation', () => {
  it('waits for the grace period, reports escalation, then sends SIGKILL', async () => {
    const signals = [];
    let alive = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await stopProcess(4242, {
        getProcessIdentity: () => (alive ? '4242:start-token' : null),
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === 'SIGKILL') alive = false;
        },
        sleep: async () => {},
        graceMs: 3,
        pollMs: 1,
      });

      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('graceful shutdown'));
      expect(log).toHaveBeenCalledWith('Force-stopped Velograph (pid 4242).');
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it('does not escalate after the target releases the port', async () => {
    const signals = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let checks = 0;
    try {
      await stopProcess(4242, {
        getProcessIdentity: () => (++checks >= 3 ? null : '4242:start-token'),
        kill: (_pid, signal) => signals.push(signal),
        sleep: async () => {},
        graceMs: 10,
        pollMs: 1,
      });

      expect(signals).toEqual(['SIGTERM']);
      expect(log).toHaveBeenCalledWith('Stopped Velograph (pid 4242).');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps waiting after the listener closes until the original process exits', async () => {
    const signals = [];
    let identityChecks = 0;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await stopProcess(4242, {
        getListenerPid: () => null,
        getProcessIdentity: () => (++identityChecks >= 4 ? null : '4242:same-process-start-token'),
        kill: (_pid, signal) => signals.push(signal),
        sleep: async () => {},
        graceMs: 10,
        pollMs: 1,
      });

      expect(signals).toEqual(['SIGTERM']);
      expect(identityChecks).toBe(4);
      expect(log).toHaveBeenCalledWith('Stopped Velograph (pid 4242).');
    } finally {
      log.mockRestore();
    }
  });

  it('recognizes only the Velograph API entrypoint', () => {
    const entrypoint = `${process.cwd()}/apps/api/dist/velograph-api.mjs`;
    expect(isVelographCommand(`/usr/local/bin/node ${entrypoint}`)).toBe(true);
    expect(isVelographCommand(`/usr/local/bin/node ${entrypoint}.bak`)).toBe(false);
    expect(isVelographCommand('/usr/local/bin/node /tmp/other/velograph-api.mjs')).toBe(false);
    expect(isVelographCommand('/usr/local/bin/node other-server.mjs')).toBe(false);
  });

  it('requires lexical managed ports from 1 through 65535', () => {
    expect(readManagedPort('1')).toBe(1);
    expect(readManagedPort('65535')).toBe(65_535);
    for (const value of ['0', '00', '', ' 5123', '+5123', '5e3', '65536']) {
      expect(() => readManagedPort(value)).toThrow('invalid_port');
    }
  });

  it('requires health, exact listener pid, and the built command before identifying Velograph', () => {
    const entrypoint = `${process.cwd()}/apps/api/dist/velograph-api.mjs`;
    const command = `/usr/local/bin/node ${entrypoint}`;
    const valid = {
      health: { ok: true, version: '0.1.0' },
      listener: 4242,
      expectedPid: 4242,
      command,
    };
    expect(isExpectedVelographRuntime(valid)).toBe(true);
    expect(isExpectedVelographRuntime({ ...valid, health: { ok: false, version: '0.1.0' } })).toBe(
      false,
    );
    expect(isExpectedVelographRuntime({ ...valid, health: { ok: true, version: '0.0.0' } })).toBe(
      false,
    );
    expect(isExpectedVelographRuntime({ ...valid, listener: 4343 })).toBe(false);
    expect(isExpectedVelographRuntime({ ...valid, command: '/usr/local/bin/node other.mjs' })).toBe(
      false,
    );
  });

  it('refuses to signal when the listener identity changes before shutdown', async () => {
    const signals = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const entrypoint = `${process.cwd()}/apps/api/dist/velograph-api.mjs`;
      const result = await stopProcess(4242, {
        expectedCommand: `/usr/local/bin/node ${entrypoint}`,
        getListenerPid: () => 4242,
        getProcessIdentity: () => '4242:start-token',
        getProcessCommand: () => '/usr/local/bin/node other-server.mjs',
        kill: (_pid, signal) => signals.push(signal),
      });

      expect(result).toBe(1);
      expect(signals).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('identity changed'));
    } finally {
      error.mockRestore();
    }
  });

  it('refuses SIGKILL when the command changes during the grace period', async () => {
    const signals = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entrypoint = `${process.cwd()}/apps/api/dist/velograph-api.mjs`;
    const expectedCommand = `/usr/local/bin/node ${entrypoint}`;
    let commandChecks = 0;
    try {
      const result = await stopProcess(4242, {
        expectedCommand,
        getListenerPid: () => 4242,
        getProcessIdentity: () => '4242:start-token',
        getProcessCommand: () => (++commandChecks === 1 ? expectedCommand : 'other-server'),
        kill: (_pid, signal) => signals.push(signal),
        sleep: async () => {},
        graceMs: 1,
        pollMs: 1,
      });

      expect(result).toBe(1);
      expect(signals).toEqual(['SIGTERM']);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('force-stopped'));
    } finally {
      error.mockRestore();
    }
  });

  it('treats ESRCH during the final SIGKILL race as a completed stop', async () => {
    const signals = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await stopProcess(4242, {
        getProcessIdentity: () => '4242:start-token',
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === 'SIGKILL') {
            const error = new Error('process already exited');
            error.code = 'ESRCH';
            throw error;
          }
        },
        sleep: async () => {},
        graceMs: 1,
        pollMs: 1,
      });

      expect(result).toBe(0);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(log).toHaveBeenCalledWith('Force-stopped Velograph (pid 4242).');
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
  });
});
