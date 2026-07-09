import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_CONTEXT, createScopeKeyFromParams } from "../../src/bot/scope.js";
import { setRuntimeMode } from "../../src/runtime/mode.js";
import {
  __flushSettingsForTests,
  __resetSettingsForTests,
  getCurrentSession,
  loadSettings,
  setCurrentProject,
} from "../../src/settings/manager.js";
import {
  __resetTopicManagerForTests,
  getTopicBindingBySessionId,
  registerTopicSessionBinding,
} from "../../src/topic/manager.js";
import {
  ensureForumTopicForSession,
  reconcileStoredSessionsWithForumTopics,
} from "../../src/topic/startup-reconcile.js";

const mocked = vi.hoisted(() => ({
  sessionListMock: vi.fn(),
}));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      list: mocked.sessionListMock,
    },
  },
}));

vi.mock("../../src/agent/manager.js", () => ({
  getStoredAgent: vi.fn(() => "build"),
  resolveProjectAgent: vi.fn(async (agentName?: string) => agentName ?? "build"),
}));

vi.mock("../../src/model/manager.js", () => ({
  getStoredModel: vi.fn(() => ({ providerID: "openai", modelID: "gpt-5", variant: "default" })),
}));

describe("topic/startup-reconcile", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-topic-startup-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    __resetSettingsForTests();
    __resetTopicManagerForTests();
    await loadSettings();
    mocked.sessionListMock.mockReset();
  });

  afterEach(async () => {
    await __flushSettingsForTests();
    delete process.env.OPENCODE_TELEGRAM_HOME;
    __resetSettingsForTests();
    __resetTopicManagerForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it("creates missing forum topics for stored project sessions on startup", async () => {
    const generalScopeKey = createScopeKeyFromParams({
      chatId: -100123,
      threadId: 1,
      context: SCOPE_CONTEXT.GROUP_GENERAL,
    });
    const project = { id: "project-1", worktree: "/repo" };
    setCurrentProject(project, generalScopeKey);
    mocked.sessionListMock.mockResolvedValueOnce({
      data: [
        { id: "session-1", title: "Session One", directory: "/repo" },
        { id: "session-2", title: "Session Two", directory: "/repo" },
      ],
      error: null,
    });
    const api = {
      createForumTopic: vi
        .fn()
        .mockResolvedValueOnce({ message_thread_id: 42 })
        .mockResolvedValueOnce({ message_thread_id: 43 }),
    };

    await reconcileStoredSessionsWithForumTopics(api, "test");

    expect(mocked.sessionListMock).toHaveBeenCalledWith({ directory: "/repo", roots: true });
    expect(api.createForumTopic).toHaveBeenCalledTimes(2);
    expect(api.createForumTopic).toHaveBeenNthCalledWith(1, -100123, "Session One", {
      icon_color: 0x6fb9f0,
    });
    expect(api.createForumTopic).toHaveBeenNthCalledWith(2, -100123, "Session Two", {
      icon_color: 0x6fb9f0,
    });
    expect(getTopicBindingBySessionId("session-1")).toMatchObject({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      status: "active",
    });
    expect(getCurrentSession("-100123:43")).toMatchObject({ id: "session-2" });
  });

  it("does not create another topic for an already bound session", async () => {
    const generalScopeKey = createScopeKeyFromParams({
      chatId: -100123,
      threadId: 1,
      context: SCOPE_CONTEXT.GROUP_GENERAL,
    });
    const project = { id: "project-1", worktree: "/repo" };
    setCurrentProject(project, generalScopeKey);
    registerTopicSessionBinding({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
      projectWorktree: "/repo",
      topicName: "Session One",
    });
    mocked.sessionListMock.mockResolvedValueOnce({
      data: [{ id: "session-1", title: "Session One", directory: "/repo" }],
      error: null,
    });
    const api = { createForumTopic: vi.fn() };

    await reconcileStoredSessionsWithForumTopics(api, "test");

    expect(api.createForumTopic).not.toHaveBeenCalled();
  });

  describe("ensureForumTopicForSession (live events)", () => {
    function withGeneralProject(worktree: string) {
      const generalScopeKey = createScopeKeyFromParams({
        chatId: -100123,
        threadId: 1,
        context: SCOPE_CONTEXT.GROUP_GENERAL,
      });
      setCurrentProject({ id: "project-1", worktree }, generalScopeKey);
    }

    it("creates a topic for a newly created session in a stored project", async () => {
      withGeneralProject("/repo");
      const api = {
        createForumTopic: vi.fn().mockResolvedValueOnce({ message_thread_id: 77 }),
      };

      const created = await ensureForumTopicForSession(
        api,
        { id: "live-1", title: "Live One", directory: "/repo" },
        "session.created",
      );

      expect(created).toBe(true);
      expect(api.createForumTopic).toHaveBeenCalledTimes(1);
      expect(api.createForumTopic).toHaveBeenCalledWith(-100123, "Live One", {
        icon_color: 0x6fb9f0,
      });
      expect(getTopicBindingBySessionId("live-1")).toMatchObject({ threadId: 77 });
    });

    it("does not create a topic when no stored project matches the directory", async () => {
      withGeneralProject("/repo");
      const api = { createForumTopic: vi.fn() };

      const created = await ensureForumTopicForSession(
        api,
        { id: "live-2", title: "Elsewhere", directory: "/other" },
        "session.created",
      );

      expect(created).toBe(false);
      expect(api.createForumTopic).not.toHaveBeenCalled();
    });

    it("creates only one topic when created and updated race for the same session", async () => {
      withGeneralProject("/repo");
      const api = {
        createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 88 }),
      };
      const session = { id: "live-3", title: "Racing", directory: "/repo" };

      const [a, b] = await Promise.all([
        ensureForumTopicForSession(api, session, "session.created"),
        ensureForumTopicForSession(api, session, "session.updated"),
      ]);

      expect(api.createForumTopic).toHaveBeenCalledTimes(1);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });
  });
});
