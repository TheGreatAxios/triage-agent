/**
 * Utility for adding timeouts to async operations.
 * Prevents waitUntil() tasks from hanging indefinitely.
 */

export class TimeoutError extends Error {
  constructor(message: string, public readonly operation: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timeout.
 * Returns the promise result or throws TimeoutError.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new TimeoutError(
        `${operationName} timed out after ${timeoutMs}ms`,
        operationName,
      ));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]);
}

/**
 * Fire-and-forget pattern: run async work without awaiting.
 * Logs success/failure but never throws.
 */
export function fireAndForget(
  operation: () => Promise<void>,
  operationName: string,
  logger: {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  },
): void {
  operation().then(
    () => {
      logger.debug(`${operationName} completed`, { operation: operationName });
    },
    (err: unknown) => {
      logger.error(`${operationName} failed`, {
        operation: operationName,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
}
