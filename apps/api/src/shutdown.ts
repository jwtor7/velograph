import { checkpointDatabase } from '@velograph/db';
import type { VelographApiServer } from './server.ts';

/**
 * Stop accepting connections, drain in-flight requests, checkpoint the
 * current WAL, and close the current database handle. `getDatabase()` is
 * intentionally read only after the HTTP drain because a restore may replace
 * the handle while its request is still in flight.
 */
export async function shutdownApiServer(server: VelographApiServer): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // Node closes idle keep-alive connections automatically on current
      // releases; this explicit call keeps the drain bounded on older
      // supported releases without interrupting active responses.
      server.closeIdleConnections?.();
    });
  }

  // A client can disconnect while its asynchronous import, backup, or restore
  // work is still settling. The HTTP socket drain alone does not account for
  // that work, so wait on the server's operation tracker before touching the
  // current database handle.
  await server.waitForRequests();

  const db = server.getDatabase();
  if (!db.open) return;
  try {
    checkpointDatabase(db);
  } finally {
    db.close();
  }
}
