import type { TelegramUpdate } from "./telegram";

/** Supported message sources. */
export type Source = "telegram" | "email" | "slack" | "api";

/** Internal normalized event produced from a source update. */

export type MessageEventType = "message" | "edit" | "command" | "mention";

export interface InternalEvent {
  /** Unique event ID (source-specific) */
  id: number;
  /** Source system (telegram, email, slack, api) */
  source: Source;
  /** Normalized event type */
  type: MessageEventType;
  /** Source-specific chat ID */
  chatId: number;
  /** Source-specific message ID */
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
  /** Whether the bot was mentioned/addressed in this message */
  isMention: boolean;
  /** ISO timestamp */
  timestamp: string;
  /** Raw source payload for debugging/tracing */
  raw?: TelegramUpdate;
}
