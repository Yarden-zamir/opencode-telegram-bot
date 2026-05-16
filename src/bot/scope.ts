import type { Context } from "grammy";

export const GLOBAL_SCOPE_KEY = "global";

export const SCOPE_CONTEXT = {
  DM: "dm",
  GROUP_GENERAL: "group-general",
  GROUP_TOPIC: "group-topic",
} as const;

export type ScopeContextKind = (typeof SCOPE_CONTEXT)[keyof typeof SCOPE_CONTEXT];

export const GENERAL_TOPIC_THREAD_ID = 1;

export interface ScopeParams {
  chatId: number;
  threadId?: number;
  context: ScopeContextKind;
}

export interface ConversationScope {
  key: string;
  chatId: number;
  threadId: number | null;
  context: ScopeContextKind;
}

type KnownChatType = "private" | "group" | "supergroup" | "channel";

function isKnownChatType(type: unknown): type is KnownChatType {
  return type === "private" || type === "group" || type === "supergroup" || type === "channel";
}

function toThreadId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function buildScopeKey(params: ScopeParams): string {
  if (params.context === SCOPE_CONTEXT.DM) {
    return `dm:${params.chatId}`;
  }

  if (typeof params.threadId === "number") {
    return `${params.chatId}:${params.threadId}`;
  }

  return `chat:${params.chatId}`;
}

export function createScopeKeyFromParams(params: ScopeParams): string {
  return buildScopeKey(params);
}

export function parseScopeKey(scopeKey: string): ScopeParams | null {
  if (!scopeKey || scopeKey === GLOBAL_SCOPE_KEY) {
    return null;
  }

  const directTopicMatch = /^(-?\d+):(\d+)$/.exec(scopeKey);
  if (directTopicMatch) {
    const chatId = Number.parseInt(directTopicMatch[1], 10);
    const threadId = Number.parseInt(directTopicMatch[2], 10);
    return {
      chatId,
      threadId,
      context: threadId === GENERAL_TOPIC_THREAD_ID ? SCOPE_CONTEXT.GROUP_GENERAL : SCOPE_CONTEXT.GROUP_TOPIC,
    };
  }

  const dmMatch = /^dm:(\d+)$/.exec(scopeKey);
  if (dmMatch) {
    return {
      chatId: Number.parseInt(dmMatch[1], 10),
      context: SCOPE_CONTEXT.DM,
    };
  }

  const groupGeneralMatch = /^chat:(-?\d+)$/.exec(scopeKey);
  if (groupGeneralMatch) {
    return {
      chatId: Number.parseInt(groupGeneralMatch[1], 10),
      context: SCOPE_CONTEXT.GROUP_GENERAL,
    };
  }

  return null;
}

function getMessageThreadIdFromPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const explicitThreadId = toThreadId(Reflect.get(payload, "message_thread_id"));
  if (explicitThreadId !== null) {
    return explicitThreadId;
  }

  return Reflect.get(payload, "is_topic_message") === true ? GENERAL_TOPIC_THREAD_ID : null;
}

function getContextThreadId(ctx: Context): number | null {
  const messageThreadId = getMessageThreadIdFromPayload(ctx.message);
  if (messageThreadId !== null) {
    return messageThreadId;
  }

  const callbackMessage = ctx.callbackQuery && "message" in ctx.callbackQuery ? ctx.callbackQuery.message : null;
  return getMessageThreadIdFromPayload(callbackMessage);
}

function resolveScopeContext(chatType: KnownChatType | undefined, threadId: number | null): ScopeContextKind {
  if (chatType === "private") {
    return SCOPE_CONTEXT.DM;
  }

  if (threadId === null || threadId === GENERAL_TOPIC_THREAD_ID) {
    return SCOPE_CONTEXT.GROUP_GENERAL;
  }

  return SCOPE_CONTEXT.GROUP_TOPIC;
}

export function getScopeFromContext(ctx: Context): ConversationScope | null {
  if (!ctx.chat) {
    return null;
  }

  const threadId = getContextThreadId(ctx);
  const chatType = isKnownChatType(ctx.chat.type) ? ctx.chat.type : undefined;
  if (!chatType && threadId === null) {
    return null;
  }

  const context = resolveScopeContext(chatType, threadId);
  const key = createScopeKeyFromParams({
    chatId: ctx.chat.id,
    threadId: threadId ?? undefined,
    context,
  });

  return {
    key,
    chatId: ctx.chat.id,
    threadId,
    context,
  };
}

export function getScopeKeyFromContext(ctx: Context): string {
  return getScopeFromContext(ctx)?.key ?? GLOBAL_SCOPE_KEY;
}

export function getScopeFromKey(scopeKey: string): ConversationScope | null {
  const parsed = parseScopeKey(scopeKey);
  if (!parsed) {
    return null;
  }

  return {
    key: createScopeKeyFromParams(parsed),
    chatId: parsed.chatId,
    threadId: typeof parsed.threadId === "number" ? parsed.threadId : null,
    context: parsed.context,
  };
}

export function getMessageThreadId(threadId: number | null): number | null {
  return threadId === null || threadId === GENERAL_TOPIC_THREAD_ID ? null : threadId;
}

export function getThreadSendOptions(threadId: number | null): { message_thread_id?: number } {
  const messageThreadId = getMessageThreadId(threadId);
  return messageThreadId === null ? {} : { message_thread_id: messageThreadId };
}

export function getOptionalThreadSendOptions(
  threadId: number | null,
): { message_thread_id: number } | undefined {
  const messageThreadId = getMessageThreadId(threadId);
  return messageThreadId === null ? undefined : { message_thread_id: messageThreadId };
}

export function getChatActionThreadOptions(threadId: number | null): { message_thread_id?: number } {
  return threadId === null ? {} : { message_thread_id: threadId };
}

export function isTopicScope(scope: ConversationScope | null): boolean {
  return scope?.context === SCOPE_CONTEXT.GROUP_TOPIC;
}
