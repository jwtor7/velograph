import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { databasePath, openDatabase, resolveDataDir } from '@velograph/db';
import { createApiServer } from './server.ts';

export async function main(): Promise<number> {
  const port = Number(process.env['VELO_PORT'] ?? 5123);
  const host = process.env['VELO_HOST'] ?? '127.0.0.1';

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    // Non-loopback binding requires authentication before release (PRD §11.3).
    console.error('Refusing non-loopback bind: authentication is not implemented yet.');
    return 1;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error('Refusing invalid port.');
    return 1;
  }

  const dataDir = resolveDataDir();
  const dbPath = databasePath(dataDir);
  const db = openDatabase(dbPath);
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  const server = createApiServer({
    db,
    dbPath,
    ...(existsSync(webDist) ? { staticDir: webDist } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      const boundPort = address && typeof address === 'object' ? address.port : port;
      console.log(
        `Velograph listening on http://${host}:${boundPort} (data dir configured via VELO_DATA_DIR)`,
      );
      resolve();
    });
  });
  return 0;
}
