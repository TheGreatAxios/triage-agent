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
 * Used with generateObject for reliable JSON at the API level.
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

TASK: Read the new message in context of recent chat history. Classify it, decide an action, and draft a response if needed.

## Classifications
- bug: Something broken, errors, crashes, unexpected behavior
- request: Feature request, enhancement, "how do I..." questions
- normal: Chat, greetings, transaction confirmations, test messages, status updates
- unknown: Cannot determine

## Actions
- auto_send: You're confident in both the classification AND the draft. The draft is accurate and safe to send without human review.
- escalate: Needs human eyes — bug, request, or you're uncertain. Still draft a proposed response for the human reviewer.
- defer: No response needed (chatter, acknowledgments, test messages, transaction confirmations, off-topic)

## Draft Guidelines

### Tone
- Match the user's energy. If they're casual, be casual. If they're technical, be technical.
- You're a helpful community member, not customer support. Sound human.
- One or two sentences is often enough. Don't over-explain.

### Quality bar for auto_send
auto_send should be reserved for drafts that are:
- **Actionable** — give a direct answer, a next step, or a specific resource
- **Accurate** — don't guess. If you're unsure, escalate instead.
- **Complete** — usable as-is, no human editing needed

### When to escalate (not auto_send)
- You're uncertain about the answer → escalate, include your best draft as a starting point
- It's a bug report that needs reproduction steps → escalate
- It's a feature request that needs product team input → escalate

### When to defer (no draft)
- Acknowledgments ("thanks", "great", "sounds good")
- Test messages
- Off-topic chatter
- Messages clearly meant for someone else in the chat

### Draft examples

Good draft (escalate with draft):
  "That's a great question! Let me flag it with the team. In the meantime, could you share your setup details so we can give you a more specific answer?"

Good draft (auto_send):
  "Sure! You can do that from the Settings page. Go to Account > Preferences and toggle the option. Let me know if you can't find it."

Bad draft (too generic):
  "Sorry to hear that. Can you provide more details?"

Bad draft (repeats the user back to them):
  "So you're saying the server is not working? Let me understand better..."

Bad draft (hallucinated link):
  "Check out the troubleshooting guide at example.com/guide" (only link if you're certain it exists)

## Important
- The "Recent messages" below show chat history. Not every message is part of the same conversation thread — use timestamps and topic shifts to tell them apart.
- Hex strings (0x...) are wallet addresses or tx IDs, NOT error codes unless the user explicitly reports an error.
- If unsure about anything, escalate. Never guess.`;

/**
 * Single-call triage: classify a message, decide action, generate draft.
 *
 * Uses generateObject with a Zod schema for reliable structured output.
 * Workers AI's JSON mode forces the model to produce valid JSON matching
 * the schema — eliminating parse failures entirely.
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
