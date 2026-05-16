import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../src/runtime/mode.js";
import { __resetSettingsForTests, loadSettings } from "../../src/settings/manager.js";
import {
  addScheduledTask,
  getScheduledTaskTopicByChatAndProject,
  getScheduledTaskTopicByChatAndThread,
  listScheduledTasks,
  listScheduledTaskTopics,
  removeScheduledTask,
  upsertScheduledTaskTopic,
} from "../../src/scheduled-task/store.js";
import {
  cleanupScheduledTaskSessionIgnores,
  isScheduledTaskSessionIgnored,
  registerScheduledTaskSessionIgnore,
  removeScheduledTaskSessionIgnore,
} from "../../src/scheduled-task/session-ignore.js";
import type { ScheduledTask, ScheduledTaskTopicBinding } from "../../src/scheduled-task/types.js";

function createScheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    kind: "cron",
    projectId: "project-1",
    projectWorktree: "D:/Projects/Repo",
    model: {
      providerID: "openai",
      modelID: "gpt-5",
      variant: "default",
    },
    scheduleText: "every 5 minutes",
    scheduleSummary: "Every 5 minutes",
    timezone: "UTC",
    cron: "*/5 * * * *",
    prompt: "Check repository status",
    createdAt: "2026-03-15T10:00:00.000Z",
    nextRunAt: "2026-03-15T10:05:00.000Z",
    lastRunAt: null,
    runCount: 0,
    lastStatus: "idle",
    lastError: null,
    ...overrides,
  } as ScheduledTask;
}

function createTopicBinding(
  overrides: Partial<ScheduledTaskTopicBinding> = {},
): ScheduledTaskTopicBinding {
  return {
    chatId: -100123,
    projectId: "project-1",
    projectWorktree: "D:/Projects/Repo",
    threadId: 42,
    topicName: "Scheduled Tasks",
    createdAt: "2026-03-15T10:00:00.000Z",
    updatedAt: "2026-03-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("scheduled-task/store", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-task-store-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    __resetSettingsForTests();
    await loadSettings();
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    __resetSettingsForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it("persists scheduled tasks to settings.json", async () => {
    const task = createScheduledTask();

    await addScheduledTask(task);

    expect(listScheduledTasks()).toEqual([task]);

    const settingsPath = path.join(tempHome, "settings.json");
    const settingsFile = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      scheduledTasks?: ScheduledTask[];
    };

    expect(settingsFile.scheduledTasks).toEqual([task]);
  });

  it("removes scheduled task from persisted storage", async () => {
    const firstTask = createScheduledTask();
    const secondTask = createScheduledTask({
      id: "task-2",
      kind: "once",
      scheduleText: "tomorrow at 12:00",
      scheduleSummary: "Tomorrow at 12:00",
      runAt: "2026-03-16T12:00:00.000Z",
      cron: undefined,
      nextRunAt: "2026-03-16T12:00:00.000Z",
    });

    await addScheduledTask(firstTask);
    await addScheduledTask(secondTask);

    await removeScheduledTask("task-1");

    expect(listScheduledTasks()).toEqual([secondTask]);
  });

  it("persists scheduled task session ignores and prunes stale entries", async () => {
    await registerScheduledTaskSessionIgnore("fresh-session", new Date("2026-03-16T10:00:00.000Z"));
    await registerScheduledTaskSessionIgnore("stale-session", new Date("2026-03-15T09:59:59.000Z"));

    expect(isScheduledTaskSessionIgnored("fresh-session", new Date("2026-03-16T12:00:00.000Z"))).toBe(
      true,
    );
    expect(isScheduledTaskSessionIgnored("stale-session", new Date("2026-03-16T12:00:00.000Z"))).toBe(
      false,
    );

    const removed = await cleanupScheduledTaskSessionIgnores(new Date("2026-03-16T12:00:00.000Z"));

    expect(removed).toBe(1);

    const settingsPath = path.join(tempHome, "settings.json");
    const settingsFile = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      scheduledTaskSessionIgnores?: Array<{ sessionId: string; createdAt: string }>;
    };
    expect(settingsFile.scheduledTaskSessionIgnores).toEqual([
      { sessionId: "fresh-session", createdAt: "2026-03-16T10:00:00.000Z" },
    ]);

    await removeScheduledTaskSessionIgnore("fresh-session");

    expect(isScheduledTaskSessionIgnored("fresh-session", new Date("2026-03-16T12:00:00.000Z"))).toBe(
      false,
    );
  });

  it("persists and looks up scheduled task topic bindings", async () => {
    const topic = createTopicBinding();

    await upsertScheduledTaskTopic(topic);

    expect(listScheduledTaskTopics()).toEqual([topic]);
    expect(await getScheduledTaskTopicByChatAndProject(-100123, "project-1")).toEqual(topic);
    expect(await getScheduledTaskTopicByChatAndThread(-100123, 42)).toEqual(topic);

    const updatedTopic = createTopicBinding({ threadId: 99, updatedAt: "2026-03-15T11:00:00.000Z" });
    await upsertScheduledTaskTopic(updatedTopic);

    expect(listScheduledTaskTopics()).toEqual([updatedTopic]);
    expect(await getScheduledTaskTopicByChatAndThread(-100123, 42)).toBeNull();

    const settingsPath = path.join(tempHome, "settings.json");
    const settingsFile = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      scheduledTaskTopics?: ScheduledTaskTopicBinding[];
    };
    expect(settingsFile.scheduledTaskTopics).toEqual([updatedTopic]);
  });
});
