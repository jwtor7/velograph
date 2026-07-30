import { describe, expect, it, vi } from 'vitest';
import { createShutdownCoordinator } from './shutdown-coordinator.ts';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: () => void;
} {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = () => rej(new Error('shutdown_failed'));
  });
  return { promise, resolve, reject };
}

describe('createShutdownCoordinator', () => {
  it('handles repeated SIGTERM/SIGINT requests once and exits after graceful drain', async () => {
    const drain = deferred();
    const exit = vi.fn();
    const cancel = vi.fn();
    const log = vi.fn();
    const shutdown = vi.fn(() => drain.promise);
    const coordinator = createShutdownCoordinator({
      shutdown,
      exit,
      schedule: () => 'timer-token',
      cancel,
      log,
      error: vi.fn(),
      timeoutMs: 10_000,
    });

    coordinator('received SIGTERM');
    coordinator('received SIGINT');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);

    drain.resolve();
    await drain.promise;
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith('timer-token');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when graceful shutdown rejects', async () => {
    const drain = deferred();
    const exit = vi.fn();
    const error = vi.fn();
    const coordinator = createShutdownCoordinator({
      shutdown: () => drain.promise,
      exit,
      schedule: () => 'timer-token',
      cancel: vi.fn(),
      log: vi.fn(),
      error,
      timeoutMs: 10_000,
    });

    coordinator('received SIGTERM');
    drain.reject();
    await expect(drain.promise).rejects.toThrow('shutdown_failed');
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith('Velograph: graceful shutdown failed; forcing exit.');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps a bounded deadline that forces a single non-zero exit', async () => {
    const drain = deferred();
    const exit = vi.fn();
    const error = vi.fn();
    let deadline!: () => void;
    const coordinator = createShutdownCoordinator({
      shutdown: () => drain.promise,
      exit,
      schedule: (callback) => {
        deadline = callback;
        return 'timer-token';
      },
      cancel: vi.fn(),
      log: vi.fn(),
      error,
      timeoutMs: 10_000,
    });

    coordinator('received SIGINT');
    deadline();
    drain.resolve();
    await drain.promise;
    await Promise.resolve();

    expect(error).toHaveBeenCalledWith(
      'Velograph: graceful shutdown exceeded 10000ms; forcing exit.',
    );
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
