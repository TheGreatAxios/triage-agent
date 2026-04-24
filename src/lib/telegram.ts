/**
 * Verify incoming Telegram webhook using the secret token header.
 * Telegram sends this as X-Telegram-Bot-Api-Secret-Token.
 */
export function verifyTelegramWebhook(
  expectedSecret: string,
  headerValue: string | undefined
): boolean {
  if (!headerValue) return false;
  return headerValue === expectedSecret;
}
