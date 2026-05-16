import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";
import { CHAT_TYPE, GENERAL_TOPIC, TELEGRAM_CHAT_FIELD } from "../constants.js";

const renamedGeneralTopicChats = new Set<number>();

export async function ensureGeneralTopicName(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === CHAT_TYPE.PRIVATE) {
    return;
  }

  if (renamedGeneralTopicChats.has(ctx.chat.id)) {
    return;
  }

  if (Reflect.get(ctx.chat, TELEGRAM_CHAT_FIELD.IS_FORUM) !== true) {
    return;
  }

  try {
    await ctx.api.editGeneralForumTopic(ctx.chat.id, GENERAL_TOPIC.NAME);
    renamedGeneralTopicChats.add(ctx.chat.id);
    logger.info(`[Bot] Renamed General topic in chat ${ctx.chat.id} to "${GENERAL_TOPIC.NAME}"`);
  } catch (error) {
    logger.debug("[Bot] Failed to rename General topic", { chatId: ctx.chat.id, error });
  }
}

export function __resetGeneralTopicNameMiddlewareForTests(): void {
  renamedGeneralTopicChats.clear();
}
