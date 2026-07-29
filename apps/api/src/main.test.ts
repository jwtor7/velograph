import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { databasePath, openDatabase } from '@velograph/db';
import { main, readApiRuntimeConfig, resolveWebDist } from './main.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('API runtime configuration', () => {
  it('accepts only lexical loopback hosts and integer ports, including ephemeral port zero', () => {
    expect(readApiRuntimeConfig({ VELO_HOST: '127.0.0.1', VELO_PORT: '0' })).toEqual({
      host: '127.0.0.1',
      port: 0,
    });
    expect(readApiRuntimeConfig({ VELO_HOST: 'localhost', VELO_PORT: '65535' })).toEqual({
      host: 'localhost',
      port: 65_535,
    });
    expect(readApiRuntimeConfig({ VELO_HOST: '::1', VELO_PORT: '5123' })).toEqual({
      host: '::1',
      port: 5123,
    });
    for (const port of ['', '00', ' 5123', '+5123', '5e3', '5123.0', '65536', '-1']) {
      expect(() => readApiRuntimeConfig({ VELO_HOST: '127.0.0.1', VELO_PORT: port })).toThrow(
        'invalid_port',
      );
    }
    for (const host of ['0.0.0.0', '127.0.0.2', 'localhost.', ' 127.0.0.1']) {
      expect(() => readApiRuntimeConfig({ VELO_HOST: host, VELO_PORT: '5123' })).toThrow(
        'invalid_host',
      );
    }
  });

  it('rejects invalid configuration before creating the configured data directory', async () => {
    const parent = temporaryDirectory('velo-api-invalid-config-');
    const dataDirectory = join(parent, 'must-not-be-created');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await main({
        VELO_HOST: '0.0.0.0',
        VELO_PORT: '5123',
        VELO_DATA_DIR: dataDirectory,
      }),
    ).toBe(1);
    expect(existsSync(dataDirectory)).toBe(false);
  });

  it('prefers packaged dist/web and falls back to the source web build', () => {
    const root = temporaryDirectory('velo-api-static-');
    const runtime = join(root, 'apps', 'api', 'dist', 'api-runtime.mjs');
    const packaged = join(root, 'apps', 'api', 'dist', 'web');
    const source = join(root, 'apps', 'web', 'dist');
    mkdirSync(packaged, { recursive: true });
    writeFileSync(join(packaged, 'index.html'), 'packaged');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'index.html'), 'source');

    expect(resolveWebDist(pathToFileURL(runtime).href)).toBe(packaged);
    rmSync(packaged, { recursive: true, force: true });
    expect(resolveWebDist(pathToFileURL(runtime).href)).toBe(source);
  });

  it('closes startup resources when listen fails', async () => {
    const dataDirectory = temporaryDirectory('velo-api-listen-failure-');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    try {
      await expect(
        main({
          VELO_HOST: '127.0.0.1',
          VELO_PORT: String(port),
          VELO_DATA_DIR: dataDirectory,
        }),
      ).rejects.toBeDefined();
      const wal = `${databasePath(dataDirectory)}-wal`;
      expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);

      const reopened = openDatabase(databasePath(dataDirectory));
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
      reopened.close();
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
