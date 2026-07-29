export interface ShutdownCoordinatorOptions {
  shutdown(): Promise<void>;
  exit(code: 0 | 1): void;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  log(message: string): void;
  error(message: string): void;
  timeoutMs: number;
}

/**
 * Coordinate idempotent signal handling independently from process globals so
 * the graceful, failed, and forced-exit paths can be tested deterministically.
 */
export function createShutdownCoordinator(options: ShutdownCoordinatorOptions) {
  let shuttingDown = false;
  let finished = false;

  return (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.log(`Velograph: ${reason}; draining local requests before shutdown.`);

    const deadline: { handle: unknown } = { handle: undefined };
    const finish = (code: 0 | 1, errorMessage?: string) => {
      if (finished) return;
      finished = true;
      if (deadline.handle !== undefined) options.cancel(deadline.handle);
      if (errorMessage) options.error(errorMessage);
      options.exit(code);
    };

    deadline.handle = options.schedule(() => {
      finish(1, `Velograph: graceful shutdown exceeded ${options.timeoutMs}ms; forcing exit.`);
    }, options.timeoutMs);

    void options.shutdown().then(
      () => finish(0),
      () => finish(1, 'Velograph: graceful shutdown failed; forcing exit.'),
    );
  };
}
