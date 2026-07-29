import { describe, expect, it, vi } from 'vitest';
import { isVelographCommand, stopProcess } from './app.mjs';

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
    const entrypoint = `${process.cwd()}/apps/api/src/main.ts`;
    expect(isVelographCommand(`/usr/local/bin/node ${entrypoint}`)).toBe(true);
    expect(isVelographCommand(`/usr/local/bin/node ${entrypoint}.bak`)).toBe(false);
    expect(isVelographCommand('/usr/local/bin/node /tmp/other/apps/api/src/main.ts')).toBe(false);
    expect(isVelographCommand('/usr/local/bin/node other-server.mjs')).toBe(false);
  });

  it('refuses to signal when the listener identity changes before shutdown', async () => {
    const signals = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const entrypoint = `${process.cwd()}/apps/api/src/main.ts`;
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
    const entrypoint = `${process.cwd()}/apps/api/src/main.ts`;
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
