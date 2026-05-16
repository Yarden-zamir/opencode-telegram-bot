import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  handleForumTopicClosed,
  handleForumTopicCreated,
} from "../../../src/bot/handlers/forum-topic.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  sessionCreateMock: vi.fn(),
  sessionAbortMock: vi.fn(),
  sessionDeleteMock: vi.fn(),
  getCurrentProjectMock: vi.fn(),
  setCurrentProjectMock: vi.fn(),
  setCurrentAgentMock: vi.fn(),
  setCurrentModelMock: vi.fn(),
  setCurrentSessionMock: vi.fn(),
  clearSessionMock: vi.fn(),
  getTopicBindingByScopeKeyMock: vi.fn(),
  registerTopicSessionBindingMock: vi.fn(),
  updateTopicBindingStatusMock: vi.fn(),
  attachToSessionMock: vi.fn(),
  ensureEventSubscriptionMock: vi.fn(),
  ingestSessionInfoForCacheMock: vi.fn(),
  clearAllInteractionStateMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      create: mocked.sessionCreateMock,
      abort: mocked.sessionAbortMock,
      delete: mocked.sessionDeleteMock,
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
  clearSession: mocked.clearSessionMock,
}));

vi.mock("../../../src/session/cache-manager.js", () => ({
  ingestSessionInfoForCache: mocked.ingestSessionInfoForCacheMock,
  __resetSessionDirectoryCacheForTests: vi.fn(),
}));

vi.mock("../../../src/interaction/cleanup.js", () => ({
  clearAllInteractionState: mocked.clearAllInteractionStateMock,
}));

vi.mock("../../../src/topic/manager.js", () => ({
  getTopicBindingByScopeKey: mocked.getTopicBindingByScopeKeyMock,
  registerTopicSessionBinding: mocked.registerTopicSessionBindingMock,
  updateTopicBindingStatus: mocked.updateTopicBindingStatusMock,
}));

vi.mock("../../../src/attach/service.js", () => ({
  attachToSession: mocked.attachToSessionMock,
}));

vi.mock("../../../src/keyboard/manager.js", () => ({
  keyboardManager: {
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

function createForumTopicContext(options: { fromBot?: boolean; isForum?: boolean } = {}): Context {
  return {
    chat: { id: -100123, type: "supergroup", is_forum: options.isForum ?? true },
    from: { id: 123, is_bot: options.fromBot ?? false },
    message: {
      message_id: 10,
      message_thread_id: 42,
      is_topic_message: true,
      forum_topic_created: { name: "Manual topic" },
    },
    reply: vi.fn().mockResolvedValue({ message_id: 11 }),
  } as unknown as Context;
}

function createForumTopicClosedContext(): Context {
  return {
    chat: { id: -100123, type: "supergroup", is_forum: true },
    from: { id: 123, is_bot: false },
    message: {
      message_id: 10,
      message_thread_id: 42,
      is_topic_message: true,
      forum_topic_closed: {},
    },
  } as unknown as Context;
}

function createDeps() {
  return {
    bot: { api: {} } as Bot<Context>,
    ensureEventSubscription: mocked.ensureEventSubscriptionMock,
  };
}

describe("bot/handlers/forum-topic", () => {
  beforeEach(() => {
    mocked.sessionCreateMock.mockReset();
    mocked.sessionAbortMock.mockReset();
    mocked.sessionDeleteMock.mockReset();
    mocked.getCurrentProjectMock.mockReset();
    mocked.setCurrentProjectMock.mockReset();
    mocked.setCurrentAgentMock.mockReset();
    mocked.setCurrentModelMock.mockReset();
    mocked.setCurrentSessionMock.mockReset();
    mocked.clearSessionMock.mockReset();
    mocked.getTopicBindingByScopeKeyMock.mockReset();
    mocked.registerTopicSessionBindingMock.mockReset();
    mocked.updateTopicBindingStatusMock.mockReset();
    mocked.attachToSessionMock.mockReset();
    mocked.ensureEventSubscriptionMock.mockReset();
    mocked.ingestSessionInfoForCacheMock.mockReset();
    mocked.clearAllInteractionStateMock.mockReset();
    mocked.getTopicBindingByScopeKeyMock.mockReturnValue(undefined);
    mocked.ingestSessionInfoForCacheMock.mockResolvedValue(undefined);
    mocked.attachToSessionMock.mockResolvedValue({
      busy: false,
      alreadyAttached: false,
      restoredQuestion: false,
      restoredPermissions: 0,
    });
    mocked.sessionAbortMock.mockResolvedValue({ data: true, error: null });
    mocked.sessionDeleteMock.mockResolvedValue({ data: true, error: null });
  });

  it("creates and binds a session when an authorized user manually creates a topic", async () => {
    const project = { id: "project-1", worktree: "/repo" };
    mocked.getCurrentProjectMock.mockImplementation((scopeKey?: string) =>
      scopeKey === "-100123:1" ? project : undefined,
    );
    mocked.sessionCreateMock.mockResolvedValueOnce({
      data: { id: "session-1", title: "Session One" },
      error: null,
    });

    const ctx = createForumTopicContext();
    const handled = await handleForumTopicCreated(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionCreateMock).toHaveBeenCalledWith({ directory: "/repo" });
    expect(mocked.setCurrentProjectMock).toHaveBeenCalledWith(project, "-100123:42");
    expect(mocked.setCurrentSessionMock).toHaveBeenCalledWith(
      { id: "session-1", title: "Session One", directory: "/repo" },
      "-100123:42",
    );
    expect(mocked.registerTopicSessionBindingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: "-100123:42",
        chatId: -100123,
        threadId: 42,
        sessionId: "session-1",
        projectId: "project-1",
        projectWorktree: "/repo",
        topicName: "Manual topic",
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
    expect(ctx.reply).toHaveBeenCalledWith(
      t("new.topic_created", { title: "Session One" }),
      expect.objectContaining({ message_thread_id: 42, reply_markup: { keyboard: true } }),
    );
  });

  it("asks for a project when none is selected for the forum", async () => {
    mocked.getCurrentProjectMock.mockReturnValue(undefined);

    const ctx = createForumTopicContext();
    const handled = await handleForumTopicCreated(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionCreateMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("new.project_not_selected"), { message_thread_id: 42 });
  });

  it("does not create another session when the topic is already bound", async () => {
    mocked.getTopicBindingByScopeKeyMock.mockReturnValue({ sessionId: "session-1" });

    const ctx = createForumTopicContext();
    const handled = await handleForumTopicCreated(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionCreateMock).not.toHaveBeenCalled();
  });

  it("ignores bot-created topics", async () => {
    const ctx = createForumTopicContext({ fromBot: true });
    const handled = await handleForumTopicCreated(ctx, createDeps());

    expect(handled).toBe(false);
    expect(mocked.sessionCreateMock).not.toHaveBeenCalled();
  });

  it("closes the bound session when a forum topic is closed", async () => {
    mocked.getTopicBindingByScopeKeyMock.mockReturnValue({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
      projectWorktree: "/repo",
      status: "active",
    });

    const handled = await handleForumTopicClosed(createForumTopicClosedContext(), {
      bot: { api: {} } as Bot<Context>,
    });

    expect(handled).toBe(true);
    expect(mocked.updateTopicBindingStatusMock).toHaveBeenCalledWith(-100123, 42, "closed");
    expect(mocked.clearSessionMock).toHaveBeenCalledWith("-100123:42");
    expect(mocked.clearAllInteractionStateMock).toHaveBeenCalledWith(
      "forum_topic_closed",
      "-100123:42",
    );
    expect(mocked.sessionAbortMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/repo",
    });
    expect(mocked.sessionDeleteMock).toHaveBeenCalledWith({ sessionID: "session-1" });
  });
});
