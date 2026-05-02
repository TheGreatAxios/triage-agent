/**
 * Output safety and content moderation for AI-generated drafts.
 *
 * Validates draft content before it reaches the user:
 * 1. Prompt injection checks on output (the model can't be tricked into producing
 *    system prompts or control tokens in the draft)
 * 2. Pattern-based content safety (NSFW, spam, harmful content)
 * 3. Length and structure validation
 *
 * Performs local pattern matching — no external API call needed.
 * Lightweight enough to run in every pipeline path.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { logger } from "./logger";

/** Results of a content safety check. */
export interface SafetyResult {
  /** Whether any category was flagged */
  flagged: boolean;
  /** Which categories were flagged */
  categories: string[];
  /** Per-category scores (0-1, 1 = definitely unsafe) */
  scores: Record<string, number>;
  /** Final recommendation: 'pass' | 'blocked' | 'rejected' */
  action: "pass" | "blocked" | "rejected";
}

/** Patterns checked on output content. */
const SENSITIVE_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  // Prompt injection residuals — the model should NOT output system instructions
  {
    category: "prompt_injection_output",
    pattern: /(?:system|assistant|human|user)\s*:.*?(?:instructions|ignore|forget|disregard)/i,
  },
  // Control tokens leaking into output
  {
    category: "control_tokens",
    pattern: /<\|(?:endoftext|im_start|im_end)\|>/gi,
  },
  // Role-playing as system
  {
    category: "system_roleplay",
    pattern: /^\s*(?:system|assistant)\s*:/i,
  },
  // NSFW / harmful content patterns
  {
    category: "nsfw",
    pattern: /[\s\S]*(?:explicit|porn|nsfw|xxx)[\s\S]*/i, // Light check — most models won't output this anyway
  },
  // Spam / phishing patterns
  {
    category: "spam",
    pattern: /(?:click\s+here\s+to\s+claim|free\s+money|crypto\s+giveaway|send\s+\d+\s+ETH|send\s+\d+\s+BTC)/i,
  },
  // Code blocks that look like they execute something dangerous
  {
    category: "dangerous_code",
    pattern: /```(?:bash|sh|shell|powershell|cmd)\s*\n.*?(?:rm\s+-rf|format|>.*?\|.*?sh)/is,
  },
];

/** Maximum length for a draft response (characters). */
const MAX_DRAFT_LENGTH = 2000;

/** Minimum length for a non-empty draft (can't just be whitespace). */
const MIN_DRAFT_LENGTH = 2;

/**
 * Run content safety checks on AI-generated text.
 * Uses pattern matching only — no network calls.
 */
export function checkContentSafety(content: string): SafetyResult {
  const categories: string[] = [];
  const scores: Record<string, number> = {};
  let maxScore = 0;
  let blocked = false;

  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      categories.push(category);
      // Score based on match length relative to content — longer matches = more suspicious
      const totalMatchLen = matches.reduce((sum, m) => sum + m.length, 0);
      const score = Math.min(totalMatchLen / content.length, 1);
      scores[category] = score;
      maxScore = Math.max(maxScore, score);

      if (score > 0.5) {
        blocked = true;
      }
    } else {
      scores[category] = 0;
    }
  }

  // Check length bounds
  if (content.length > MAX_DRAFT_LENGTH) {
    categories.push("too_long");
    scores["too_long"] = content.length / MAX_DRAFT_LENGTH;
    if (content.length > MAX_DRAFT_LENGTH * 2) {
      blocked = true;
    }
  } else {
    scores["too_long"] = 0;
  }

  if (content.trim().length < MIN_DRAFT_LENGTH && content.trim().length > 0) {
    categories.push("too_short");
    scores["too_short"] = 1;
    blocked = true;
  }

  const action = blocked ? "blocked" : categories.length > 0 ? "rejected" : "pass";

  return {
    flagged: categories.length > 0,
    categories,
    scores,
    action,
  };
}

/**
 * Persist content safety log entry to D1.
 */
export async function persistContentSafetyLog(
  db: D1Database,
  chatId: number,
  result: SafetyResult,
  content: string,
  draftId?: number,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO content_safety_log (chat_id, draft_id, content, flagged, categories, scores, action_taken)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        chatId,
        draftId ?? null,
        content.slice(0, 4000),
        result.flagged ? 1 : 0,
        JSON.stringify(result.categories),
        JSON.stringify(result.scores),
        result.action,
      )
      .run();
  } catch (err) {
    logger.error("Failed to persist content safety log", { chatId, error: String(err) });
  }
}

/**
 * Persist triage decision audit log.
 */
export async function persistTriageDecision(
  db: D1Database,
  params: {
    chatId: number;
    dbMessageId?: number;
    label: string;
    classificationConfidence: number;
    method: string;
    action: string;
    draftContent: string | null;
    draftConfidence: number | null;
    classificationThresholdPassed: boolean;
    draftThresholdPassed: boolean;
    overallDecision: string;
    contentFlagged: boolean;
    contentSafetyCategories: string[];
    executionTimeMs: number;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO triage_decisions (
          chat_id, db_message_id, label, classification_confidence, method,
          action, draft_content, draft_confidence,
          classification_threshold_passed, draft_threshold_passed, overall_decision,
          content_flagged, content_safety_categories,
          execution_time_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.chatId,
        params.dbMessageId ?? null,
        params.label,
        params.classificationConfidence,
        params.method,
        params.action,
        params.draftContent?.slice(0, 4000) ?? null,
        params.draftConfidence,
        params.classificationThresholdPassed ? 1 : 0,
        params.draftThresholdPassed ? 1 : 0,
        params.overallDecision,
        params.contentFlagged ? 1 : 0,
        JSON.stringify(params.contentSafetyCategories),
        params.executionTimeMs,
      )
      .run();
  } catch (err) {
    logger.error("Failed to persist triage decision", { chatId: params.chatId, error: String(err) });
  }
}
