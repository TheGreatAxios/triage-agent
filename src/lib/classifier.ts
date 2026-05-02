import { generateObject } from "ai";
import { z } from "zod";
import type { InternalEvent } from "../types/events";
import type { ClassificationLabel, TriageResult } from "../types/classification";
import type { Env } from "../types/env";
import { getTracedModel } from "./ai";
import { logger } from "./logger";
import { AIError, getErrorMessage } from "./errors";
import { sanitizePromptInput, sanitizeContextInput } from "./sanitize";
import { withTimeout } from "./timeout";

/**
 * Zod schema for structured triage output.
 * Used with generateText + output for reliable JSON at the API level.
 */
const triageSchema = z.object({
  label: z.enum(["bug", "request", "normal", "unknown"]),
  confidence: z.number().min(0).max(1),
  action: z.enum(["auto_send", "escalate", "defer"]),
  draft: z.string().nullable(),
  draftConfidence: z.number().min(0).max(1).nullable(),
  reasoning: z.string(),
});

/** Inferred type from the triage schema. */
type TriageSchema = z.infer<typeof triageSchema>;

/**
 * Unified triage prompt: classify + draft + action in a single LLM call.
 */
const TRIAGE_PROMPT = `You are a Telegram triage agent for a crypto/blockchain community (SKALE Network).

TASK: Read the message in context → classify → decide action → draft a response if needed.

## Classifications
- bug: Something broken, errors, crashes, unexpected behavior
- request: Feature request, enhancement, "how do I..." questions
- normal: Chat, greetings, transaction confirmations, test messages, status updates
- unknown: Cannot determine

## Actions
- auto_send: You're confident in both the classification AND the draft. The draft is accurate and safe to send without human review.
- escalate: Needs human eyes — bug, request, or you're uncertain. Still draft a proposed response for the human reviewer.
- defer: No response needed (chatter, acknowledgments, test messages, transaction confirmations, off-topic)

## Draft Rules
- Be clear, concise, and personable. Don't waste words.
- Use bullet points when listing multiple items.
- Include complete, runnable code examples when relevant — use proper markdown.
- Only include URLs you are certain exist. Never fabricate links.
- If you reference docs, use the SKALE docs site (https://docs.skale.network).
- Address the user directly and naturally — you're a helpful community member, not a robot.
- Match the user's tone: casual for casual, technical for technical.
- When unsure, say so honestly and escalate.

## Important
- Hex strings (0x...) are wallet addresses or tx IDs, NOT error codes unless the user explicitly reports an error.
- If unsure about anything, escalate. Never guess.`;

/**
 * Single-call triage: classify a message, decide action, generate draft.
 *
 * Uses generateObject (generateText + output: object()) with a Zod schema
 * for reliable structured output. Workers AI's JSON mode forces the model
 * to produce valid JSON matching the schema — no parse failures.
 *
 * Returns TriageResult with everything needed to act.
 */
export async function triageMessage(
  env: Env,
  event: InternalEvent,
  context: string,
): Promise<TriageResult> {
  const sanitizedContext = sanitizeContextInput(context);
  const sanitizedText = sanitizePromptInput(event.text);

  const model = getTracedModel(env, "triage");

  // Timeout LLM call at 25s — Workers AI cold starts can take 10-15s.
  // Leaves ~5s headroom for DB ops + Slack within 30s waitUntil limit.
  let parsed: TriageSchema;
  try {
    const result = await withTimeout(
      generateObject({
        model,
        schema: triageSchema,
        schemaName: "triage",
        schemaDescription: "Classify the message, decide an action, and draft a response",
        system: TRIAGE_PROMPT,
        prompt: `Context:\n${sanitizedContext}\n\nMessage to triage:\n${sanitizedText}`,
      }),
      25000,
      "llm_triage",
    );
    parsed = result.object;
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    const details = err instanceof Error ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : String(err);
    logger.error("Triage LLM call failed", {
      messageId: event.messageId,
      error: errorMsg,
      errorDetails: details.slice(0, 2000),
      stack: err instanceof Error ? err.stack : undefined,
      context: sanitizedContext.slice(0, 200),
      text: sanitizedText.slice(0, 200),
    });
    throw new AIError(
      `Triage LLM call failed: ${errorMsg}`,
      "unknown",
      "unknown",
      "triage",
      {
        messageId: event.messageId,
        chatId: event.chatId,
        context: sanitizedContext.slice(0, 500),
        text: sanitizedText.slice(0, 500),
      },
    );
  }

  logger.debug("Triage result", {
    messageId: event.messageId,
    label: parsed.label,
    confidence: parsed.confidence,
    action: parsed.action,
  });

  return buildTriageResult(parsed);
}

/**
 * Build a TriageResult from a validated schema object.
 */
function buildTriageResult(parsed: TriageSchema): TriageResult {
  const draft = parsed.draft && parsed.draft.length > 0 ? parsed.draft : null;

  return {
    label: parsed.label as ClassificationLabel,
    confidence: parsed.confidence,
    method: "model",
    reasoning: parsed.reasoning ?? "Classified by triage model",
    action: parsed.action as TriageResult["action"],
    draft,
    draftConfidence: draft !== null ? parsed.draftConfidence : null,
  };
}
