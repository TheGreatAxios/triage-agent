/**
 * Custom error classes for the Telegram Triage Agent.
 * 
 * These provide structured error information for different failure modes,
 * enabling better error handling, logging, and debugging.
 */

/** Base error class for all application errors. */
export class TriageAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    // Maintains proper stack trace in V8 environments (Node.js, Workers)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorConstructor = Error as unknown as { captureStackTrace?: (err: Error, ctor: unknown) => void };
    if (typeof errorConstructor.captureStackTrace === "function") {
      errorConstructor.captureStackTrace(this, this.constructor);
    }
  }

  /** Returns a structured object for logging. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      // Stack traces excluded to prevent information leakage in production
      // Add stack only when explicitly debugging via LOG_STACK_TRACES env var
    };
  }
}

/** Database operation failures. */
export class DatabaseError extends TriageAgentError {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly table?: string,
    context?: Record<string, unknown>
  ) {
    super(message, "DATABASE_ERROR", {
      ...context,
      operation,
      table,
    });
  }
}

/** AI/model invocation failures. */
export class AIError extends TriageAgentError {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly model: string,
    public readonly task: string,
    context?: Record<string, unknown>
  ) {
    super(message, "AI_ERROR", {
      ...context,
      provider,
      model,
      task,
    });
  }
}

/** External API call failures (Telegram, Slack, Linear). */
export class APIError extends TriageAgentError {
  constructor(
    message: string,
    public readonly service: "telegram" | "slack" | "linear",
    public readonly statusCode?: number,
    context?: Record<string, unknown>
  ) {
    super(message, "API_ERROR", {
      ...context,
      service,
      statusCode,
    });
  }
}

/** Validation failures (classification parsing, etc.). */
export class ValidationError extends TriageAgentError {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value?: unknown,
    context?: Record<string, unknown>
  ) {
    super(message, "VALIDATION_ERROR", {
      ...context,
      field,
      value,
    });
  }
}

/** Configuration or environment issues. */
export class ConfigError extends TriageAgentError {
  constructor(
    message: string,
    public readonly configKey?: string,
    context?: Record<string, unknown>
  ) {
    super(message, "CONFIG_ERROR", {
      ...context,
      configKey,
    });
  }
}

/** Rate limiting or quota exceeded. */
export class RateLimitError extends TriageAgentError {
  constructor(
    message: string,
    public readonly limit: number,
    public readonly windowSeconds: number,
    context?: Record<string, unknown>
  ) {
    super(message, "RATE_LIMIT_ERROR", {
      ...context,
      limit,
      windowSeconds,
    });
  }
}

/** Not found errors (chat, message, draft, etc.). */
export class NotFoundError extends TriageAgentError {
  constructor(
    message: string,
    public readonly resource: string,
    public readonly resourceId: string | number,
    context?: Record<string, unknown>
  ) {
    super(message, "NOT_FOUND", {
      ...context,
      resource,
      resourceId,
    });
  }
}

/**
 * Extract a human-readable message from an unknown error.
 * Use this instead of repeating `err instanceof Error ? err.message : String(err)`
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Type guard to check if an error is a TriageAgentError.
 */
export function isTriageAgentError(error: unknown): error is TriageAgentError {
  return error instanceof TriageAgentError;
}

/**
 * Convert unknown error to TriageAgentError if possible.
 */
export function toTriageAgentError(error: unknown): TriageAgentError {
  if (isTriageAgentError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new TriageAgentError(error.message, "UNKNOWN_ERROR", {
      originalName: error.name,
      originalStack: error.stack,
    });
  }

  return new TriageAgentError(
    String(error),
    "UNKNOWN_ERROR",
    { originalValue: error }
  );
}
