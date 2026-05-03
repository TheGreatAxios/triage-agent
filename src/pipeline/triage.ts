import type { InternalEvent } from "../types/events";
import type { Env } from "../types/env";
import { triageMessage } from "../lib/classifier";
import { persistClassification } from "../lib/persistence";
import { handleTriageResult } from "./respond";
import { trackPipelineMetrics } from "../lib/metrics";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/errors";
import { getOrRefreshSummary } from "../lib/summary";
import { getRecentMessagesWithSenders, buildMessageContext } from "../lib/queries";
import { sendErrorAlert } from "../lib/escalation";

/** Internal message passed from ingest to triage. */
interface TriageMessage {
  dbChatId: number;
  dbMessageId: number;
  telegramChatId: number;
  text: string;
  sender: {
    id: number;
    username: string | null;
    name: string;
    isBot: boolean;
  };
  updateId: number;
  messageId: number;
  timestamp: string;
}

/**
 * Run LLM triage on a message and handle the result.
 * Workers AI calls complete in 1-3s — runs inline within waitUntil.
 */
export async function processTriageMessage(
  env: Env,
  msg: TriageMessage,
): Promise<void> {
  const triageStart = Date.now();
  const stageTimes: Record<string, number> = {};

  try {
    // Build conversation context for the LLM
    const contextStart = Date.now();
    const context = await buildContext(env.DB, msg.dbChatId, env);
    stageTimes.build_context = Date.now() - contextStart;

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

    const triage = await triageMessage(env, event, context);

    // Persist classification for analytics / timer lookups
    await persistClassification(env.DB, msg.dbMessageId, msg.dbChatId, {
      label: triage.label,
      confidence: triage.confidence,
      method: triage.method,
      reasoning: triage.reasoning,
    });

    stageTimes.llm_triage = Date.now() - triageStart - stageTimes.build_context;
    trackPipelineMetrics({ chatId: msg.telegramChatId, stage: "triage", durationMs: Date.now() - triageStart, success: true });

    // Act on the result
    const handleStart = Date.now();
    await handleTriageResult(env, msg.dbChatId, triage, msg.dbMessageId);
    stageTimes.handle_result = Date.now() - handleStart;

    logger.info("Triage stage complete", {
      chatId: msg.dbChatId,
      messageId: msg.messageId,
      total_triage_ms: Date.now() - triageStart,
      stages: stageTimes,
    });
  } catch (err) {
    trackPipelineMetrics({ chatId: msg.telegramChatId, stage: "triage", durationMs: Date.now() - triageStart, success: false });
    logger.error("Triage pipeline failed", {
      update_id: msg.updateId,
      dbChatId: msg.dbChatId,
      stages: stageTimes,
      error: getErrorMessage(err),
    });

    // Escalate the error to Slack with full context
    const errorContext = (err as Record<string, unknown>).context as Record<string, unknown> | undefined;
    await sendErrorAlert(
      env.DB,
      env.SLACK_WEBHOOK_URL,
      {
        chatId: msg.dbChatId,
        errorType: err instanceof Error ? err.constructor.name : typeof err,
        errorMessage: getErrorMessage(err),
        messageText: msg.text,
        sender: msg.sender.username || msg.sender.name,
        rawPrefix: (errorContext?.rawPrefix as string) ?? undefined,
        rawSuffix: (errorContext?.rawSuffix as string) ?? undefined,
        rawLength: (errorContext?.rawLength as number) ?? undefined,
        stack: err instanceof Error ? err.stack : undefined,
      },
    ).catch((escalateErr) => {
      logger.error("Failed to escalate triage error to Slack", {
        update_id: msg.updateId,
        error: getErrorMessage(escalateErr),
      });
    });

    throw err;
  }
}

/**
 * Build conversation context string for the triage LLM.
 *
 * Uses a large recent-message window (40 messages) plus an AI-generated
 * conversation summary to give the LLM rich historical context.
 */
async function buildContext(db: D1Database, chatId: number, env?: Env): Promise<string> {
  const summary = await getOrRefreshSummary(db, chatId, env);

  const messages = await getRecentMessagesWithSenders(db, {
    chatId,
    limit: 80,
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
