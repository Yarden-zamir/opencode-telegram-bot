import { describe, expect, it, vi } from "vitest";
import { deliverBoundTopicAssistantResponse } from "../../../src/bot/utils/background-session-notification.js";

describe("bot/utils/background-session-notification", () => {
  it("sends the full assistant response to the bound topic thread", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
    const message = vi.fn().mockResolvedValue({
      data: {
        parts: [
          { type: "text", text: "First line\n" },
          { type: "text", text: "Second line" },
        ],
      },
    });
    const messages = vi.fn();

    const delivered = await deliverBoundTopicAssistantResponse({
      api: { sendMessage } as never,
      client: { session: { message, messages } },
      notification: {
        kind: "assistant_response",
        sessionId: "session-1",
        messageId: "message-1",
      },
      target: { chatId: -100123, threadId: 63 },
      projectWorktree: "/repo",
    });

    expect(delivered).toBe(true);
    expect(message).toHaveBeenCalledWith({
      sessionID: "session-1",
      messageID: "message-1",
      directory: "/repo",
    });
    expect(messages).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(-100123, "First line\nSecond line", {
      message_thread_id: 63,
    });
  });

  it("does not send or fetch when the session is unbound", async () => {
    const sendMessage = vi.fn();
    const message = vi.fn();
    const messages = vi.fn();

    const delivered = await deliverBoundTopicAssistantResponse({
      api: { sendMessage } as never,
      client: { session: { message, messages } },
      notification: {
        kind: "assistant_response",
        sessionId: "session-1",
        messageId: "message-1",
      },
      target: null,
    });

    expect(delivered).toBe(false);
    expect(message).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores non-assistant background notifications", async () => {
    const sendMessage = vi.fn();
    const message = vi.fn();
    const messages = vi.fn();

    const delivered = await deliverBoundTopicAssistantResponse({
      api: { sendMessage } as never,
      client: { session: { message, messages } },
      notification: {
        kind: "question_asked",
        sessionId: "session-1",
        requestId: "request-1",
      },
      target: { chatId: -100123, threadId: 63 },
      projectWorktree: "/repo",
    });

    expect(delivered).toBe(false);
    expect(message).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
