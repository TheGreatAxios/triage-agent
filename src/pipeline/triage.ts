import type { TriageQueueMessage } from "../types/queue";
import type { InternalEvent } from "../types/events";
import type { Env } from "../types/env";
import { triageMessage } from "../lib/classifier";
import { persistClassification } from "../lib/persistence";
import { handleTriageResult } from "./respond";
import { trackPipelineMetrics } from "../lib/metrics";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/errors";
import { createPostHogClient, shutdownPostHog } from "../lib/telemetry";
import { getOrRefreshSummary } from "../lib/summary";
import { getRecentMessagesWithSenders, buildMessageContext } from "../lib/queries";

/**
 * Phase 2 (queue consumer): LLM triage + handle result.
 * Runs in a Queue consumer with up to 30 minutes per message,
 * eliminating waitUntil timeout issues.
 */
export async function processTriageMessage(
  env: Env,
  msg: TriageQueueMessage,
): Promise<void> {
  const triageStart = Date.now();
  const posthog = createPostHogClient(env);

  try {
    // Build conversation context for the LLM
    const context = await buildContext(env.DB, msg.dbChatId);

    // Reconstruct a minimal InternalEvent for the classifier
    const event: InternalEvent = {
      id: msg.updateId,
      source: "telegram",
      type: "message",
      chatId: msg.telegramChatId,
      messageId: msg.messageId,
      text: msg.text,
      sender: {
        id: msg.sender.id,
        username: msg.sender.username ?? undefined,
        name: msg.sender.name,
        isBot: msg.sender.isBot,
      },
      isMention: false,
      timestamp: msg.timestamp,
    };

    const triage = await triageMessage(env, event, context, posthog);

    // Persist classification for analytics / timer lookups
    await persistClassification(env.DB, msg.dbMessageId, msg.dbChatId, {
      label: triage.label,
      confidence: triage.confidence,
      method: triage.method,
      reasoning: triage.reasoning,
    });

    trackPipelineMetrics({ chatId: msg.telegramChatId, stage: "triage", durationMs: Date.now() - triageStart, success: true });

    // Act on the result
    await handleTriageResult(env, msg.dbChatId, triage, msg.dbMessageId);
  } catch (err) {
    trackPipelineMetrics({ chatId: msg.telegramChatId, stage: "triage", durationMs: Date.now() - triageStart, success: false });
    logger.error("Triage pipeline failed (queue)", {
      update_id: msg.updateId,
      dbChatId: msg.dbChatId,
      error: getErrorMessage(err),
    });
    throw err; // Re-throw so queue retries
  } finally {
    await shutdownPostHog(posthog);
  }
}

/**
 * Build conversation context string for the triage LLM.
 */
async function buildContext(db: D1Database, chatId: number): Promise<string> {
  const summary = await getOrRefreshSummary(db, chatId);

  const messages = await getRecentMessagesWithSenders(db, {
    chatId,
    limit: 10,
    order: "desc",
  });

  const recentMessages = buildMessageContext(messages.reverse());

  let context = "";
  if (summary) {
    context += `Summary:\n${summary.content}\n\n`;
  }
  context += `Recent messages:\n${recentMessages}`;

  return context;
}
