import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { newCommand } from "../../../src/bot/commands/new.js";
import { foregroundSessionState } from "../../../src/scheduled-task/foreground-state.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  sessionCreateMock: vi.fn(),
  getCurrentProjectMock: vi.fn(),
  setCurrentProjectMock: vi.fn(),
  setCurrentAgentMock: vi.fn(),
  setCurrentModelMock: vi.fn(),
  setCurrentSessionMock: vi.fn(),
  registerTopicSessionBindingMock: vi.fn(),
  attachToSessionMock: vi.fn(),
  ensureEventSubscriptionMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      create: mocked.sessionCreateMock,
    },
  },
}));

vi.mock("../../../src/settings/manager.js", () => ({
  getCurrentProject: mocked.getCurrentProjectMock,
  setCurrentProject: mocked.setCurrentProjectMock,
  setCurrentAgent: mocked.setCurrentAgentMock,
  setCurrentModel: mocked.setCurrentModelMock,
  TOPIC_SESSION_STATUS: {
    ACTIVE: "active",
    CLOSED: "closed",
    STALE: "stale",
    ABANDONED: "abandoned",
    ERROR: "error",
  },
}));

vi.mock("../../../src/session/manager.js", () => ({
  setCurrentSession: mocked.setCurrentSessionMock,
}));

vi.mock("../../../src/session/cache-manager.js", () => ({
  ingestSessionInfoForCache: vi.fn().mockResolvedValue(undefined),
  __resetSessionDirectoryCacheForTests: vi.fn(),
}));

vi.mock("../../../src/interaction/cleanup.js", () => ({
  clearAllInteractionState: vi.fn(),
}));

vi.mock("../../../src/summary/aggregator.js", () => ({
  summaryAggregator: { clear: vi.fn() },
}));

vi.mock("../../../src/pinned/manager.js", () => ({
  pinnedMessageManager: {
    isInitialized: vi.fn(() => false),
    initialize: vi.fn(),
    onSessionChange: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../src/keyboard/manager.js", () => ({
  keyboardManager: {
    initialize: vi.fn(),
    updateAgent: vi.fn(),
    getContextInfo: vi.fn(() => null),
  },
}));

vi.mock("../../../src/agent/manager.js", () => ({
  getStoredAgent: vi.fn(() => "build"),
  resolveProjectAgent: vi.fn(async (agentName?: string) => agentName ?? "build"),
}));

vi.mock("../../../src/model/manager.js", () => ({
  getStoredModel: vi.fn(() => ({ providerID: "openai", modelID: "gpt-5", variant: "default" })),
}));

vi.mock("../../../src/variant/manager.js", () => ({
  formatVariantForButton: vi.fn(() => "Default"),
}));

vi.mock("../../../src/bot/utils/keyboard.js", () => ({
  createMainKeyboard: vi.fn(() => ({ keyboard: true })),
}));

vi.mock("../../../src/attach/service.js", () => ({
  attachToSession: mocked.attachToSessionMock,
}));

vi.mock("../../../src/topic/manager.js", () => ({
  registerTopicSessionBinding: mocked.registerTopicSessionBindingMock,
}));

function createContext(): Context {
  return {
    chat: { id: 123 },
    api: {},
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

function createForumGeneralContext(): Context {
  return {
    chat: { id: -100123, type: "supergroup", is_forum: true },
    message: { text: "/new", is_topic_message: true },
    api: {
      createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42 }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 777 }),
    },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

function createDeps() {
  return {
    bot: { api: {} } as Bot<Context>,
    ensureEventSubscription: mocked.ensureEventSubscriptionMock,
  };
}

describe("bot/commands/new", () => {
  beforeEach(() => {
    foregroundSessionState.__resetForTests();
    mocked.sessionCreateMock.mockReset();
    mocked.getCurrentProjectMock.mockReset();
    mocked.setCurrentProjectMock.mockReset();
    mocked.setCurrentAgentMock.mockReset();
    mocked.setCurrentModelMock.mockReset();
    mocked.setCurrentSessionMock.mockReset();
    mocked.registerTopicSessionBindingMock.mockReset();
    mocked.attachToSessionMock.mockReset();
    mocked.attachToSessionMock.mockResolvedValue({
      busy: false,
      alreadyAttached: false,
      restoredQuestion: false,
      restoredPermissions: 0,
    });
    mocked.ensureEventSubscriptionMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "project-1", worktree: "/repo" });
  });

  it("blocks new session creation while foreground session is busy", async () => {
    foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const ctx = createContext();
    await newCommand(ctx as never, createDeps());

    expect(mocked.sessionCreateMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("bot.session_busy"));
  });

  it("creates and immediately follows the new session", async () => {
    mocked.sessionCreateMock.mockResolvedValueOnce({
      data: { id: "session-2", title: "Session Two" },
      error: null,
    });

    const ctx = createContext();
    await newCommand(ctx as never, createDeps());

    expect(mocked.attachToSessionMock).toHaveBeenCalledWith({
      bot: expect.any(Object),
      chatId: 123,
      session: {
        id: "session-2",
        title: "Session Two",
        directory: "/repo",
      },
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      t("new.created", { title: "Session Two" }),
      expect.objectContaining({
        reply_markup: { keyboard: true },
      }),
    );
  });

  it("creates a forum topic when /new is run from the general forum topic", async () => {
    mocked.sessionCreateMock.mockResolvedValueOnce({
      data: { id: "session-2", title: "Session Two" },
      error: null,
    });

    const ctx = createForumGeneralContext();
    await newCommand(ctx as never, createDeps());

    expect(ctx.api.createForumTopic).toHaveBeenCalledWith(-100123, "Session Two", {
      icon_color: 0x6fb9f0,
    });
    expect(mocked.setCurrentProjectMock).toHaveBeenCalledWith(
      { id: "project-1", worktree: "/repo" },
      "-100123:42",
    );
    expect(mocked.setCurrentSessionMock).toHaveBeenCalledWith(
      { id: "session-2", title: "Session Two", directory: "/repo" },
      "-100123:42",
    );
    expect(mocked.registerTopicSessionBindingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: "-100123:42",
        chatId: -100123,
        threadId: 42,
        sessionId: "session-2",
        status: "active",
      }),
    );
    expect(mocked.attachToSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: -100123,
        threadId: 42,
        scopeKey: "-100123:42",
      }),
    );
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      -100123,
      t("new.topic_created", { title: "Session Two" }),
      expect.objectContaining({ message_thread_id: 42 }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining(t("new.general_created")),
      {},
    );
  });
});
