import type { TelegramUpdate, TelegramMessage } from "../types/telegram";
import type { InternalEvent, MessageEventType } from "../types/events";

/**
 * Normalize a raw Telegram update into an InternalEvent.
 * Returns null if the update contains no processable message.
 *
 * TODO: Extract to src/sources/telegram.ts as TelegramAdapter when adding
 * multi-source support. This file will become the Telegram-specific adapter
 * implementation following the SourceAdapter interface.
 */
export function normalizeUpdate(update: TelegramUpdate): InternalEvent | null {
  const isEdit = !!update.edited_message;
  const message = update.message ?? update.edited_message;

  if (!message || !message.from) return null;
  if (!message.text) return null;

  const isMention = checkBotMention(message);
  const eventType = resolveEventType(message, isEdit, isMention);

  return {
    id: update.update_id,
    source: "telegram",
    type: eventType,
    chatId: message.chat.id,
    messageId: message.message_id,
    sender: {
      id: message.from.id,
      isBot: message.from.is_bot,
      name: buildDisplayName(message.from.first_name, message.from.last_name),
      username: message.from.username,
    },
    text: message.text,
    isMention,
    timestamp: new Date(message.date * 1000).toISOString(),
  };
}

function resolveEventType(message: TelegramMessage, isEdit: boolean, isMention: boolean): MessageEventType {
  if (isEdit) return "edit";

  const entities = message.entities ?? [];
  if (entities.some((e) => e.type === "bot_command")) return "command";
  if (isMention) return "mention";

  return "message";
}

function checkBotMention(message: TelegramMessage): boolean {
  const entities = message.entities ?? [];
  return entities.some((e) => e.type === "mention" || e.type === "text_mention");
}

function buildDisplayName(firstName: string, lastName?: string): string {
  return lastName ? `${firstName} ${lastName}` : firstName;
}
