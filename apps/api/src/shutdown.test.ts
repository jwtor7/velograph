import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { backupDatabase, openDatabase, restoreDatabase } from '@velograph/db';
import { createApiServer } from './server.ts';
import { shutdownApiServer } from './shutdown.ts';

describe('shutdownApiServer', () => {
  it('drains the server, checkpoints the WAL, and closes the current database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-shutdown-'));
    const dbPath = join(dir, 'live.sqlite3');
    try {
      const db = openDatabase(dbPath);
      db.prepare("INSERT INTO user_settings (key, value_json) VALUES ('shutdown-test', '1')").run();
      const server = createApiServer({ db, dbPath });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

      await shutdownApiServer(server);

      expect(server.listening).toBe(false);
      expect(db.open).toBe(false);
      const walPath = `${dbPath}-wal`;
      expect(!existsSync(walPath) || statSync(walPath).size === 0).toBe(true);

      const reopened = openDatabase(dbPath);
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(
        reopened.prepare("SELECT value_json FROM user_settings WHERE key = 'shutdown-test'").get(),
      ).toEqual({ value_json: '1' });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits for an in-flight restore, then closes the replacement database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-shutdown-restore-'));
    const dbPath = join(dir, 'live.sqlite3');
    const backupPath = join(dir, 'backup.sqlite3');
    try {
      const db = openDatabase(dbPath);
      db.prepare(
        "INSERT INTO user_settings (key, value_json) VALUES ('restore-state', '\"before\"')",
      ).run();
      await backupDatabase(db, backupPath);
      db.prepare(
        "UPDATE user_settings SET value_json = '\"after\"' WHERE key = 'restore-state'",
      ).run();

      let signalRestoreStarted!: () => void;
      const restoreStarted = new Promise<void>((resolve) => {
        signalRestoreStarted = resolve;
      });
      let releaseRestore!: () => void;
      const restoreGate = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
      const server = createApiServer({
        db,
        dbPath,
        restoreDatabaseFn: async (...args) => {
          signalRestoreStarted();
          await restoreGate;
          return restoreDatabase(...args);
        },
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const controller = new AbortController();
      const restoreRequest = fetch(`http://127.0.0.1:${port}/api/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-velograph-request': '1' },
        body: JSON.stringify({ path: backupPath }),
        signal: controller.signal,
      });

      await restoreStarted;
      controller.abort();
      await expect(restoreRequest).rejects.toThrow();

      let shutdownFinished = false;
      const stopping = shutdownApiServer(server).then(() => {
        shutdownFinished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(server.listening).toBe(false);
      expect(shutdownFinished).toBe(false);

      releaseRestore();
      await stopping;

      expect(server.getDatabase().open).toBe(false);
      const reopened = openDatabase(dbPath);
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(
        reopened.prepare("SELECT value_json FROM user_settings WHERE key = 'restore-state'").get(),
      ).toEqual({ value_json: '"before"' });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails health closed when a restore error leaves the database handle closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-restore-fail-closed-'));
    const dbPath = join(dir, 'live.sqlite3');
    try {
      const db = openDatabase(dbPath);
      const server = createApiServer({
        db,
        dbPath,
        restoreDatabaseFn: async () => {
          db.close();
          throw new Error('simulated_cleanup_failure');
        },
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;

      const restore = await fetch(`${base}/api/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-velograph-request': '1' },
        body: JSON.stringify({ path: join(dir, 'backup.sqlite3') }),
      });
      expect(restore.status).toBe(500);
      expect(await restore.json()).toEqual({ error: 'database_unavailable' });

      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({ error: 'database_unavailable' });
      await shutdownApiServer(server);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases an async request lease when the client disconnects mid-body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'velo-shutdown-aborted-body-'));
    const dbPath = join(dir, 'live.sqlite3');
    try {
      const db = openDatabase(dbPath);
      const server = createApiServer({ db, dbPath });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      let signalRequestAccepted!: () => void;
      const requestAccepted = new Promise<void>((resolve) => {
        signalRequestAccepted = resolve;
      });
      server.once('request', signalRequestAccepted);

      const socket = createConnection(port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(
        [
          'PUT /api/settings HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Content-Type: application/json',
          'x-velograph-request: 1',
          'Content-Length: 100',
          'Connection: close',
          '',
          '{"settings":',
        ].join('\r\n'),
      );
      await requestAccepted;
      socket.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));

      await shutdownApiServer(server);
      expect(db.open).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
