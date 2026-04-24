/**
 * Input sanitization utilities for AI prompt security.
 *
 * Prevents prompt injection attacks by sanitizing user input
 * before it reaches AI models.
 */

/**
 * Sanitizes user input for AI prompts to prevent prompt injection.
 * Removes common prompt injection patterns and limits length.
 */
export function sanitizePromptInput(text: string, maxLength = 4000): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  return (
    text
      // Remove common prompt injection markers
      .replace(/<\|endoftext\|>/gi, "")
      .replace(/<\|im_start\|>/gi, "")
      .replace(/<\|im_end\|>/gi, "")
      .replace(/\[\s*INST\s*\]/gi, "")
      .replace(/\[\s*\/INST\s*\]/gi, "")
      .replace(/<<\s*SYS\s*>>/gi, "")
      .replace(/<<\s*\/SYS\s*>>/gi, "")
      // Remove role injection attempts
      .replace(/\bsystem\s*:/gi, "")
      .replace(/\buser\s*:/gi, "")
      .replace(/\bassistant\s*:/gi, "")
      .replace(/\bhuman\s*:/gi, "")
      .replace(/\bai\s*:/gi, "")
      // Remove instruction override patterns
      .replace(/ignore\s+(previous|above|all)\s+instructions/gi, "[REDACTED]")
      .replace(/disregard\s+(previous|above|all)\s+instructions/gi, "[REDACTED]")
      .replace(/forget\s+(previous|above|all)\s+instructions/gi, "[REDACTED]")
      // Remove delimiter injection attempts
      .replace(/---\s*SYSTEM\s*---/gi, "")
      .replace(/---\s*INSTRUCTIONS\s*---/gi, "")
      // Normalize whitespace but preserve structure
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Limit length to prevent DoS via huge prompts
      .slice(0, maxLength)
  );
}

/**
 * Sanitizes conversation context for AI prompts.
 * More aggressive sanitization for multi-line context.
 */
export function sanitizeContextInput(text: string, maxLength = 8000): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  return (
    text
      // Apply standard prompt sanitization
      .replace(/<\|endoftext\|>/gi, "")
      .replace(/<\|im_start\|>/gi, "")
      .replace(/<\|im_end\|>/gi, "")
      .replace(/\[\s*INST\s*\]/gi, "")
      .replace(/\[\s*\/INST\s*\]/gi, "")
      .replace(/<<\s*SYS\s*>>/gi, "")
      .replace(/<<\s*\/SYS\s*>>/gi, "")
      // Remove role markers
      .replace(/\bsystem\s*:/gi, "")
      .replace(/\buser\s*:/gi, "")
      .replace(/\bassistant\s*:/gi, "")
      // Remove instruction overrides
      .replace(/ignore\s+(previous|above|all)\s+instructions/gi, "[REDACTED]")
      .replace(/disregard\s+(previous|above|all)\s+instructions/gi, "[REDACTED]")
      .replace(/forget\s+(previous|above|all)\s+instructions/gi, "[REDACTED]")
      // Remove potential code execution markers
      .replace(/```\s*(python|bash|sh|shell|js|javascript)/gi, "```\n[CODE BLOCK REMOVED]\n```")
      // Normalize line endings
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Limit length
      .slice(0, maxLength)
  );
}
