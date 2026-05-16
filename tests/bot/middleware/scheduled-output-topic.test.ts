import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { scheduledOutputTopicMiddleware } from "../../../src/bot/middleware/scheduled-output-topic.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  binding: null as { chatId: number; threadId: number } | null,
  getTopicMock: vi.fn(),
}));

vi.mock("../../../src/scheduled-task/store.js", () => ({
  getScheduledTaskTopicByChatAndThread: mocked.getTopicMock,
}));

function createContext(text: string, threadId = 42): Context {
  return {
    chat: { id: -100123, type: "supergroup" },
    message: { text, message_thread_id: threadId } as Context["message"],
    reply: vi.fn().mockResolvedValue({ message_id: 500 }),
  } as unknown as Context;
}

describe("bot/middleware/scheduled-output-topic", () => {
  beforeEach(() => {
    mocked.binding = { chatId: -100123, threadId: 42 };
    mocked.getTopicMock.mockReset();
    mocked.getTopicMock.mockImplementation(async (chatId: number, threadId: number) => {
      if (mocked.binding?.chatId === chatId && mocked.binding.threadId === threadId) {
        return mocked.binding;
      }

      return null;
    });
  });

  it("blocks commands in a scheduled task output topic", async () => {
    const ctx = createContext("/status");
    const next: NextFunction = vi.fn();

    await scheduledOutputTopicMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("task.output_topic_commands_only"), {
      message_thread_id: 42,
    });
  });

  it("allows help commands in a scheduled task output topic", async () => {
    const ctx = createContext("/help");
    const next: NextFunction = vi.fn();

    await scheduledOutputTopicMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("allows commands outside scheduled task output topics", async () => {
    mocked.binding = null;
    const ctx = createContext("/status");
    const next: NextFunction = vi.fn();

    await scheduledOutputTopicMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
