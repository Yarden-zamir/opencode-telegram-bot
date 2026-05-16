import { describe, expect, it } from "vitest";
import type { Context } from "grammy";
import {
  GENERAL_TOPIC_THREAD_ID,
  GLOBAL_SCOPE_KEY,
  SCOPE_CONTEXT,
  createScopeKeyFromParams,
  getChatActionThreadOptions,
  getMessageThreadId,
  getScopeFromContext,
  getScopeFromKey,
  getScopeKeyFromContext,
  getThreadSendOptions,
  isTopicScope,
  parseScopeKey,
} from "../../src/bot/scope.js";

function createContext(chat: Context["chat"], payload: Partial<Context> = {}): Context {
  return {
    chat,
    ...payload,
  } as Context;
}

describe("bot/scope", () => {
  it("creates and parses scope keys for private chats, group chats, and topics", () => {
    expect(createScopeKeyFromParams({ chatId: 123, context: SCOPE_CONTEXT.DM })).toBe("dm:123");
    expect(createScopeKeyFromParams({ chatId: -100123, context: SCOPE_CONTEXT.GROUP_GENERAL })).toBe(
      "chat:-100123",
    );
    expect(
      createScopeKeyFromParams({ chatId: -100123, threadId: 42, context: SCOPE_CONTEXT.GROUP_TOPIC }),
    ).toBe("-100123:42");

    expect(parseScopeKey("dm:123")).toEqual({ chatId: 123, context: SCOPE_CONTEXT.DM });
    expect(parseScopeKey("chat:-100123")).toEqual({
      chatId: -100123,
      context: SCOPE_CONTEXT.GROUP_GENERAL,
    });
    expect(parseScopeKey("-100123:1")).toEqual({
      chatId: -100123,
      threadId: GENERAL_TOPIC_THREAD_ID,
      context: SCOPE_CONTEXT.GROUP_GENERAL,
    });
    expect(parseScopeKey("-100123:42")).toEqual({
      chatId: -100123,
      threadId: 42,
      context: SCOPE_CONTEXT.GROUP_TOPIC,
    });
    expect(parseScopeKey(GLOBAL_SCOPE_KEY)).toBeNull();
    expect(parseScopeKey("invalid")).toBeNull();
  });

  it("resolves scopes from Telegram context payloads", () => {
    expect(
      getScopeFromContext(
        createContext({ id: 123, type: "private", first_name: "Yarden" }, { message: { message_id: 1 } }),
      ),
    ).toEqual({ key: "dm:123", chatId: 123, threadId: null, context: SCOPE_CONTEXT.DM });

    expect(
      getScopeFromContext(
        createContext(
          { id: -100123, type: "supergroup", title: "Group" },
          { message: { message_id: 2, message_thread_id: 42 } },
        ),
      ),
    ).toEqual({ key: "-100123:42", chatId: -100123, threadId: 42, context: SCOPE_CONTEXT.GROUP_TOPIC });

    expect(
      getScopeFromContext(
        createContext(
          { id: -100123, type: "supergroup", title: "Group" },
          { callbackQuery: { id: "cb", chat_instance: "ci", message: { message_id: 3, is_topic_message: true } } },
        ),
      ),
    ).toEqual({
      key: "-100123:1",
      chatId: -100123,
      threadId: GENERAL_TOPIC_THREAD_ID,
      context: SCOPE_CONTEXT.GROUP_GENERAL,
    });
  });

  it("falls back to global when no concrete scope can be resolved", () => {
    expect(getScopeFromContext(createContext(undefined))).toBeNull();
    expect(getScopeKeyFromContext(createContext({ id: 123, type: "unknown" } as Context["chat"]))).toBe(
      GLOBAL_SCOPE_KEY,
    );
  });

  it("normalizes thread send options", () => {
    expect(getMessageThreadId(null)).toBeNull();
    expect(getMessageThreadId(GENERAL_TOPIC_THREAD_ID)).toBeNull();
    expect(getMessageThreadId(42)).toBe(42);

    expect(getThreadSendOptions(null)).toEqual({});
    expect(getThreadSendOptions(GENERAL_TOPIC_THREAD_ID)).toEqual({});
    expect(getThreadSendOptions(42)).toEqual({ message_thread_id: 42 });

    expect(getChatActionThreadOptions(null)).toEqual({});
    expect(getChatActionThreadOptions(GENERAL_TOPIC_THREAD_ID)).toEqual({ message_thread_id: 1 });
  });

  it("recreates topic scopes from stored keys", () => {
    const topicScope = getScopeFromKey("-100123:42");

    expect(topicScope).toEqual({
      key: "-100123:42",
      chatId: -100123,
      threadId: 42,
      context: SCOPE_CONTEXT.GROUP_TOPIC,
    });
    expect(isTopicScope(topicScope)).toBe(true);
    expect(isTopicScope(getScopeFromKey("chat:-100123"))).toBe(false);
  });
});
