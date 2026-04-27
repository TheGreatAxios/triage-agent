/**
 * PostHog LLM Analytics for AI SDK calls.
 *
 * Uses `@posthog/ai` withTracing to automatically
 * capture token usage, latency, cost, and model info for every
 * generateText/streamText call.
 *
 * No-op when POSTHOG_API_KEY is not set.
 */
import { withTracing } from "@posthog/ai";
import type { LanguageModel } from "ai";
import type { Env } from "../types/env";
import { logger } from "./logger";

let posthogClient: InstanceType<typeof import("posthog-node").PostHog> | null = null;
let initialized = false;

/**
 * Lazy-initialize the PostHog client.
 * Safe to call multiple times — returns the same singleton.
 */
function getPostHogClient(env: Env) {
  if (initialized) return posthogClient;

  initialized = true;

  if (!env.POSTHOG_API_KEY) {
    logger.info("PostHog telemetry disabled — POSTHOG_API_KEY not set");
    return null;
  }

  try {
    // posthog-node edge entrypoint is Workers-compatible
    const { PostHog } = require("posthog-node") as typeof import("posthog-node");

    posthogClient = new PostHog(env.POSTHOG_API_KEY, {
      host: env.POSTHOG_HOST || "https://us.i.posthog.com",
      enableExceptionAutocapture: false,
    });

    logger.info("PostHog telemetry initialized");
    return posthogClient;
  } catch (err) {
    logger.warn("Failed to initialize PostHog client", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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
  env: Env,
  options: TelemetryOptions = {}
): LanguageModel {
  const client = getPostHogClient(env);

  if (!client) {
    return model;
  }

  return withTracing(model, client, {
    posthogDistinctId: options.distinctId,
    posthogProperties: options.properties,
    posthogPrivacyMode: options.privacyMode,
    posthogGroups: options.groups,
  });
}

/**
 * Flush any pending PostHog events.
 * Call at the end of request handling (e.g. in ctx.waitUntil or before response).
 */
export async function flushTelemetry(): Promise<void> {
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}
