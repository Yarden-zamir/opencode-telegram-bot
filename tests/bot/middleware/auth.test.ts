import { describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { authMiddleware } from "../../../src/bot/middleware/auth.js";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createContext(options: {
  userId?: number;
  isBot?: boolean;
  chatId?: number;
}): Context {
  return {
    from:
      options.userId === undefined
        ? undefined
        : { id: options.userId, is_bot: options.isBot ?? false },
    chat: options.chatId === undefined ? undefined : { id: options.chatId },
    api: {
      setMyCommands: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

describe("authMiddleware", () => {
  it("passes authorized user updates through", async () => {
    const ctx = createContext({ userId: 123456789, chatId: 123456789 });
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await authMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.api.setMyCommands).not.toHaveBeenCalled();
  });

  it("hides commands for unauthorized human chats", async () => {
    const ctx = createContext({ userId: 987654321, chatId: 987654321 });
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.api.setMyCommands).toHaveBeenCalledWith([], {
      scope: { type: "chat", chat_id: 987654321 },
    });
  });

  it("silently ignores bot-origin updates", async () => {
    const ctx = createContext({ userId: 555555555, isBot: true, chatId: 555555555 });
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.api.setMyCommands).not.toHaveBeenCalled();
  });
});
