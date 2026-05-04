import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { InternalEvent } from "../types/events";
import type { ClassificationLabel, TriageResult } from "../types/classification";
import type { Env } from "../types/env";
import { getTaskTiers, resolveModel } from "./ai";
import { logger } from "./logger";
import { AIError, getErrorMessage } from "./errors";
import { sanitizePromptInput, sanitizeContextInput } from "./sanitize";
import { withTimeout } from "./timeout";

// ── Schemas ──────────────────────────────────────────────────────────────

/**
 * Zod schema for classification output.
 * No draft fields — classification is separate from drafting.
 */
const classifySchema = z.object({
  label: z.enum(["bug", "request", "normal", "unknown", "financial_help"]),
  confidence: z.number().min(0).max(1),
  action: z.enum(["draft_only", "escalate", "defer"]),
  reasoning: z.string(),
});

type ClassifySchema = z.infer<typeof classifySchema>;

// ── Classification Prompt ────────────────────────────────────────────────

/**
 * Build the classification prompt.
 *
 * Pure classification: what is this message, what should we do about it.
 * Zero draft guidance — that's a separate call.
 */
function buildClassifyPrompt(communityName: string): string {
  return `You classify messages in a crypto/blockchain community (${communityName}).

Read the message in context of recent chat history. Output exactly what it is and what action to take.

## Labels
- bug: Something broken, errors, crashes, unexpected behavior
- request: Feature request, enhancement, "how do I..." questions
- normal: Chat, greetings, transaction confirmations, test messages, status updates
- unknown: Cannot determine
- financial_help: User asking for money, tokens, airdrops, investment advice, or any form of financial assistance

## Actions
- draft_only: You know what to say and can write a useful response. Use for technical questions, how-to questions, known issues. Always draft_only when you're confident.
- escalate: Needs a human. Use for: financial_help (always), complex bugs you can't diagnose, feature requests needing product input, or when uncertain.
- defer: No response needed. Acknowledgments ("thanks", "got it"), test messages, off-topic chatter, messages for someone else.

## Rules
- financial_help ALWAYS gets escalate. No exceptions.
- Unknown → escalate. Don't guess.
- Technical problems with clear answers → draft_only.
- If in doubt, escalate. Better to have a human review than give wrong info.
- Your reasoning should be 1-2 sentences showing your thought process.`;
}

// ── Draft Prompt ─────────────────────────────────────────────────────────

/**
 * Build the draft generation prompt.
 *
 * Pure writing: given what we know about the message, write a response.
 * Short, persona-driven, zero negative constraints.
 */
function buildDraftPrompt(communityName: string, docsUrl: string): string {
  return `You're a knowledgeable community member helping in a ${communityName} Telegram group.

Someone asked a question or reported an issue. Write a reply.

## Voice
- Write like you're texting a friend who needs help.
- Lead with the answer. Say what you know in the first sentence.
- Use common sense: if it's a 5-second fix, tell them. If it's complex, say what you know and what you'd check next.
- If you're not sure, say "Not sure" or "I don't know" — then say what you *do* know or what you'd try.
- Be specific. Instead of "check your settings", say "Check Settings > Account > Preferences".
- Ask one specific question if you need more info: "What error do you see?" or "Which chain?"
- Contractions are fine. So is a casual tone. Don't overthink it.

## What you know
- ${docsUrl} — reference this if relevant
- The chat history and the new message are provided below.
- If you reference a URL, make sure it's real. Don't make up URLs.

Write the response. No preamble, no sign-off. Just the message.`;
}

// ── Main Functions ───────────────────────────────────────────────────────

/**
 * Classify a message: determine label, action, and reasoning.
 *
 * Uses generateObject with a Zod schema for reliable structured output.
 * No draft generation here — that's a separate step if needed.
 */
export async function classifyMessage(
  env: Env,
  event: InternalEvent,
  context: string,
): Promise<{ label: ClassificationLabel; confidence: number; action: "draft_only" | "escalate" | "defer"; reasoning: string }> {
  const sanitizedContext = sanitizeContextInput(context);
  const sanitizedText = sanitizePromptInput(event.text);
  const communityName = env.COMMUNITY_NAME || "this community";
  const systemPrompt = buildClassifyPrompt(communityName);

  const tiers = getTaskTiers("triage");
  let lastError: unknown;

  for (let tierIdx = 0; tierIdx < tiers.length; tierIdx++) {
    const config = tiers[tierIdx];
    const tier = tierIdx + 1;
    try {
      const model = resolveModel(env, config);

      logger.info("Classification model selected", {
        task: "triage",
        tier,
        provider: config.provider,
        model: config.model,
        retry: tierIdx > 0,
      });

      const result = await withTimeout(
        generateObject({
          model,
          schema: classifySchema,
          schemaName: "classify",
          schemaDescription: "Classify the message and decide what action to take",
          system: systemPrompt,
          prompt: `Context:\n${sanitizedContext}\n\nMessage to classify:\n${sanitizedText}`,
        }),
        25000,
        "llm_classify",
      );

      const parsed = result.object;

      logger.debug("Classification result", {
        messageId: event.messageId,
        tier,
        label: parsed.label,
        confidence: parsed.confidence,
        action: parsed.action,
      });

      return {
        label: parsed.label as ClassificationLabel,
        confidence: parsed.confidence,
        action: parsed.action,
        reasoning: parsed.reasoning,
      };
    } catch (err) {
      lastError = err;
      logger.warn("Classification tier failed, trying next", {
        messageId: event.messageId,
        tier,
        provider: config.provider,
        model: config.model,
        error: getErrorMessage(err),
      });
    }
  }

  // All tiers exhausted — throw, caller will escalate
  const errorMsg = getErrorMessage(lastError);
  logger.error("Classification LLM call failed — all tiers exhausted", {
    messageId: event.messageId,
    error: errorMsg,
    context: sanitizedContext.slice(0, 200),
    text: sanitizedText.slice(0, 200),
  });
  throw new AIError(
    `Classification failed: ${errorMsg}`,
    "unknown",
    "unknown",
    "triage",
    {
      messageId: event.messageId,
      chatId: event.chatId,
    },
  );
}

/**
 * Generate a draft response for a classified message.
 *
 * Only called when action is draft_only or escalate.
 * Separated from classification so each task has a clean, focused prompt.
 */
export async function draftResponse(
  env: Env,
  event: InternalEvent,
  context: string,
  classification: { label: string; reasoning: string },
): Promise<{ draft: string; draftConfidence: number }> {
  const sanitizedContext = sanitizeContextInput(context);
  const sanitizedText = sanitizePromptInput(event.text);
  const communityName = env.COMMUNITY_NAME || "this community";
  const docsUrl = env.DOCS_URL || "the docs";
  const systemPrompt = buildDraftPrompt(communityName, docsUrl);

  const tiers = getTaskTiers("draft");
  let lastError: unknown;

  for (let tierIdx = 0; tierIdx < tiers.length; tierIdx++) {
    const config = tiers[tierIdx];
    const tier = tierIdx + 1;
    try {
      const model = resolveModel(env, config);

      logger.info("Draft model selected", {
        task: "draft",
        tier,
        provider: config.provider,
        model: config.model,
        retry: tierIdx > 0,
      });

      const result = await withTimeout(
        generateText({
          model,
          system: systemPrompt,
          prompt: `Context:\n${sanitizedContext}\n\nUser message:\n${sanitizedText}\n\nClassification: ${classification.label}\nReasoning: ${classification.reasoning}\n\nWrite the reply:`,
          maxOutputTokens: 300,
        }),
        15000,
        "llm_draft",
      );

      const draft = result.text.trim();
      if (!draft) {
        throw new Error("Draft generation returned empty text");
      }

      return {
        draft,
        draftConfidence: 0.8, // Fixed moderate confidence — we could use a separate self-eval but that's overkill
      };
    } catch (err) {
      lastError = err;
      logger.warn("Draft tier failed, trying next", {
        messageId: event.messageId,
        tier,
        provider: config.provider,
        model: config.model,
        error: getErrorMessage(err),
      });
    }
  }

  // All tiers exhausted
  const errorMsg = getErrorMessage(lastError);
  logger.error("Draft LLM call failed — all tiers exhausted", {
    messageId: event.messageId,
    error: errorMsg,
    context: sanitizedContext.slice(0, 200),
    text: sanitizedText.slice(0, 200),
  });
  throw new AIError(
    `Draft generation failed: ${errorMsg}`,
    "unknown",
    "unknown",
    "draft",
    {
      messageId: event.messageId,
      chatId: event.chatId,
    },
  );
}

// ── Triage Pipeline (orchestrates classify + draft) ──────────────────────

/**
 * Single-call triage: classify a message, then draft if needed.
 *
 * Two-step process:
 * 1. Classify (generateObject with schema)
 * 2. Draft if action is draft_only or escalate (generateText)
 *
 * This keeps each prompt clean and focused on one task.
 */
export async function triageMessage(
  env: Env,
  event: InternalEvent,
  context: string,
): Promise<TriageResult> {
  const classification = await classifyMessage(env, event, context);

  // If defer, no draft needed
  if (classification.action === "defer") {
    return {
      label: classification.label,
      confidence: classification.confidence,
      method: "model",
      reasoning: classification.reasoning,
      action: "defer",
      draft: null,
      draftConfidence: null,
    };
  }

  // Generate draft for draft_only or escalate
  try {
    const draftResult = await draftResponse(env, event, context, {
      label: classification.label,
      reasoning: classification.reasoning,
    });

    return {
      label: classification.label,
      confidence: classification.confidence,
      method: "model",
      reasoning: classification.reasoning,
      action: classification.action,
      draft: draftResult.draft,
      draftConfidence: draftResult.draftConfidence,
    };
  } catch (err) {
    // Draft failed — still return classification, just without a draft.
    // Action becomes escalate so the human gets notified in Slack.
    logger.error("Draft generation failed, escalating without draft", {
      messageId: event.messageId,
      chatId: event.chatId,
      error: getErrorMessage(err),
    });

    return {
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
