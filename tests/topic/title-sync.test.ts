import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeMode } from "../../src/runtime/mode.js";
import {
  __flushSettingsForTests,
  __resetSettingsForTests,
  loadSettings,
} from "../../src/settings/manager.js";
import {
  __resetTopicManagerForTests,
  getTopicBindingBySessionId,
  registerTopicSessionBinding,
} from "../../src/topic/manager.js";
import { syncTopicTitleForSession } from "../../src/topic/title-sync.js";

describe("topic/title-sync", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-topic-title-"));
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

  it("does nothing when the session is not bound to a topic", async () => {
    const api = { editForumTopic: vi.fn() };

    await expect(syncTopicTitleForSession(api, "session-1", "New title")).resolves.toBe(false);

    expect(api.editForumTopic).not.toHaveBeenCalled();
  });

  it("renames the bound topic and stores the latest topic name", async () => {
    registerTopicSessionBinding({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
      topicName: "Old title",
    });
    const api = { editForumTopic: vi.fn().mockResolvedValue({}) };

    await expect(syncTopicTitleForSession(api, "session-1", "  New title  ")).resolves.toBe(true);

    expect(api.editForumTopic).toHaveBeenCalledWith(-100123, 42, { name: "New title" });
    expect(getTopicBindingBySessionId("session-1")).toMatchObject({ topicName: "New title" });
  });

  it("stores the target title when Telegram reports the topic is already renamed", async () => {
    registerTopicSessionBinding({
      scopeKey: "-100123:42",
      chatId: -100123,
      threadId: 42,
      sessionId: "session-1",
      projectId: "project-1",
      topicName: "Old title",
    });
    const api = {
      editForumTopic: vi.fn().mockRejectedValue(new Error("Bad Request: TOPIC_NOT_MODIFIED")),
    };

    await expect(syncTopicTitleForSession(api, "session-1", "New title")).resolves.toBe(false);

    expect(getTopicBindingBySessionId("session-1")).toMatchObject({ topicName: "New title" });
  });
});
