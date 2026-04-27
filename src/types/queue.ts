/**
 * Queue message types for async pipeline processing.
 *
 * The webhook handles fast work (validate → normalize → persist → state update),
 * then enqueues a message for the slow LLM triage + response actions.
 * Queue consumers get up to 30 minutes per message vs ~30s for waitUntil.
 */

export interface TriageQueueMessage {
  /** Database chat ID */
  dbChatId: number;
  /** Database message ID */
  dbMessageId: number;
  /** Telegram chat ID for logging */
  telegramChatId: number;
  /** Message text to triage */
  text: string;
  /** Sender info */
  sender: {
    id: number;
    username: string | null;
    name: string;
    isBot: boolean;
  };
  /** Update ID for tracing */
  updateId: number;
  /** Message ID (telegram) */
  messageId: number;
  /** ISO timestamp */
  timestamp: string;
}
