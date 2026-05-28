import type { Api, RawApi } from "grammy";
import type { BackgroundSessionNotification } from "../../background-session/tracker.js";
import { getThreadSendOptions } from "../scope.js";
import { renderAssistantFinalPartsSafe } from "./assistant-rendering.js";
import { sendRenderedBotPart } from "./telegram-text.js";

type SendMessageApi = Pick<Api<RawApi>, "sendMessage">;

type SessionMessagePart = {
  type?: string;
  text?: string;
};

type SessionMessageLike = {
  parts?: SessionMessagePart[];
};

type SessionMessageResult = {
  data?: SessionMessageLike | SessionMessageLike[] | null;
  error?: unknown;
};

interface BackgroundNotificationClient {
  session: {
    message(params: {
      sessionID: string;
      messageID: string;
      directory: string;
    }): Promise<SessionMessageResult>;
    messages(params: {
      sessionID: string;
      directory: string;
      limit: number;
    }): Promise<SessionMessageResult>;
  };
}

interface SessionDeliveryTarget {
  chatId: number;
  threadId: number | null;
}

interface DeliverBoundTopicAssistantResponseParams {
  api: SendMessageApi;
  client: BackgroundNotificationClient;
  notification: BackgroundSessionNotification;
  target: SessionDeliveryTarget | null;
  projectWorktree?: string;
}

function extractTextParts(parts: SessionMessagePart[] | undefined): string | null {
  if (!parts) {
    return null;
  }

  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();

  return text.length > 0 ? text : null;
}

export async function deliverBoundTopicAssistantResponse({
  api,
  client,
  notification,
  target,
  projectWorktree,
}: DeliverBoundTopicAssistantResponseParams): Promise<boolean> {
  if (notification.kind !== "assistant_response") {
    return false;
  }

  if (!target || !projectWorktree) {
    return false;
  }

  const { data, error } = notification.messageId
    ? await client.session.message({
        sessionID: notification.sessionId,
        messageID: notification.messageId,
        directory: projectWorktree,
      })
    : await client.session.messages({
        sessionID: notification.sessionId,
        directory: projectWorktree,
        limit: 1,
      });

  if (error || !data) {
    return false;
  }

  const message = Array.isArray(data) ? data[0] : data;
  const responseText = extractTextParts(message?.parts);
  if (!responseText) {
    return false;
  }

  const parts = renderAssistantFinalPartsSafe(responseText);
  for (const part of parts) {
    await sendRenderedBotPart({
      api,
      chatId: target.chatId,
      part,
      options: getThreadSendOptions(target.threadId),
    });
  }

  return true;
}
