import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { databasePath, openDatabase, resolveDataDir } from '@velograph/db';
import { createApiServer } from './server.ts';

const dataDir = resolveDataDir();
const dbPath = databasePath(dataDir);
const db = openDatabase(dbPath);
const port = Number(process.env['VELO_PORT'] ?? 5123);
const host = process.env['VELO_HOST'] ?? '127.0.0.1';

if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  // Non-loopback binding requires authentication before release (PRD §11.3).
  console.error('Refusing non-loopback bind: authentication is not implemented yet.');
  process.exit(1);
}

const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const server = createApiServer({
  db,
  dbPath,
  ...(existsSync(webDist) ? { staticDir: webDist } : {}),
});
server.listen(port, host, () => {
  console.log(
    `Velograph listening on http://${host}:${port} (data dir configured via VELO_DATA_DIR)`,
  );
});
