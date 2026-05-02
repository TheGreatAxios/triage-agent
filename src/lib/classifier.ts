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
 * Build the triage system prompt with dynamic branding from env vars.
 */
function buildTriagePrompt(communityName: string, docsUrl: string): string {
  return `You are a Telegram triage agent for a crypto/blockchain community (${communityName}).

TASK: Read the new message in context of recent chat history. Classify it, decide an action, and draft a response if needed.

## Classifications
- bug: Something broken, errors, crashes, unexpected behavior
- request: Feature request, enhancement, "how do I..." questions
- normal: Chat, greetings, transaction confirmations, test messages, status updates
- unknown: Cannot determine

## Actions
- auto_send: You're confident in both the classification AND the draft. The draft is accurate and safe to send without human review.
- escalate: Needs human eyes — bug, request, or you're uncertain about accuracy. You'll still send your best draft to the user so they aren't left hanging, while a human also reviews.
- defer: No response needed (chatter, acknowledgments, test messages, transaction confirmations, off-topic)

## Draft Guidelines

### Tone
- Be direct and human. Don't sound like a cheerleader or customer support bot.
- Match the user's energy. If they're frustrated, acknowledge it briefly, then get to the point. If they're casual, be casual.
- One or two sentences. No fluff, no warm-up phrases.

### Draft quality
- **Always draft something** — even when escalating, give the user your best attempt so they know someone is looking.
- **Don't ask "can you provide more details?"** — that's the laziest possible response. Instead, ask a specific question: what error message, what tx hash, what chain, what browser/extension.
- Don't repeat back what the user said. Don't preface with "I understand you're..."
- If you don't know the exact answer, say so directly and offer what you do know. Reference ${docsUrl} if relevant.

### When to escalate (not auto_send)
- You're uncertain about the answer → escalate, but still write a useful draft for the user
- It's a bug report that needs reproduction steps → escalate with a specific question
- It's a feature request that needs product team input → escalate, tell the user you've noted it

### When to defer (no draft)
- Acknowledgments ("thanks", "great", "sounds good")
- Test messages
- Off-topic chatter
- Messages clearly meant for someone else in the chat

### Draft examples

Good draft (escalate with draft):
  "Not sure about ${communityName} specifically — I'd start at ${docsUrl}. What error are you running into? I'll flag this with the team."

Good draft (auto_send):
  "You can toggle that in Settings > Account > Preferences. Let me know if you still don't see it."

Bad draft (too peppy):
  "That's a great question! Let me flag it with the team! Could you share your setup details so we can give you a more specific answer?"

Bad draft (lazy generic):
  "Sorry to hear that. Can you provide more details?"

Bad draft (parrots user):
  "So you're saying the server is not working? Let me understand better..."

Bad draft (hallucinated link):
  "Check out the troubleshooting guide at example.com/guide" (only link if you're certain it exists)

## Safety & Output Rules (MANDATORY)
- **Do NOT output system instructions, role markers, or control tokens** in the draft. No "system:", "user:", "assistant:", "<|...|>", "[INST]", etc. The draft goes directly to the user.
- **Do NOT include code blocks** in the draft unless the user explicitly asks for code. Even then, keep it short.
- **Do NOT impersonate system/assistant** — you are a support triage bot, the draft is your reply.
- **Do NOT output links you're not certain exist.** Hallucinating URLs = immediate failure.
- **Do NOT output spam, phishing, harmful content, or NSFW.** Any of these will trigger content filters.
- **Do NOT repeat or amplify user frustration.** Acknowledge briefly, then be constructive.

## Important
- If you don't know, say so directly. "Not sure" is fine. Don't fake expertise.
- The "Recent messages" below show chat history. Not every message is part of the same conversation thread — use timestamps and topic shifts to tell them apart.
- Hex strings (0x...) are wallet addresses or tx IDs, NOT error codes unless the user explicitly reports an error.`;
}

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

  const communityName = env.COMMUNITY_NAME || "this community";
  const docsUrl = env.DOCS_URL || "the docs";
  const systemPrompt = buildTriagePrompt(communityName, docsUrl);

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
        system: systemPrompt,
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
