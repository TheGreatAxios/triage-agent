import type { InternalEvent } from "../types/events";

/**
 * Adapter interface for ingesting messages from different sources.
 * Implement this to add support for new channels (Discord, Email, etc.)
 */
export interface SourceAdapter<TPayload> {
  /** Source identifier (telegram, email, slack, api) */
  name: string;

  /**
   * Normalize a raw payload into an InternalEvent.
   * Returns null if the payload is not processable.
   */
  normalize(payload: TPayload): InternalEvent | null;

  /**
   * Verify the authenticity of an incoming webhook request.
   * Optional: not all sources require verification.
   */
  verify?(request: Request, secret: string): boolean;
}

/**
 * Registry of source adapters.
 * Add new adapters here as they are implemented.
 */
export class SourceRegistry {
  private adapters = new Map<string, SourceAdapter<unknown>>();

  register<T>(adapter: SourceAdapter<T>): void {
    this.adapters.set(adapter.name, adapter as SourceAdapter<unknown>);
  }

  get(name: string): SourceAdapter<unknown> | undefined {
    return this.adapters.get(name);
  }
}
