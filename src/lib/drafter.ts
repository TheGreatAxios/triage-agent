import { generateText } from "ai";
import type { Env } from "../types/env";
import type { ClassificationResult } from "../types/classification";
import type { DraftStatus } from "../types/draft";
import { getModel } from "./ai";
import { getOrRefreshSummary } from "./summary";
import { evaluateResponsePolicy } from "./config";
import { logger } from "./logger";
import { getRecentMessagesWithSenders, buildMessageContext } from "./queries";
import { DatabaseError, AIError, getErrorMessage } from "./errors";
import { sanitizeContextInput } from "./sanitize";
import { validateLinks, sanitizeInvalidLinks } from "./links";

export interface DraftResult {
  draftId: number;
  content: string;
  confidence: number;
  responseConfidence: number; // AI self-assessment of response quality
  status: DraftStatus;
  policyAction: "auto_send" | "draft_only" | "escalate";
  policyReason: string;
  toolsUsed?: string[];
  toolResults?: Array<{ tool: string; summary: string }>;
}

interface StructuredDraft {
  response: string;
  confidence: number; // Self-assessment 0-1
  reasoning: string;
}

const DRAFT_PROMPT = `You are a helpful support assistant for a Telegram community.
Given the recent conversation context, generate a brief, helpful response.

Rules:
- Be concise and direct (1-3 sentences max)
- Be friendly but professional
- If you're unsure, say so honestly
- Never make up information
- Use markdown for code: \`inline\` or \`\`\`blocks\`\`\`
- Include links to documentation when available
- Verify any links you provide (must return 200)
- Respond naturally as if you're part of the chat

Self-assess your confidence in this response (0-1):
- 0.9-1.0: Exact solution, verified links, very confident
- 0.8-0.9: Good approach, working links, minor uncertainty  
- 0.7-0.8: Reasonable but needs verification
- <0.8: Don't auto-send, needs human review

Respond in this exact JSON format:
{"response": "your response text with \`code\` and [links](url)", "confidence": 0.92, "reasoning": "brief explanation"}`;

/**
 * Generate a draft response for a chat using recent context and AI.
 * Evaluates the response policy (with dual-confidence for bugs/requests) and persists the draft.
 */
export async function generateDraft(
  env: Env,
  chatId: number,
  classification: ClassificationResult,
  toolContext?: string, // Optional: results from MCP tools
  toolResults?: Array<{ tool: string; result: unknown; summary: string }> // Optional: raw tool results for persistence
): Promise<DraftResult> {
  const context = await buildContext(env.DB, chatId);
  const fullContext = toolContext ? `${context}\n\nExternal resources:\n${toolContext}` : context;

  const structured = await generateStructuredDraft(env, fullContext);

  // Validate and sanitize links before persisting
  const linkChecks = await validateLinks(structured.response);
  const sanitizedResponse = sanitizeInvalidLinks(structured.response, linkChecks);
  const invalidLinkCount = linkChecks.filter((l) => !l.valid).length;

  // Reduce confidence if links are invalid
  let adjustedConfidence = structured.confidence;
  if (invalidLinkCount > 0) {
    adjustedConfidence = Math.max(0, structured.confidence - 0.1 * invalidLinkCount);
    logger.warn("Draft has invalid links, reducing confidence", {
      chatId,
      invalidCount: invalidLinkCount,
    });
  }

  const policy = evaluateResponsePolicy(classification, adjustedConfidence);

  const status: DraftStatus =
    policy.action === "auto_send"
      ? "pending"
      : policy.action === "escalate"
        ? "escalated"
        : "pending";

  const toolsUsed = toolResults?.map((r) => r.tool);
  const toolResultsForPersist = toolResults?.map((r) => ({ tool: r.tool, summary: r.summary }));

  const draftId = await persistDraft(
    env.DB,
    chatId,
    sanitizedResponse,
    classification.confidence,
    adjustedConfidence,
    status,
    toolsUsed,
    toolResultsForPersist
  );

  logger.info("Draft generated", {
    chatId,
    draftId,
    classificationConfidence: classification.confidence,
    responseConfidence: adjustedConfidence,
    originalConfidence: structured.confidence,
    invalidLinks: invalidLinkCount,
    action: policy.action,
    reason: policy.reason,
  });

  return {
    draftId,
    content: sanitizedResponse,
    confidence: classification.confidence,
    responseConfidence: adjustedConfidence,
    status,
    policyAction: policy.action,
    policyReason: policy.reason,
    toolsUsed,
    toolResults: toolResultsForPersist,
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

async function generateStructuredDraft(env: Env, context: string): Promise<StructuredDraft> {
  try {
    const model = getModel(env, "draft");
    // Sanitize conversation context to prevent prompt injection
    const sanitizedContext = sanitizeContextInput(context);
    const { text } = await generateText({
      model,
      system: DRAFT_PROMPT,
      prompt: `Here is the conversation context:\n\n${sanitizedContext}\n\nGenerate a helpful response with confidence assessment:`,
      maxOutputTokens: 300,
      providerOptions: {
        openai: {
          reasoningEffort: "none",
          serviceTier: "flex",
        },
      },
    });

    // Parse structured JSON response
    const parsed = parseStructuredDraft(text);
    if (parsed) {
      return parsed;
    }

    // Fallback: treat entire response as the draft with low confidence
    logger.warn("Failed to parse structured draft, using fallback", { raw: text.slice(0, 200) });
    return {
      response: text.trim(),
      confidence: 0.6,
      reasoning: "Unstructured response - parse failed",
    };
  } catch (err) {
    const error = new AIError(
      "Draft generation failed",
      "workers-ai",
      "@cf/meta/llama-3.1-8b-instruct",
      "draft",
      { originalError: getErrorMessage(err) }
    );
    logger.error(error.message, error.toJSON());
    return {
      response: "I'm not sure how to help with that. Let me get a human to assist you.",
      confidence: 0.0,
      reasoning: "Generation failed",
    };
  }
}

function parseStructuredDraft(text: string): StructuredDraft | null {
  try {
    // Extract JSON from response (handles cases where model adds extra text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<StructuredDraft>;

    // Validate required fields
    if (typeof parsed.response !== "string" || typeof parsed.confidence !== "number") {
      return null;
    }

    // Normalize confidence to 0-1 range
    const confidence = Math.max(0, Math.min(1, parsed.confidence));

    return {
      response: parsed.response.trim(),
      confidence,
      reasoning: parsed.reasoning || "No reasoning provided",
    };
  } catch {
    return null;
  }
}

async function persistDraft(
  db: D1Database,
  chatId: number,
  content: string,
  confidence: number,
  responseConfidence: number,
  status: DraftStatus,
  toolsUsed?: string[],
  toolResults?: Array<{ tool: string; summary: string }>
): Promise<number> {
  try {
    await db
      .prepare(
        `INSERT INTO drafts (chat_id, content, confidence, response_confidence, status, tools_used, tool_results)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        chatId,
        content,
        confidence,
        responseConfidence,
        status,
        toolsUsed ? JSON.stringify(toolsUsed) : null,
        toolResults ? JSON.stringify(toolResults) : null
      )
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
      { chatId, error: getErrorMessage(err) }
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
      error: getErrorMessage(err),
    });
    return false;
  }
}
