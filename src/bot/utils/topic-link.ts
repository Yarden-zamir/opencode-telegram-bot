import type { Context } from "grammy";
import {
  CHAT_TYPE,
  TELEGRAM_CHAT_FIELD,
  TELEGRAM_CHAT_ID_PREFIX,
  TELEGRAM_URL,
} from "../constants.js";

function getInternalSupergroupId(chatId: number): string {
  const absoluteId = Math.abs(chatId).toString();
  if (absoluteId.startsWith(TELEGRAM_CHAT_ID_PREFIX.PRIVATE_SUPERGROUP)) {
    return absoluteId.slice(TELEGRAM_CHAT_ID_PREFIX.PRIVATE_SUPERGROUP.length);
  }

  return absoluteId;
}

export function buildTopicMessageLink(
  chat: Context["chat"] | undefined,
  messageId: number,
): string | null {
  if (!chat) {
    return null;
  }

  const username = Reflect.get(chat, TELEGRAM_CHAT_FIELD.USERNAME);
  if (typeof username === "string" && username.length > 0) {
    return `${TELEGRAM_URL.BASE}/${username}/${messageId}`;
  }

  if (chat.type !== CHAT_TYPE.SUPERGROUP) {
    return null;
  }

  return `${TELEGRAM_URL.BASE}${TELEGRAM_URL.PRIVATE_SUPERGROUP_PATH}/${getInternalSupergroupId(chat.id)}/${messageId}`;
}

export function buildTopicThreadLink(
  chat: Context["chat"] | undefined,
  threadId: number,
): string | null {
  if (!chat || chat.type !== CHAT_TYPE.SUPERGROUP) {
    return null;
  }

  return `${TELEGRAM_URL.BASE}${TELEGRAM_URL.PRIVATE_SUPERGROUP_PATH}/${getInternalSupergroupId(chat.id)}/${threadId}`;
}
