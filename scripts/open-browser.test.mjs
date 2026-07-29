import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBrowser } from './open-browser.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('foreground app browser lifecycle', () => {
  it('handles asynchronous launcher ENOENT before detaching', () => {
    const launcher = new EventEmitter();
    launcher.unref = vi.fn(() => {
      // The ordering is the lifecycle invariant: an `error` event after
      // detach must already have a listener and therefore cannot terminate
      // the wrapper while its API child is still alive.
      expect(launcher.listenerCount('error')).toBe(1);
    });
    const spawnProcess = vi.fn(() => launcher);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    openBrowser('http://127.0.0.1:6123', {
      currentPlatform: 'linux',
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith('xdg-open', ['http://127.0.0.1:6123'], {
      stdio: 'ignore',
      detached: true,
    });
    expect(launcher.unref).toHaveBeenCalledOnce();
    expect(() => {
      const error = Object.assign(new Error('launcher unavailable'), { code: 'ENOENT' });
      launcher.emit('error', error);
    }).not.toThrow();
    expect(log).toHaveBeenCalledWith('Open http://127.0.0.1:6123 in your browser.');
  });

  it('keeps synchronous launcher failures best-effort and value-free', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spawnProcess = vi.fn(() => {
      throw new Error('launcher unavailable');
    });

    expect(() =>
      openBrowser('http://127.0.0.1:6124', {
        currentPlatform: 'linux',
        spawnProcess,
      }),
    ).not.toThrow();
    expect(log).toHaveBeenCalledWith('Open http://127.0.0.1:6124 in your browser.');
  });
});
