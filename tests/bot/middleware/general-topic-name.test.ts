import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import {
  __resetGeneralTopicNameMiddlewareForTests,
  ensureGeneralTopicName,
} from "../../../src/bot/middleware/general-topic-name.js";
import { GENERAL_TOPIC } from "../../../src/bot/constants.js";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createForumContext(chatId: number): Context {
  return {
    chat: { id: chatId, type: "supergroup", is_forum: true },
    api: {
      editGeneralForumTopic: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

describe("bot/middleware/general-topic-name", () => {
  beforeEach(() => {
    __resetGeneralTopicNameMiddlewareForTests();
  });

  it("renames the General topic only once per forum chat", async () => {
    const ctx = createForumContext(-100123);

    await ensureGeneralTopicName(ctx);
    await ensureGeneralTopicName(ctx);

    expect(ctx.api.editGeneralForumTopic).toHaveBeenCalledTimes(1);
    expect(ctx.api.editGeneralForumTopic).toHaveBeenCalledWith(-100123, GENERAL_TOPIC.NAME);
  });
});
