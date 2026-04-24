import { generateText } from "ai";
import type { Env } from "../types/env";
import type { ClassificationResult } from "../types/classification";
import type { DraftStatus } from "../types/draft";
import { getModel } from "./ai";
import { getOrRefreshSummary } from "./summary";
import { evaluateResponsePolicy } from "./config";
import { logger } from "./logger";
import { getRecentMessagesWithSenders, buildMessageContext } from "./queries";
import { DatabaseError, AIError } from "./errors";

export interface DraftResult {
  draftId: number;
  content: string;
  confidence: number;
  status: DraftStatus;
  policyAction: "auto_send" | "draft_only" | "escalate";
  policyReason: string;
}

const DRAFT_PROMPT = `You are a helpful support assistant for a Telegram community.
Given the recent conversation context, generate a brief, helpful response.

Rules:
- Be concise and direct (1-3 sentences max)
- Be friendly but professional
- If you're unsure, say so honestly
- Never make up information
- Do not use markdown formatting
- Respond naturally as if you're part of the chat`;

/**
 * Generate a draft response for a chat using recent context and AI.
 * Evaluates the response policy and persists the draft with appropriate status.
 */
export async function generateDraft(
  env: Env,
  chatId: number,
  classification: ClassificationResult
): Promise<DraftResult> {
  const context = await buildContext(env.DB, chatId);
  const content = await generateDraftContent(env, context);
  const policy = evaluateResponsePolicy(classification.confidence, classification.label);

  const status: DraftStatus =
    policy.action === "auto_send"
      ? "pending"
      : policy.action === "escalate"
        ? "escalated"
        : "pending";

  const draftId = await persistDraft(env.DB, chatId, content, classification.confidence, status);

  logger.info("Draft generated", {
    chatId,
    draftId,
    confidence: classification.confidence,
    action: policy.action,
    reason: policy.reason,
  });

  return {
    draftId,
    content,
    confidence: classification.confidence,
    status,
    policyAction: policy.action,
    policyReason: policy.reason,
  };
}

async function buildContext(db: D1Database, chatId: number): Promise<string> {
  const summary = await getOrRefreshSummary(db, chatId);

  // Fetch recent messages with sender info using centralized query
  const messages = await getRecentMessagesWithSenders(db, {
    chatId,
    limit: 10,
    order: "desc",
  });

  // Reverse to chronological order for context building
  const recentMessages = buildMessageContext(messages.reverse());

  let context = "";
  if (summary) {
    context += `Summary:\n${summary.content}\n\n`;
  }
  context += `Recent messages:\n${recentMessages}`;

  return context;
}

async function generateDraftContent(env: Env, context: string): Promise<string> {
  try {
    const model = getModel(env, "draft");
    const { text } = await generateText({
      model,
      system: DRAFT_PROMPT,
      prompt: `Here is the conversation context:\n\n${context}\n\nGenerate a helpful response:`,
      maxOutputTokens: 200,
      providerOptions: {
        openai: {
          reasoningEffort: "none",  // No reasoning tokens for nano
          serviceTier: "flex",      // 50% cost savings
        },
      },
    });

    return text.trim();
  } catch (err) {
    const error = new AIError(
      "Draft generation failed",
      "workers-ai", // Could be dynamic based on actual provider
      "@cf/meta/llama-3.1-8b-instruct",
      "draft",
      { originalError: err instanceof Error ? err.message : String(err) }
    );
    logger.error(error.message, error.toJSON());
    return "I'm not sure how to help with that. Let me get a human to assist you.";
  }
}

async function persistDraft(
  db: D1Database,
  chatId: number,
  content: string,
  confidence: number,
  status: DraftStatus
): Promise<number> {
  try {
    await db
      .prepare(
        `INSERT INTO drafts (chat_id, content, confidence, status)
         VALUES (?, ?, ?, ?)`
      )
      .bind(chatId, content, confidence, status)
      .run();

    const row = await db
      .prepare(
        `SELECT id FROM drafts WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .bind(chatId)
      .first<{ id: number }>();

    if (!row) {
      throw new DatabaseError(
        `Draft was inserted but could not be retrieved`,
        "SELECT",
        "drafts",
        { chatId }
      );
    }

    return row.id;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `Failed to persist draft for chat ${chatId}`,
      "INSERT",
      "drafts",
      { chatId, error: err instanceof Error ? err.message : String(err) }
    );
  }
}

/**
 * Mark a draft as sent after successful Telegram delivery.
 */
export async function markDraftSent(db: D1Database, draftId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE drafts SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
    )
    .bind(draftId)
    .run();
}

/**
 * Send a message to a Telegram chat via the Bot API.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatTelegramId: number,
  text: string
): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatTelegramId,
        text,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("Telegram sendMessage failed", {
        status: resp.status,
        body,
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.error("Telegram sendMessage error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
