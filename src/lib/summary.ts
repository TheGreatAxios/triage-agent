import { generateObject } from "ai";
import { z } from "zod";
import { getConfig } from "./config";
import { getTaskTiers, resolveModel } from "./ai";
import { logger } from "./logger";
import { getErrorMessage } from "./errors";
import { sanitizeContextInput } from "./sanitize";
import { withTimeout } from "./timeout";
import { getRecentMessagesWithSenders } from "./queries";
import type { Env } from "../types/env";

export interface ChatSummary {
  id: number;
  chatId: number;
  content: string;
  messageRangeStart: number | null;
  messageRangeEnd: number | null;
  createdAt: string;
}

interface MessageRow {
  id: number;
  text: string | null;
  display_name: string;
  created_at: string;
}

/** Structured summary output from the AI model. */
const summarySchema = z.object({
  participants: z.array(z.string()).describe("All named participants in this conversation"),
  keyTopics: z.array(z.string()).describe("Main topics discussed — 2-5 concise items"),
  decisions: z.array(z.string()).describe("Any decisions made or conclusions reached"),
  openQuestions: z.array(z.string()).describe("Open or unresolved questions"),
  recentActivity: z.string().describe("What happened recently, in 1-2 sentences"),
});

type SummarySchema = z.infer<typeof summarySchema>;

/**
 * Build the summarization system prompt.
 */
function buildSummaryPrompt(communityName: string): string {
  return `You are a conversation analyst for the ${communityName} Telegram community.

TASK: Read the conversation transcript below and produce a structured summary.

Focus on:
- **Participants** — who is involved in the conversation (by name/username)
- **Key Topics** — what's being discussed right now
- **Decisions** — anything that was decided or concluded
- **Open Questions** — unresolved questions, requests for help, blocked issues
- **Recent Activity** — what just happened in 1-2 sentences

Be concise and factual. Don't make up information. If the conversation is trivial (greetings, test messages), say so.

The messages are shown with sender name and a relative timestamp (e.g. "2m ago"). Use timestamps to distinguish separate conversation threads from topic shifts.`;
}

/**
 * Get the latest summary for a chat, refreshing if stale.
 * Returns null if there are no messages to summarize.
 *
 * Accepts an optional env parameter — when provided, uses the AI model
 * configured for the "summarize" task to generate structured summaries.
 * Falls back to raw message concatenation if env is not provided or AI fails.
 */
export async function getOrRefreshSummary(
  db: D1Database,
  chatId: number,
  env?: Env,
): Promise<ChatSummary | null> {
  const existing = await getLatestSummary(db, chatId);

  if (existing && !isSummaryStale(existing)) {
    return existing;
  }

  const messages = await getRecentMessagesForSummary(db, chatId);
  if (messages.length === 0) return existing;

  let content: string;

  if (env) {
    content = await buildAISummary(env, messages);
  } else {
    content = buildRawSummaryContent(messages);
  }

  const rangeStart = messages[0].id;
  const rangeEnd = messages[messages.length - 1].id;

  await saveSummary(db, chatId, content, rangeStart, rangeEnd);

  logger.info("Summary refreshed", {
    chatId,
    messageCount: messages.length,
    aiGenerated: !!env,
    rangeStart,
    rangeEnd,
  });

  return getLatestSummary(db, chatId);
}

/**
 * Get the most recent summary for a chat.
 */
async function getLatestSummary(
  db: D1Database,
  chatId: number
): Promise<ChatSummary | null> {
  const row = await db
    .prepare(
      `SELECT id, chat_id, content, message_range_start, message_range_end, created_at
       FROM summaries
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(chatId)
    .first<{
      id: number;
      chat_id: number;
      content: string;
      message_range_start: number | null;
      message_range_end: number | null;
      created_at: string;
    }>();

  if (!row) return null;

  return {
    id: row.id,
    chatId: row.chat_id,
    content: row.content,
    messageRangeStart: row.message_range_start,
    messageRangeEnd: row.message_range_end,
    createdAt: row.created_at,
  };
}

function isSummaryStale(summary: ChatSummary): boolean {
  const config = getConfig();
  const ageMs = Date.now() - new Date(summary.createdAt).getTime();
  const maxAgeMs = config.summaryMaxAgeMinutes * 60 * 1000;
  return ageMs > maxAgeMs;
}

/**
 * Fetch recent messages for a chat to build a summary from.
 * Uses maxHotMessages config to limit the window.
 */
async function getRecentMessagesForSummary(
  db: D1Database,
  chatId: number
): Promise<MessageRow[]> {
  const config = getConfig();

  const messages = await getRecentMessagesWithSenders(db, {
    chatId,
    limit: config.maxHotMessages,
    order: "desc",
  });

  // Reverse to chronological order for summary building
  return messages.reverse();
}

/**
 * Build an AI-generated structured summary from conversation messages.
 * Uses the same multi-tier fallback pattern as the classifier.
 *
 * Falls back to raw message concatenation if all AI tiers fail.
 */
async function buildAISummary(
  env: Env,
  messages: MessageRow[],
): Promise<string> {
  const conversationText = messages
    .map((m) => `[${m.display_name}]: ${m.text ?? ""}`)
    .join("\n");

  const communityName = env.COMMUNITY_NAME || "this community";
  const tiers = getTaskTiers("summarize");
  let lastError: unknown;

  for (let tierIdx = 0; tierIdx < tiers.length; tierIdx++) {
    const config = tiers[tierIdx];
    const tier = tierIdx + 1;
    try {
      // Skip tiers that require API keys we don't have
      if (config.provider !== "workers-ai") {
        const keyName = `${config.provider.toUpperCase()}_API_KEY` as keyof Env;
        if (!env[keyName]) {
          logger.debug(`Summary tier ${tier} skipped — no API key`, {
            provider: config.provider,
          });
          continue;
        }
      }

      const model = resolveModel(env, config);
      const systemPrompt = buildSummaryPrompt(communityName);

      const result = await withTimeout(
        generateObject({
          model,
          schema: summarySchema,
          schemaName: "conversation_summary",
          schemaDescription: "Structured summary of a Telegram group conversation",
          system: systemPrompt,
          prompt: sanitizeContextInput(
            `Here is the recent conversation transcript. Produce a structured summary.\n\n${conversationText}`
          ),
        }),
        20000,
        "llm_summary",
      );

      const parsed = result.object;
      return formatSummary(parsed);
    } catch (err) {
      lastError = err;
      logger.warn("Summary AI tier failed, trying next", {
        tier,
        provider: config.provider,
        model: config.model,
        error: getErrorMessage(err),
      });
    }
  }

  // All AI tiers failed — fall back to raw concatenation
  logger.warn("All summary AI tiers failed — falling back to raw text", {
    error: getErrorMessage(lastError),
  });
  return buildRawSummaryContent(messages);
}

/**
 * Format a structured summary into a compact plain-text string
 * that can be fed into the triage system prompt as context.
 */
function formatSummary(s: SummarySchema): string {
  const parts: string[] = [];

  if (s.participants.length > 0) {
    parts.push("People: " + s.participants.join(", "));
  }

  if (s.keyTopics.length > 0) {
    parts.push("Topics: " + s.keyTopics.join(", "));
  }

  if (s.recentActivity) {
    parts.push("Recent: " + s.recentActivity);
  }

  if (s.decisions.length > 0) {
    parts.push("Decided: " + s.decisions.join(", "));
  }

  if (s.openQuestions.length > 0) {
    parts.push("Open: " + s.openQuestions.join(", "));
  }

  return parts.join("\n");
}

/**
 * Build a plain-text summary from messages (raw mode fallback).
 */
function buildRawSummaryContent(messages: MessageRow[]): string {
  const lines = messages.map(
    (m) => `[${m.display_name}]: ${m.text ?? ""}`
  );
  return lines.join("\n");
}

async function saveSummary(
  db: D1Database,
  chatId: number,
  content: string,
  rangeStart: number,
  rangeEnd: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO summaries (chat_id, content, message_range_start, message_range_end)
       VALUES (?, ?, ?, ?)`
    )
    .bind(chatId, content, rangeStart, rangeEnd)
    .run();
}
