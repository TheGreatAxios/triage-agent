import { generateText } from "ai";
import type { InternalEvent } from "../types/events";
import type { ClassificationLabel, TriageResult } from "../types/classification";
import type { Env } from "../types/env";
import { getTracedModel } from "./ai";
import { logger } from "./logger";
import { getErrorMessage } from "./errors";
import { sanitizePromptInput, sanitizeContextInput } from "./sanitize";
import { withTimeout } from "./timeout";

/**
 * Unified triage prompt: classify + draft + action in a single LLM call.
 *
 * Output is capped at 150 tokens — enough for JSON with a short draft,
 * not enough for runaway output.
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
- If unsure about anything, escalate. Never guess.

Respond in JSON only:
{"label":"bug|request|normal|unknown","confidence":0.0-1.0,"action":"auto_send|escalate|defer","draft":"response text with markdown or null","draftConfidence":0.0-1.0 or null,"reasoning":"brief"}`;

/**
 * Single-call triage: classify a message, decide action, generate draft.
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

  try {
    const model = getTracedModel(env, "triage");

    // Timeout LLM call at 12s to stay well within waitUntil limits
    // (Leaves headroom for DB ops + escalation within 30s total)
    const { text } = await withTimeout(
      generateText({
        model,
        system: TRIAGE_PROMPT,
        prompt: `Context:\n${sanitizedContext}\n\nMessage to triage:\n${sanitizedText}`,
        maxOutputTokens: 500, // Reduced from 4000 - triage JSON is small (~150 tokens)
        providerOptions: {
          openai: {
            reasoningEffort: "none",
            serviceTier: "flex",
          },
        },
      }),
      12000,
      "llm_triage",
    );

    const parsed = parseTriageResponse(text);
    if (parsed) {
      logger.debug("Triage result", {
        messageId: event.messageId,
        label: parsed.label,
        confidence: parsed.confidence,
        action: parsed.action,
      });
      return parsed;
    }

    logger.warn("Failed to parse triage response, escalating", {
      messageId: event.messageId,
      raw: text.slice(0, 200),
    });
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // Log full error details for debugging
    const fullError = err instanceof Error ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : String(err);
    logger.error("Triage LLM call failed", {
      messageId: event.messageId,
      error: errorMsg,
      errorDetails: fullError.slice(0, 2000), // Truncate if too large
      stack,
      context: sanitizedContext.slice(0, 200),
      text: sanitizedText.slice(0, 200),
    });
  }

  // Fallback: escalate everything we can't classify
  return {
    label: "unknown",
    confidence: 0.0,
    method: "model",
    action: "escalate",
    draft: null,
    draftConfidence: null,
    reasoning: "Triage LLM call failed or returned unparseable response",
  };
}

/**
 * Parse the LLM's JSON triage response.
 * Handles truncated output by attempting to close incomplete JSON.
 */
function parseTriageResponse(text: string): TriageResult | null {
  try {
    let jsonStr: string | null = null;

    // Try complete JSON first
    const completeMatch = text.match(/\{[^}]*\}/);
    if (completeMatch) {
      jsonStr = completeMatch[0];
    } else {
      // Truncated JSON recovery: try to close it
      const openIdx = text.indexOf("{");
      if (openIdx === -1) return null;

      let candidate = text.slice(openIdx);

      // Remove trailing incomplete key-value pair
      candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*[^,}]*$/, "");

      // Close open string
      const quoteCount = (candidate.match(/(?<!\\)"/g) || []).length;
      if (quoteCount % 2 !== 0) candidate += '"';

      // Close object
      if (!candidate.endsWith("}")) candidate += "}";

      jsonStr = candidate;
    }

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (!isValidTriageResponse(parsed)) return null;

    const label = parsed.label as ClassificationLabel;
    const confidence = Math.max(0, Math.min(1, (parsed.confidence as number) ?? 0.5));

    // Validate and normalize action
    const validActions = ["auto_send", "escalate", "defer"];
    let action = parsed.action as string;
    if (!validActions.includes(action)) action = "escalate";

    // draft is optional — null for defer
    const draft = typeof parsed.draft === "string" && parsed.draft.length > 0
      ? parsed.draft
      : null;

    // draftConfidence is only meaningful when there's a draft
    const draftConfidence = draft !== null && typeof parsed.draftConfidence === "number"
      ? Math.max(0, Math.min(1, parsed.draftConfidence))
      : null;

    return {
      label,
      confidence,
      method: "model",
      reasoning: (parsed.reasoning as string) ?? "Classified by triage model",
      action: action as TriageResult["action"],
      draft,
      draftConfidence,
    };
  } catch {
    return null;
  }
}

/**
 * Runtime type guard for triage response.
 */
function isValidTriageResponse(obj: Record<string, unknown>): boolean {
  const validLabels: ClassificationLabel[] = ["bug", "request", "normal", "unknown"];

  if (typeof obj.label !== "string" || !validLabels.includes(obj.label as ClassificationLabel)) {
    return false;
  }
  if (typeof obj.confidence !== "number") {
    return false;
  }
  if (typeof obj.action !== "string") {
    return false;
  }
  return true;
}
