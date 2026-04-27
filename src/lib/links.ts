/**
 * Link validation and response sanitization
 * Ensures all links in responses are valid (return 200)
 */

import { logger } from "./logger";
import { getConfig } from "./config";
import { getErrorMessage } from "./errors";

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
 * Check if HEAD failure should trigger GET fallback
 * 405 = Method Not Allowed, 501 = Not Implemented
 * Network errors (status 0) also trigger fallback
 */
function shouldFallbackToGet(status: number, error?: string): boolean {
  if (status === 405 || status === 501) return true;
  if (status === 0) return true; // Network/fetch errors
  // Some servers return 400 or 403 for HEAD when they mean "not supported"
  if (status === 400 || status === 403) {
    // Check error message for method-related hints
    if (error?.includes("Method") || error?.includes("method")) return true;
  }
  return false;
}

/**
 * Validate a single URL via HEAD request with GET fallback
 * 1. Try HEAD first (fast, no body download)
 * 2. If HEAD fails with 405/501/network error, fall back to GET
 * 3. For GET, abort after receiving headers (don't download full body)
 */
async function checkLink(
  url: string,
  timeoutMs?: number
): Promise<LinkCheckResult> {
  const effectiveTimeout = timeoutMs ?? 5000;

  // Try HEAD first
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // HEAD succeeded - return result
    if (response.ok || !shouldFallbackToGet(response.status)) {
      return {
        url,
        valid: response.ok,
        status: response.status,
      };
    }

    // HEAD returned error that might work with GET - fall through to GET fallback
    logger.debug("HEAD request failed, falling back to GET", {
      url,
      headStatus: response.status,
    });
  } catch (err) {
    // HEAD threw (network error, timeout, etc.) - fall back to GET
    logger.debug("HEAD request threw, falling back to GET", {
      url,
      error: getErrorMessage(err),
    });
  }

  // Fallback to GET with early abort after headers
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Abort after receiving headers - we don't need the body
    // Note: In some environments we could use "content-length: 0" header
    // but aborting the controller is more reliable across platforms
    try {
      controller.abort(); // Abort body download if still in progress
    } catch {
      // Ignore abort errors - we already have headers
    }

    return {
      url,
      valid: response.ok,
      status: response.status,
    };
  } catch (err) {
    // Check if it's an abort error from our intentional abort after headers
    const errorMessage = getErrorMessage(err);
    const isAbortError =
      errorMessage.includes("abort") || errorMessage.includes("Abort");

    // If we got here and it's not an abort error, the GET genuinely failed
    if (!isAbortError) {
      return {
        url,
        valid: false,
        error: errorMessage,
      };
    }

    // Abort error after headers likely means we aborted successfully
    // but couldn't get status - this is unusual, mark as invalid
    return {
      url,
      valid: false,
      error: `GET aborted after headers: ${errorMessage}`,
    };
  }
}

/**
 * Validate all links in text in parallel
 */
export async function validateLinks(text: string): Promise<LinkCheckResult[]> {
  const urls = extractUrls(text);
  if (urls.length === 0) return [];

  const config = getConfig();
  const checks = await Promise.all(
    urls.map((url) => checkLink(url, undefined))
  );

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
