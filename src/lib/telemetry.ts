/**
 * PostHog LLM Analytics for AI SDK calls.
 *
 * Uses `@posthog/ai` withTracing to automatically
 * capture token usage, latency, cost, and model info for every
 * generateText/streamText call.
 *
 * No-op when POSTHOG_API_KEY is not set.
 *
 * Cloudflare Workers notes:
 * - Per-request client instantiation (not module-level singleton)
 * - flushAt=1, flushInterval=0 to send events immediately
 * - shutdown() called via ctx.waitUntil after pipeline completes
 * - Uses posthog-node/workerd entrypoint (no nodejs_compat needed)
 */
import { withTracing } from "@posthog/ai";
import type { LanguageModel } from "ai";
import type { Env } from "../types/env";
import { logger } from "./logger";

/**
 * Create a fresh PostHog client for this request.
 * Workers isolates are stateless — per-request is safer than module-level singletons.
 * flushAt=1 and flushInterval=0 ensure events are sent immediately
 * (no batching, no data loss when the worker terminates).
 */
export function createPostHogClient(env: Env) {
  if (!env.POSTHOG_API_KEY) return null;

  try {
    // Dynamic import to avoid bundling posthog-node when not needed
    const { PostHog } = require("posthog-node") as typeof import("posthog-node");

    const client = new PostHog(env.POSTHOG_API_KEY, {
      host: env.POSTHOG_HOST || "https://us.i.posthog.com",
      flushAt: 1,         // Send every event immediately
      flushInterval: 0,   // Don't wait for interval
      enableExceptionAutocapture: false,
    });

    return client;
  } catch (err) {
    logger.warn("Failed to initialize PostHog client", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export type PostHogClient = ReturnType<typeof createPostHogClient>;

export interface TelemetryOptions {
  /** Group events by this identifier (e.g. chatId, messageId) */
  distinctId?: string;
  /** Additional properties to attach to the event */
  properties?: Record<string, unknown>;
  /** Disable input/output recording */
  privacyMode?: boolean;
  /** PostHog group key (e.g. { project: "triage-agent" }) */
  groups?: Record<string, string>;
}

/**
 * Wrap a LanguageModel with PostHog tracing.
 * Returns the original model unchanged if telemetry is not configured.
 */
export function withTelemetry(
  model: LanguageModel,
  posthogClient: ReturnType<typeof createPostHogClient>,
  options: TelemetryOptions = {}
): LanguageModel {
  if (!posthogClient) return model;

  return withTracing(model, posthogClient, {
    posthogDistinctId: options.distinctId,
    posthogProperties: options.properties,
    posthogPrivacyMode: options.privacyMode,
    posthogGroups: options.groups,
  });
}

/**
 * Flush and shut down a PostHog client.
 * Must be called at the end of request handling via ctx.waitUntil.
 */
export async function shutdownPostHog(client: ReturnType<typeof createPostHogClient>): Promise<void> {
  if (client) {
    await client.shutdown();
  }
}
