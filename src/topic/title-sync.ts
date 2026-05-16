import { logger } from "../utils/logger.js";
import { getTopicBindingBySessionId, updateTopicBindingNameBySessionId } from "./manager.js";
import { formatTopicTitle } from "./title-format.js";

interface TopicEditApi {
  editForumTopic: (
    chatId: number,
    messageThreadId: number,
    payload: { name: string },
  ) => Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTelegramRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const parameters = Reflect.get(error, "parameters");
  if (!parameters || typeof parameters !== "object") {
    return null;
  }

  const retryAfter = Reflect.get(parameters, "retry_after");
  return typeof retryAfter === "number" && retryAfter > 0 ? retryAfter * 1000 : null;
}

export async function syncTopicTitleForSession(
  api: TopicEditApi,
  sessionId: string,
  sessionTitle: string,
): Promise<boolean> {
  const binding = getTopicBindingBySessionId(sessionId);
  if (!binding) {
    return false;
  }

  const topicName = formatTopicTitle(sessionTitle);
  if (!topicName || binding.topicName === topicName) {
    return false;
  }

  while (true) {
    try {
      await api.editForumTopic(binding.chatId, binding.threadId, { name: topicName });
      break;
    } catch (error) {
      if (error instanceof Error && error.message.includes("TOPIC_NOT_MODIFIED")) {
        updateTopicBindingNameBySessionId(sessionId, topicName);
        return false;
      }

      const retryAfterMs = getTelegramRetryAfterMs(error);
      if (!retryAfterMs) {
        throw error;
      }

      logger.info(`[TopicTitle] Telegram rate limit; retrying topic title sync in ${retryAfterMs}ms`, {
        sessionId,
      });
      await sleep(retryAfterMs + 100);
    }
  }

  updateTopicBindingNameBySessionId(sessionId, topicName);
  return true;
}
