import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getStoredModel } from "../model/manager.js";
import { getCurrentProject } from "../settings/manager.js";
import { t } from "../i18n/index.js";
import { parseTaskSchedule } from "./schedule-parser.js";
import { scheduledTaskRuntime } from "./runtime.js";
import { addScheduledTask, listScheduledTasks, removeScheduledTask } from "./store.js";
import {
  createScheduledTaskModel,
  type ParsedTaskSchedule,
  type ScheduledTask,
  type ScheduledTaskModel,
} from "./types.js";

export interface CreateScheduledTaskInput {
  scheduleText: string;
  prompt: string;
}

function validateCronMinutesFrequency(cron: string): void {
  const cronParts = cron.trim().split(/\s+/);
  if (cronParts.length < 5) {
    throw new Error("Invalid cron expression returned by parser");
  }

  const minuteValues = expandCronMinuteField(cronParts[0]);
  if (minuteValues.length <= 1) {
    return;
  }

  let minGap = 60;
  for (let index = 0; index < minuteValues.length; index++) {
    const currentValue = minuteValues[index];
    const nextValue =
      index === minuteValues.length - 1 ? minuteValues[0] + 60 : minuteValues[index + 1];
    minGap = Math.min(minGap, nextValue - currentValue);
  }

  if (minGap < 5) {
    throw new Error(t("task.schedule_too_frequent"));
  }
}

function expandCronMinuteField(field: string): number[] {
  const values = new Set<number>();

  for (const token of field.split(",")) {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      throw new Error("Invalid cron minute field returned by parser");
    }

    for (const value of expandCronMinuteToken(trimmedToken)) {
      values.add(value);
    }
  }

  return Array.from(values).sort((left, right) => left - right);
}

function expandCronMinuteToken(token: string): number[] {
  const [rawBase, rawStep] = token.split("/");
  if (rawStep !== undefined) {
    const step = Number.parseInt(rawStep, 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error("Invalid cron minute step returned by parser");
    }

    const baseValues = expandCronMinuteBase(rawBase);
    return baseValues.filter((_value, index) => baseValues.length > 0 && index % step === 0);
  }

  return expandCronMinuteBase(rawBase);
}

function expandCronMinuteBase(base: string): number[] {
  if (base === "*") {
    return Array.from({ length: 60 }, (_value, index) => index);
  }

  if (base.includes("-")) {
    const [rawStart, rawEnd] = base.split("-");
    const start = parseCronMinuteNumber(rawStart);
    const end = parseCronMinuteNumber(rawEnd);
    if (start > end) {
      throw new Error("Invalid cron minute range returned by parser");
    }

    return Array.from({ length: end - start + 1 }, (_value, index) => start + index);
  }

  return [parseCronMinuteNumber(base)];
}

function parseCronMinuteNumber(value: string): number {
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > 59) {
    throw new Error("Invalid cron minute value returned by parser");
  }

  return parsedValue;
}

function validateParsedSchedule(parsedSchedule: ParsedTaskSchedule): void {
  if (parsedSchedule.kind === "cron") {
    validateCronMinutesFrequency(parsedSchedule.cron);
  }
}

function buildScheduledTask(
  projectId: string,
  projectWorktree: string,
  model: ScheduledTaskModel,
  scheduleText: string,
  parsedSchedule: ParsedTaskSchedule,
  prompt: string,
): ScheduledTask {
  const baseTask = {
    id: randomUUID(),
    projectId,
    projectWorktree,
    model,
    scheduleText,
    scheduleSummary: parsedSchedule.summary,
    timezone: parsedSchedule.timezone,
    prompt,
    createdAt: new Date().toISOString(),
    nextRunAt: parsedSchedule.nextRunAt,
    lastRunAt: null,
    runCount: 0,
    lastStatus: "idle" as const,
    lastError: null,
  };

  if (parsedSchedule.kind === "cron") {
    return {
      ...baseTask,
      kind: "cron",
      cron: parsedSchedule.cron,
    };
  }

  return {
    ...baseTask,
    kind: "once",
    runAt: parsedSchedule.runAt,
  };
}

function assertTaskLimitAvailable(): void {
  if (listScheduledTasks().length >= config.bot.taskLimit) {
    throw new Error(t("task.limit_reached", { limit: String(config.bot.taskLimit) }));
  }
}

export async function createScheduledTaskFromText({
  scheduleText,
  prompt,
}: CreateScheduledTaskInput): Promise<ScheduledTask> {
  const currentProject = getCurrentProject();
  if (!currentProject) {
    throw new Error(t("bot.project_not_selected"));
  }

  const normalizedScheduleText = scheduleText.trim();
  if (!normalizedScheduleText) {
    throw new Error("Schedule text is empty");
  }

  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("Scheduled task prompt is empty");
  }

  assertTaskLimitAvailable();

  const parsedSchedule = await parseTaskSchedule(normalizedScheduleText, currentProject.worktree);
  validateParsedSchedule(parsedSchedule);

  const task = buildScheduledTask(
    currentProject.id,
    currentProject.worktree,
    createScheduledTaskModel(getStoredModel()),
    normalizedScheduleText,
    parsedSchedule,
    normalizedPrompt,
  );

  await addScheduledTask(task);
  scheduledTaskRuntime.registerTask(task);
  return task;
}

export async function deleteScheduledTask(taskId: string): Promise<boolean> {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    throw new Error("Scheduled task id is empty");
  }

  const removed = await removeScheduledTask(normalizedTaskId);
  if (removed) {
    scheduledTaskRuntime.removeTask(normalizedTaskId);
  }

  return removed;
}
