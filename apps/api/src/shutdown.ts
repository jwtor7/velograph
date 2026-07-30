import { checkpointDatabase } from '@velograph/db';
import type { VelographApiServer } from './server.ts';

function closeHttpServer(server: VelographApiServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const wasListening = server.listening;
    server.close((error) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
      } else if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    if (wasListening) {
      // Keep the drain bounded on every supported Node release without
      // interrupting active responses.
      server.closeIdleConnections?.();
    }
  });
}

/**
 * Stop accepting connections, drain accepted work, checkpoint the current
 * WAL, and release both database handles. Every cleanup stage runs even if an
 * earlier stage fails, which also makes this safe after create/listen failure.
 */
export async function shutdownApiServer(server: VelographApiServer): Promise<void> {
  let firstError: unknown;
  const capture = (error: unknown) => {
    firstError ??= error;
  };

  try {
    await closeHttpServer(server);
  } catch (error) {
    capture(error);
  }

  try {
    await server.waitForRequests();
  } catch (error) {
    capture(error);
  }

  const db = server.getDatabase();
  if (db.open) {
    try {
      checkpointDatabase(db);
    } catch (error) {
      capture(error);
    } finally {
      try {
        db.close();
      } catch (error) {
        capture(error);
      }
    }
  }
  server.closeBasemap();

  if (firstError !== undefined) throw firstError;
}
