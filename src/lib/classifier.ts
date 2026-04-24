import { generateText } from "ai";
import type { InternalEvent } from "../types/events";
import type { ClassificationResult, ClassificationLabel } from "../types/classification";
import type { Env } from "../types/env";
import { getModel } from "./ai";
import { logger } from "./logger";

interface Rule {
  label: ClassificationLabel;
  patterns: RegExp[];
  confidence: number;
  reasoning: string;
}

const RULES: Rule[] = [
  {
    label: "bug",
    patterns: [
      /\b(bug|crash(es|ed|ing)?|broke(n)?|not working|doesn'?t work|won'?t work|can'?t work)\b/i,
      /\b(error|exception|fail(s|ed|ing|ure)?|issue|problem)\b/i,
      /\b(stuck|frozen|hang(s|ing)?|unresponsive|blank screen|white screen)\b/i,
      /\b(500|404|403|timeout|timed? ?out)\b/i,
      /\b(regression|broken after|stopped working|used to work)\b/i,
    ],
    confidence: 0.8,
    reasoning: "Message contains bug-related keywords",
  },
  {
    label: "request",
    patterns: [
      /\b(can you|could you|please add|would it be possible|feature request)\b/i,
      /\b(would be nice|would be great|it would help|suggestion)\b/i,
      /\b(add support|integrate|implement|build|create)\b.*\b(for|a|an|the)\b/i,
      /\b(wish|want|need|looking for|hoping for)\b.*\b(feature|option|ability|way to)\b/i,
      /\b(enhancement|improvement|upgrade)\b/i,
    ],
    confidence: 0.75,
    reasoning: "Message contains feature request keywords",
  },
];

/**
 * Classify a message using rule-based heuristics.
 * Returns a structured result with label, confidence, and method.
 *
 * Commands and bot messages are classified as "normal" immediately.
 * If no rules match, returns "unknown" for potential model fallback.
 */
export function classifyByRules(event: InternalEvent): ClassificationResult {
  if (event.sender.isBot) {
    return {
      label: "normal",
      confidence: 1.0,
      method: "rule",
      reasoning: "Bot messages are always normal",
    };
  }

  if (event.type === "command") {
    return {
      label: "normal",
      confidence: 1.0,
      method: "rule",
      reasoning: "Commands are classified as normal",
    };
  }

  const text = event.text;

  const matches: { label: ClassificationLabel; confidence: number; reasoning: string; matchCount: number }[] = [];

  for (const rule of RULES) {
    const matchCount = rule.patterns.filter((p) => p.test(text)).length;
    if (matchCount > 0) {
      const boostedConfidence = Math.min(1.0, rule.confidence + matchCount * 0.05);
      matches.push({
        label: rule.label,
        confidence: boostedConfidence,
        reasoning: rule.reasoning,
        matchCount,
      });
    }
  }

  if (matches.length === 0) {
    if (isLikelyNormal(text)) {
      return {
        label: "normal",
        confidence: 0.6,
        method: "rule",
        reasoning: "No bug/request patterns detected; appears to be normal conversation",
      };
    }

    return {
      label: "unknown",
      confidence: 0.0,
      method: "rule",
      reasoning: "No classification rules matched",
    };
  }

  matches.sort((a, b) => b.matchCount - a.matchCount || b.confidence - a.confidence);
  const best = matches[0];

  return {
    label: best.label,
    confidence: best.confidence,
    method: "rule",
    reasoning: best.reasoning,
  };
}

/**
 * Check if a message looks like normal conversation
 * (short, greetings, acknowledgments, etc.)
 */
function isLikelyNormal(text: string): boolean {
  const normalPatterns = [
    /^(hi|hey|hello|yo|sup|gm|gn|thanks|thank you|ok|okay|sure|got it|np|no problem|lol|lmao|haha)\b/i,
    /^(good morning|good night|good evening|good afternoon)\b/i,
    /^[\p{Emoji}\s]+$/u,
  ];

  const trimmed = text.trim();
  if (trimmed.length < 10) return true;

  return normalPatterns.some((p) => p.test(trimmed));
}

const CLASSIFICATION_PROMPT = `Classify this Telegram message into exactly one category.

Categories:
- bug: Reports of errors, crashes, broken functionality, things not working
- request: Feature requests, enhancement suggestions, asking for new capabilities
- normal: General conversation, greetings, acknowledgments, questions, discussion

Respond with ONLY a JSON object: {"label":"bug"|"request"|"normal","confidence":0.0-1.0,"reasoning":"brief explanation"}`;

/**
 * Full classification pipeline: rules first, model fallback if ambiguous.
 */
export async function classifyMessage(
  env: Env,
  event: InternalEvent
): Promise<ClassificationResult> {
  const ruleResult = classifyByRules(event);

  if (ruleResult.label !== "unknown") {
    logger.debug("Classified by rules", {
      messageId: event.messageId,
      label: ruleResult.label,
      confidence: ruleResult.confidence,
    });
    return ruleResult;
  }

  logger.debug("Rules inconclusive, using model fallback", {
    messageId: event.messageId,
  });

  return classifyByModel(env, event);
}

async function classifyByModel(
  env: Env,
  event: InternalEvent
): Promise<ClassificationResult> {
  try {
    const model = getModel(env, "classify");
    const { text } = await generateText({
      model,
      system: CLASSIFICATION_PROMPT,
      prompt: event.text,
      maxOutputTokens: 100,
    });

    const parsed = parseModelResponse(text);
    if (parsed) {
      logger.debug("Model classification result", {
        messageId: event.messageId,
        label: parsed.label,
        confidence: parsed.confidence,
      });
      return parsed;
    }

    logger.warn("Failed to parse model response", {
      messageId: event.messageId,
      response: text,
    });
  } catch (err) {
    logger.error("Model fallback failed", {
      messageId: event.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    label: "unknown",
    confidence: 0.0,
    method: "model",
    reasoning: "Model fallback failed or returned unparseable response",
  };
}

function parseModelResponse(text: string): ClassificationResult | null {
  try {
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Type guard: validate parsed object structure
    if (!isValidClassificationResponse(parsed)) {
      return null;
    }

    return {
      label: parsed.label,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      method: "model",
      reasoning: parsed.reasoning ?? "Classified by model",
    };
  } catch {
    return null;
  }
}

/**
 * Type guard to validate model response structure at runtime.
 */
function isValidClassificationResponse(
  obj: Record<string, unknown>
): obj is { label: ClassificationLabel; confidence?: number; reasoning?: string } {
  const validLabels: ClassificationLabel[] = ["bug", "request", "normal", "unknown"];

  // label must be a string and a valid ClassificationLabel
  if (typeof obj.label !== "string" || !validLabels.includes(obj.label as ClassificationLabel)) {
    return false;
  }

  // confidence, if present, must be a number
  if (obj.confidence !== undefined && typeof obj.confidence !== "number") {
    return false;
  }

  // reasoning, if present, must be a string
  if (obj.reasoning !== undefined && typeof obj.reasoning !== "string") {
    return false;
  }

  return true;
}
