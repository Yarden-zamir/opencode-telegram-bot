import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../src/runtime/mode.js";
import {
  TOPIC_SESSION_STATUS,
  __flushSettingsForTests,
  __resetSettingsForTests,
  loadSettings,
  setCurrentProject,
  setCurrentSession,
} from "../../src/settings/manager.js";
import {
  __resetTopicManagerForTests,
  createTopicBindingKey,
  getSessionRouteTarget,
  getTopicBinding,
  getTopicBindingBySessionId,
  listAllTopicBindings,
  registerTopicSessionBinding,
  updateTopicBindingNameBySessionId,
  updateTopicBindingStatus,
} from "../../src/topic/manager.js";

describe("topic/manager", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-topic-manager-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    __resetSettingsForTests();
    __resetTopicManagerForTests();
    await loadSettings();
  });

  afterEach(async () => {
    await __flushSettingsForTests();
    delete process.env.OPENCODE_TELEGRAM_HOME;
    __resetSettingsForTests();
    __resetTopicManagerForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it("registers and routes topic session bindings", () => {
    const binding = registerTopicSessionBinding({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
      projectWorktree: "/repo",
      topicName: "Feature work",
    });

    expect(createTopicBindingKey(-100123, 42)).toBe("-100123:42");
    expect(binding).toMatchObject({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
      projectWorktree: "/repo",
      topicName: "Feature work",
      status: TOPIC_SESSION_STATUS.ACTIVE,
    });
    expect(getTopicBinding(-100123, 42)).toMatchObject({ sessionId: "session-1" });
    expect(getTopicBindingBySessionId("session-1")).toMatchObject({ threadId: 42 });
    expect(getSessionRouteTarget("session-1")).toEqual({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
    });
  });

  it("rejects binding a topic to a different session", () => {
    registerTopicSessionBinding({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
    });

    expect(() =>
      registerTopicSessionBinding({
        scopeKey: "-100123:42",
        chatId: -100123,
        threadId: 42,
        sessionId: "session-2",
        projectId: "project-1",
      }),
    ).toThrow("already bound to session session-1");
  });

  it("moves a session binding when it is rebound to another topic", () => {
    registerTopicSessionBinding({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
    });

    registerTopicSessionBinding({
      scopeKey: "-100123:43",
      chatId: -100123,
      threadId: 43,
      sessionId: "session-1",
      projectId: "project-1",
    });

    expect(getTopicBinding(-100123, 42)).toBeUndefined();
    expect(getTopicBinding(-100123, 43)).toMatchObject({ sessionId: "session-1" });
  });

  it("updates binding status and topic name", () => {
    registerTopicSessionBinding({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
    });

    updateTopicBindingStatus(-100123, 42, TOPIC_SESSION_STATUS.CLOSED);
    updateTopicBindingNameBySessionId("session-1", "Renamed topic");

    expect(getTopicBinding(-100123, 42)).toMatchObject({
      status: TOPIC_SESSION_STATUS.CLOSED,
      topicName: "Renamed topic",
      closedAt: expect.any(Number),
    });
    expect(getSessionRouteTarget("session-1")).toBeNull();
  });

  it("sets closedAt when marking a binding stale", () => {
    registerTopicSessionBinding({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
    });

    updateTopicBindingStatus(-100123, 42, TOPIC_SESSION_STATUS.STALE);

    expect(getTopicBinding(-100123, 42)).toMatchObject({
      status: TOPIC_SESSION_STATUS.STALE,
      closedAt: expect.any(Number),
    });
  });

  it("hydrates topic bindings from scoped sessions", () => {
    setCurrentProject({ id: "project-1", worktree: "/repo" }, "-100123:42");
    setCurrentSession({ id: "session-1", title: "Work", directory: "/repo" }, "-100123:42");

    expect(listAllTopicBindings()).toEqual([
      expect.objectContaining({
        scopeKey: "-100123:42",
        chatId: -100123,
        threadId: 42,
        sessionId: "session-1",
        projectId: "project-1",
        projectWorktree: "/repo",
        status: TOPIC_SESSION_STATUS.ACTIVE,
      }),
    ]);
  });
});
