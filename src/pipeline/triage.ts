import type { InternalEvent } from "../types/events";
import type { Env } from "../types/env";
import type { TriageResult } from "../types/classification";
import { classifyMessage, draftResponse } from "../lib/classifier";
import { persistClassification } from "../lib/persistence";
import { handleTriageResult } from "./respond";
import { trackPipelineMetrics } from "../lib/metrics";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/errors";
import { getOrRefreshSummary } from "../lib/summary";
import { getRecentMessagesWithSenders } from "../lib/queries";
import { sendErrorAlert } from "../lib/escalation";
import {
  buildClassificationContext,
  buildDraftContext,
  type DraftContext,
} from "../lib/context-builder";

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
    // Build conversation context for classification (Tier 1: 30 messages)
    const contextStart = Date.now();
    const classificationCtx = await buildClassificationContext(
      env.DB,
      msg.dbChatId,
      msg.sender.id,
      async (chatId) => {
        const summary = await getOrRefreshSummary(env.DB, chatId, env);
        return summary?.content ?? null;
      },
      getRecentMessagesWithSenders,
    );
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

    // Step 1: Classify only (no draft yet)
    const classification = await classifyMessage(env, event, classificationCtx.formatted);

    // Step 2: Build rich draft context and generate draft if needed
    let triage: TriageResult;
    if (classification.action === "defer") {
      triage = {
        label: classification.label,
        confidence: classification.confidence,
        method: "model",
        reasoning: classification.reasoning,
        action: "defer",
        draft: null,
        draftConfidence: null,
      };
    } else {
      // Build rich draft context (Tier 2: 5-7 messages + metadata)
      const draftStart = Date.now();
      const draftCtx = await buildDraftContext(
        env.DB,
        msg.dbChatId,
        msg.sender.id,
        { text: msg.text, senderName: msg.sender.name, senderId: msg.sender.id },
        async (chatId) => {
          const summary = await getOrRefreshSummary(env.DB, chatId, env);
          return summary?.content ?? null;
        },
        getRecentMessagesWithSenders,
      );
      stageTimes.build_draft_context = Date.now() - draftStart;

      // Generate draft with rich context
      const draftGenStart = Date.now();
      try {
        const draftResult = await draftResponse(env, event, draftCtx, {
          label: classification.label,
          reasoning: classification.reasoning,
        });
        stageTimes.draft_generation = Date.now() - draftGenStart;

        triage = {
          label: classification.label,
          confidence: classification.confidence,
          method: "model",
          reasoning: classification.reasoning,
          action: classification.action,
          draft: draftResult.draft,
          draftConfidence: draftResult.draftConfidence,
        };
      } catch (err) {
        // Draft failed — escalate without draft
        logger.error("Draft generation failed, escalating without draft", {
          messageId: msg.messageId,
          chatId: msg.dbChatId,
          error: getErrorMessage(err),
        });
        stageTimes.draft_generation = Date.now() - draftGenStart;

        triage = {
          label: classification.label,
          confidence: classification.confidence,
          method: "model",
          reasoning: `${classification.reasoning}\n[Draft generation failed: ${getErrorMessage(err)}]`,
          action: "escalate",
          draft: null,
          draftConfidence: null,
        };
      }
    }

    // Persist classification once (after all processing is done)
    await persistClassification(env.DB, msg.dbMessageId, msg.dbChatId, {
      label: triage.label,
      confidence: triage.confidence,
      method: triage.method,
      reasoning: triage.reasoning,
    });

    // Calculate timing: LLM work = everything except build_context and handle_result
    stageTimes.llm_triage = Date.now() - triageStart
      - stageTimes.build_context
      - (stageTimes.build_draft_context || 0)
      - (stageTimes.draft_generation || 0);
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
 * Build rich draft context when needed (for draft_only or escalate actions).
 *
 * This creates a focused, metadata-rich context for draft generation.
 * Called within handleTriageResult when a draft is needed.
 */
export async function buildRichDraftContext(
  env: Env,
  dbChatId: number,
  senderId: number,
  targetMessage: { text: string; senderName: string; senderId: number },
): Promise<DraftContext> {
  return buildDraftContext(
    env.DB,
    dbChatId,
    senderId,
    targetMessage,
    async (chatId) => {
      const summary = await getOrRefreshSummary(env.DB, chatId, env);
      return summary?.content ?? null;
    },
    getRecentMessagesWithSenders,
  );
}
