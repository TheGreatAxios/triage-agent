/** Internal normalized event produced from a Telegram update. */

export type MessageEventType = "message" | "edit" | "command" | "mention";

export interface InternalEvent {
  /** Unique event ID (update_id from Telegram) */
  id: number;
  /** Normalized event type */
  type: MessageEventType;
  /** Telegram chat ID */
  chatId: number;
  /** Telegram message ID */
  messageId: number;
  /** Sender info */
  sender: {
    id: number;
    isBot: boolean;
    name: string;
    username?: string;
  };
  /** Message content */
  text: string;
  /** Whether the bot was mentioned in this message */
  isMention: boolean;
  /** ISO timestamp */
  timestamp: string;
  /** Raw Telegram update for debugging */
  raw?: unknown;
}
