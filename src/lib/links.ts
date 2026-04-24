/**
 * Link validation and response sanitization
 * Ensures all links in responses are valid (return 200)
 */

import { logger } from "./logger";

interface LinkCheckResult {
  url: string;
  valid: boolean;
  status?: number;
  error?: string;
}

/**
 * Extract URLs from text
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;
  const matches = text.match(urlRegex) || [];
  return [...new Set(matches)]; // Deduplicate
}

/**
 * Validate a single URL via HEAD request
 */
async function checkLink(url: string, timeoutMs = 5000): Promise<LinkCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    return {
      url,
      valid: response.ok,
      status: response.status,
    };
  } catch (err) {
    return {
      url,
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Validate all links in text in parallel
 */
export async function validateLinks(text: string): Promise<LinkCheckResult[]> {
  const urls = extractUrls(text);
  if (urls.length === 0) return [];

  const checks = await Promise.all(urls.map((url) => checkLink(url)));

  const invalid = checks.filter((c) => !c.valid);
  if (invalid.length > 0) {
    logger.warn("Invalid links found in response", {
      count: invalid.length,
      urls: invalid.map((c) => c.url),
    });
  }

  return checks;
}

/**
 * Remove or mark invalid links in text
 */
export function sanitizeInvalidLinks(
  text: string,
  linkChecks: LinkCheckResult[]
): string {
  let sanitized = text;

  for (const check of linkChecks) {
    if (!check.valid) {
      // Replace invalid link with placeholder text
      const linkText = check.url;
      sanitized = sanitized.replace(
        check.url,
        `[broken link: ${linkText}]`
      );
    }
  }

  return sanitized;
}

/**
 * Format code snippets for better readability
 * - Detects inline code and code blocks
 * - Ensures proper formatting
 */
export function formatCodeSnippets(text: string): string {
  // Detect code blocks that aren't properly formatted
  // Look for common code indicators: function, const, import, etc.
  const codeIndicators = [
    /^\s*(function|const|let|var|import|export|class|async|await)\s+/m,
    /^\s*\{[\s\S]*\}\s*$/m, // JSON-like blocks
    /^\s*<[\s\S]*>\s*$/m, // HTML/XML-like
  ];

  let formatted = text;

  // If it looks like code but has no backticks, wrap it
  for (const indicator of codeIndicators) {
    if (indicator.test(formatted) && !formatted.includes("```")) {
      // Find the code block and wrap it
      formatted = formatted.replace(
        /(^|\n)([ \t]*)(function|const|let|var|import|export|class)[\s\S]*?(?=\n\n|\n[^ \t]|$)/,
        '$1$2```\n$2$3```'
      );
    }
  }

  return formatted;
}
