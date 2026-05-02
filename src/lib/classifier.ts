import { generateText } from "ai";
import type { InternalEvent } from "../types/events";
import type { ClassificationLabel, TriageResult } from "../types/classification";
import type { Env } from "../types/env";
import { getTracedModel } from "./ai";
import { logger } from "./logger";
import { AIError, ValidationError, getErrorMessage } from "./errors";
import { sanitizePromptInput, sanitizeContextInput } from "./sanitize";
import { withTimeout } from "./timeout";

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
- If unsure about anything, escalate. Never guess.

## CRITICAL: Output ONLY valid JSON. No preamble, no postamble, no markdown code blocks. No commentary before or after.
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

  const model = getTracedModel(env, "triage");

  // Timeout LLM call at 25s — Workers AI cold starts can take 10-15s.
  // Leaves ~5s headroom for DB ops + Slack within 30s waitUntil limit.
  let responseText: string;
  try {
    const { text } = await withTimeout(
      generateText({
        model,
        system: TRIAGE_PROMPT,
        prompt: `Context:\n${sanitizedContext}\n\nMessage to triage:\n${sanitizedText}`,
        maxOutputTokens: 500,
      }),
      25000,
      "llm_triage",
    );
    responseText = text;
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

  const parsed = parseTriageResponse(responseText);
  if (parsed) {
    logger.debug("Triage result", {
      messageId: event.messageId,
      label: parsed.label,
      confidence: parsed.confidence,
      action: parsed.action,
    });
    return parsed;
  }

  // Parse failure — LLM returned something we couldn't interpret
  // Log enough context to diagnose the issue
  logger.error("Failed to parse triage response", {
    messageId: event.messageId,
    rawLength: responseText.length,
    rawPrefix: responseText.slice(0, 300),
    rawSuffix: responseText.slice(-200),
    context: sanitizedContext.slice(0, 200),
    text: sanitizedText.slice(0, 200),
  });
  throw new ValidationError(
    "triage_response",
    responseText.slice(0, 500),
    {
      messageId: event.messageId,
      chatId: event.chatId,
      rawLength: responseText.length,
      rawPrefix: responseText.slice(0, 500),
      rawSuffix: responseText.slice(-500),
      context: sanitizedContext.slice(0, 500),
      text: sanitizedText.slice(0, 500),
    },
  );
}

/**
 * Parse the LLM's JSON triage response.
 *
 * Uses multiple strategies in order of robustness:
 * 1. Direct JSON.parse on raw text (pure JSON response)
 * 2. Extract from markdown code blocks (```json ... ```)
 * 3. Brace-counting extraction (handles `}` inside string values)
 * 4. Truncated JSON recovery (last resort for cut-off output)
 */
function parseTriageResponse(text: string): TriageResult | null {
  // Strategy 1: Try parsing the full text as JSON directly
  // Handles pure JSON responses with no preamble/postamble
  try {
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    if (isValidTriageResponse(parsed)) {
      return buildTriageResult(parsed);
    }
  } catch {
    // Not valid JSON, continue to next strategy
  }

  // Strategy 2: Extract JSON from markdown code blocks
  // Handles responses wrapped in ```json ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    try {
      const parsed = JSON.parse(inner) as Record<string, unknown>;
      if (isValidTriageResponse(parsed)) {
        return buildTriageResult(parsed);
      }
    } catch {
      // Not valid JSON in code block
    }
  }

  // Strategy 3: Find the outermost JSON object by counting braces
  // Correctly handles `}` inside string values (e.g. draft text with code)
  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let startIdx = -1;

    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === "\\" && inString) {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === "{") {
          if (depth === 0) startIdx = i;
          depth++;
        } else if (char === "}") {
          depth--;
          if (depth === 0 && startIdx !== -1) {
            // Found a complete JSON object — try to parse it
            const candidate = text.slice(startIdx, i + 1);
            try {
              const parsed = JSON.parse(candidate) as Record<string, unknown>;
              if (isValidTriageResponse(parsed)) {
                return buildTriageResult(parsed);
              }
            } catch {
              // Valid framing but JSON invalid — continue scanning
            }
          }
        }
      }
    }
  }

  // Strategy 4: Truncated JSON recovery (last resort)
  // Only reached if the output was cut off mid-response
  try {
    const openIdx = text.indexOf("{");
    if (openIdx === -1) return null;

    let candidate = text.slice(openIdx);

    // Remove trailing incomplete key-value pair
    candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*[^,}]*$/, "");

    // Close open strings (count unescaped quotes)
    let inStr = false;
    let escaped = false;
    for (const c of candidate) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"' && !escaped) inStr = !inStr;
    }
    if (inStr) candidate += '"';

    // Close object
    if (!candidate.endsWith("}")) candidate += "}";

    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (isValidTriageResponse(parsed)) {
      return buildTriageResult(parsed);
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Build a TriageResult from a validated parsed JSON object.
 */
function buildTriageResult(parsed: Record<string, unknown>): TriageResult {
  const label = parsed.label as ClassificationLabel;
  const confidence = Math.max(0, Math.min(1, (parsed.confidence as number) ?? 0.5));

  const validActions = ["auto_send", "escalate", "defer"];
  let action = parsed.action as string;
  if (!validActions.includes(action)) action = "escalate";

  const draft = typeof parsed.draft === "string" && parsed.draft.length > 0
    ? parsed.draft
    : null;

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
