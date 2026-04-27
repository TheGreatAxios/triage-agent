import { generateText } from "ai";
import type { InternalEvent } from "../types/events";
import type { ClassificationResult, ClassificationLabel } from "../types/classification";
import type { Env } from "../types/env";
import { getModel } from "./ai";
import { logger } from "./logger";
import { getErrorMessage } from "./errors";
import { sanitizePromptInput } from "./sanitize";

interface Rule {
  label: ClassificationLabel;
  patterns: RegExp[];
  confidence: number;
  reasoning: string;
}

/**
 * TIER 1: Regex Pre-Filter
 * Fast, cheap pattern matching for common cases that don't need AI.
 * Returns null if no match (proceed to Tier 2).
 */
export function regexPreFilter(text: string): ClassificationResult | null {
  // Pattern 1: Ethereum wallet address (0x + 40 hex chars)
  const walletAddressPattern = /\b0x[a-fA-F0-9]{40}\b/;
  if (walletAddressPattern.test(text)) {
    return {
      label: "normal",
      confidence: 0.99,
      method: "rule",
      reasoning: "Contains wallet address - crypto transaction pattern, not a bug report",
    };
  }

  // Pattern 2: Transaction confirmation keywords
  const transactionPatterns = [
    /\bsent\s+[\d,.]+[kK]?\s*(usdc|usdt|eth|btc|sol|tokens?)/i,
    /\breceived\s+[\d,.]+[kK]?\s*(usdc|usdt|eth|btc|sol|tokens?)/i,
    /\bdropped\s+[\d,.]+[kK]?\s*(usdc|usdt|eth|btc|sol)/i,
    /\bwallet\s+(address|addr)\s*:?\s*0x/i,
    /\btransfer(red)?\s+[\d,.]+/i,
    /\bdeposit(ed)?\s+[\d,.]+/i,
    /\bwithdraw(al)?\s+[\d,.]+/i,
    /\bswap(ped)?\s+[\d,.]+/i,
    /\btx\s+(hash|id)\s*:?\s*0x[a-fA-F0-9]{64}/i,
  ];

  for (const pattern of transactionPatterns) {
    if (pattern.test(text)) {
      return {
        label: "normal",
        confidence: 0.98,
        method: "rule",
        reasoning: "Transaction/transfer message - operational crypto activity, not a bug",
      };
    }
  }

  // Pattern 3: Balance/status checks
  const statusPatterns = [
    /\bbalance\s*:?\s*[\d,.]+/i,
    /\bposition\s+(size|value)\s*:?\s*[\d,.]+/i,
    /\bpnl\s*[:=]\s*[\d,.]+/i,
  ];

  for (const pattern of statusPatterns) {
    if (pattern.test(text)) {
      return {
        label: "normal",
        confidence: 0.97,
        method: "rule",
        reasoning: "Balance/position status update, not a bug report",
      };
    }
  }

  // Pattern 4: Simple bot commands
  if (/^\//.test(text.trim())) {
    return {
      label: "normal",
      confidence: 1.0,
      method: "rule",
      reasoning: "Bot command - no response needed",
    };
  }

  // No regex match - proceed to Tier 2
  return null;
}

/**
 * TIER 1.5: Acknowledgment/Resolution Detection
 * Detect simple positive acknowledgments that indicate resolution.
 * Returns "acknowledgment" classification for agent to handle.
 */
export function detectAcknowledgment(text: string): ClassificationResult | null {
  const acknowledgmentPatterns = [
    /^(thanks|thank you|ty|thx|tysm)\b/i,
    /^(got it|understood|makes sense|i see)\b/i,
    /^(perfect|awesome|great|nice|cool|👍|👌|✅|💯)$/i,
    /^(worked|fixed it|solved it|all good|works now)\b/i,
  ];

  for (const pattern of acknowledgmentPatterns) {
    if (pattern.test(text.trim())) {
      return {
        label: "normal",
        confidence: 0.95,
        method: "rule",
        reasoning: "User acknowledgment - may indicate resolution or satisfaction",
      };
    }
  }

  return null;
}

/**
 * @deprecated Use regexPreFilter instead. Kept for backwards compatibility.
 */
export function ruleBasedClassify(text: string): ClassificationResult | null {
  return regexPreFilter(text);
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
 * TIER 2: Rule-Based Classification
 * Keyword-based classification for bug/request detection.
 * Returns "unknown" for ambiguous cases that should be elevated to the Agent (Tier 3).
 */
export function classifyByRules(event: InternalEvent): ClassificationResult {
  // Tier 1: Fast regex pre-filter
  const preFilterResult = regexPreFilter(event.text);
  if (preFilterResult) {
    logger.debug("Tier 1 regex pre-filter matched", {
      label: preFilterResult.label,
      confidence: preFilterResult.confidence,
    });
    return preFilterResult;
  }

  // Tier 1.5: Check for acknowledgments (may need agent for resolution detection)
  const ackResult = detectAcknowledgment(event.text);
  if (ackResult) {
    // Return acknowledgment for potential agent elevation
    return {
      ...ackResult,
      reasoning: "Acknowledgment detected - may need resolution analysis",
    };
  }

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

  // Tier 2: Keyword-based rules
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

    // ELEVATE TO AGENT: No rules matched, ambiguous case
    return {
      label: "unknown",
      confidence: 0.0,
      method: "rule",
      reasoning: "No classification rules matched - needs agent analysis",
    };
  }

  matches.sort((a, b) => b.matchCount - a.matchCount || b.confidence - a.confidence);
  const best = matches[0];

  // If confidence is high enough, return the classification
  // Otherwise, mark as needs agent review
  if (best.confidence >= 0.7) {
    return {
      label: best.label,
      confidence: best.confidence,
      method: "rule",
      reasoning: best.reasoning,
    };
  }

  // ELEVATE TO AGENT: Low confidence match
  return {
    label: "unknown",
    confidence: best.confidence,
    method: "rule",
    reasoning: `Low confidence ${best.label} match (${best.confidence.toFixed(2)}) - needs agent analysis`,
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

const NEGATIVE_EXAMPLES = `
Examples that are NOT bugs (classify as 'normal'):
- "sent 100K USDC to 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb" - this is a transaction confirmation
- "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb" - this is just a wallet address being shared
- "received 50 ETH" - this is a transfer notification
- "wallet address: 0x..." - this is sharing contact info
- "my balance is 1000 USDC" - this is a status update
- "dropped 25K tokens" - this is a transfer, not an error
- "tx hash: 0xabc123..." - this is a transaction reference

Examples that ARE bugs:
- "I can't connect my wallet, getting error 0x..."
- "Transaction failed with revert error"
- "My balance shows 0 but I deposited yesterday"
- "The app crashes when I click swap"
- "Getting 'insufficient funds' error even with balance"
`;

const CLASSIFICATION_PROMPT = `You are a support ticket classifier. Analyze the message and classify it.

${NEGATIVE_EXAMPLES}

Classification Rules:
1. 'bug' - Something is broken, error messages, crashes, unexpected behavior
2. 'request' - Feature request, enhancement, "how do I..."
3. 'normal' - General chat, transaction confirmations, status updates, wallet addresses being shared
4. 'unknown' - Cannot determine from message alone

IMPORTANT: Hex strings like 0x... are usually wallet addresses or transaction IDs in crypto contexts, NOT error codes.

Respond in JSON format:
{"label":"bug|request|normal|unknown","confidence":0.0-1.0,"reasoning":"brief explanation"}`;

/**
 * TIER 3: Model-based classification (legacy, kept for compatibility)
 * Used when rules return unknown and no agent is available.
 * @deprecated Use UnifiedAgent instead for ambiguous cases.
 */
export async function classifyByModel(
  env: Env,
  event: InternalEvent
): Promise<ClassificationResult> {
  try {
    const model = getModel(env, "classify");
    // Sanitize user input to prevent prompt injection
    const sanitizedText = sanitizePromptInput(event.text);
    const { text } = await generateText({
      model,
      system: CLASSIFICATION_PROMPT,
      prompt: sanitizedText,
      maxOutputTokens: 50,  // Tiny output: {"label":"bug","confidence":0.9}
      providerOptions: {
        openai: {
          reasoningEffort: "none",  // No reasoning tokens for nano
          serviceTier: "flex",      // 50% cost savings
        },
      },
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
      error: getErrorMessage(err),
    });
  }

  return {
    label: "unknown",
    confidence: 0.0,
    method: "model",
    reasoning: "Model fallback failed or returned unparseable response",
  };
}

/**
 * Full classification pipeline: Tier 1/2 rules → Tier 3 AI model fallback.
 *
 * Rule-based classification is tried first (fast, free).
 * If rules return "unknown", the AI model classifies the message.
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
      method: ruleResult.method,
    });
    return ruleResult;
  }

  // Tier 3: AI model classification for ambiguous messages
  logger.debug("Rules inconclusive, falling back to AI model", {
    messageId: event.messageId,
    reasoning: ruleResult.reasoning,
  });

  return classifyByModel(env, event);
}

/**
 * Check if a message should be elevated to the Unified Agent.
 * Returns true for "unknown" classifications or acknowledgments that need resolution detection.
 */
export function shouldElevateToAgent(result: ClassificationResult): boolean {
  // Elevate unknown classifications
  if (result.label === "unknown") {
    return true;
  }

  // Elevate acknowledgments for resolution detection
  if (result.reasoning.includes("acknowledgment") || result.reasoning.includes("resolution")) {
    return true;
  }

  // Don't elevate high-confidence classifications
  return false;
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
