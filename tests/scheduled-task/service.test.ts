import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledTaskFromText, deleteScheduledTask } from "../../src/scheduled-task/service.js";

const mocked = vi.hoisted(() => ({
  currentProject: {
    id: "project-1",
    worktree: "/repo",
  } as { id: string; worktree: string } | null,
  storedModel: {
    providerID: "openai",
    modelID: "gpt-5",
    variant: "default",
  },
  parseTaskSchedule: vi.fn(),
  listScheduledTasks: vi.fn(),
  addScheduledTask: vi.fn(),
  removeScheduledTask: vi.fn(),
  registerTask: vi.fn(),
  removeTask: vi.fn(),
}));

vi.mock("../../src/settings/manager.js", () => ({
  getCurrentProject: vi.fn(() => mocked.currentProject),
}));

vi.mock("../../src/model/manager.js", () => ({
  getStoredModel: vi.fn(() => mocked.storedModel),
}));

vi.mock("../../src/scheduled-task/schedule-parser.js", () => ({
  parseTaskSchedule: mocked.parseTaskSchedule,
}));

vi.mock("../../src/scheduled-task/store.js", () => ({
  listScheduledTasks: mocked.listScheduledTasks,
  addScheduledTask: mocked.addScheduledTask,
  removeScheduledTask: mocked.removeScheduledTask,
}));

vi.mock("../../src/scheduled-task/runtime.js", () => ({
  scheduledTaskRuntime: {
    registerTask: mocked.registerTask,
    removeTask: mocked.removeTask,
  },
}));

describe("scheduled-task/service", () => {
  beforeEach(() => {
    mocked.currentProject = {
      id: "project-1",
      worktree: "/repo",
    };
    mocked.parseTaskSchedule.mockReset();
    mocked.listScheduledTasks.mockReset();
    mocked.addScheduledTask.mockReset();
    mocked.removeScheduledTask.mockReset();
    mocked.registerTask.mockReset();
    mocked.removeTask.mockReset();

    mocked.listScheduledTasks.mockReturnValue([]);
    mocked.addScheduledTask.mockResolvedValue(undefined);
    mocked.removeScheduledTask.mockResolvedValue(true);
    mocked.parseTaskSchedule.mockResolvedValue({
      kind: "cron",
      cron: "0 9 * * *",
      timezone: "UTC",
      summary: "Every day at 09:00",
      nextRunAt: "2026-03-16T09:00:00.000Z",
    });
  });

  it("creates, persists, and registers a scheduled task", async () => {
    const task = await createScheduledTaskFromText({
      scheduleText: " every day at 9am ",
      prompt: " Send status ",
    });

    expect(mocked.parseTaskSchedule).toHaveBeenCalledWith("every day at 9am", "/repo");
    expect(mocked.addScheduledTask).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
    expect(mocked.registerTask).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
    expect(task).toMatchObject({
      projectId: "project-1",
      projectWorktree: "/repo",
      scheduleText: "every day at 9am",
      scheduleSummary: "Every day at 09:00",
      prompt: "Send status",
      model: mocked.storedModel,
      kind: "cron",
      cron: "0 9 * * *",
    });
  });

  it("removes the runtime timer only when a scheduled task is deleted", async () => {
    await expect(deleteScheduledTask(" task-1 ")).resolves.toBe(true);
    expect(mocked.removeScheduledTask).toHaveBeenCalledWith("task-1");
    expect(mocked.removeTask).toHaveBeenCalledWith("task-1");

    mocked.removeTask.mockReset();
    mocked.removeScheduledTask.mockResolvedValue(false);

    await expect(deleteScheduledTask("missing-task")).resolves.toBe(false);
    expect(mocked.removeTask).not.toHaveBeenCalled();
  });
});
