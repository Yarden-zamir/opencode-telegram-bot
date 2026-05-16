import { randomUUID } from "node:crypto";
import { CommandContext, Context, InlineKeyboard } from "grammy";
import { config } from "../../config.js";
import { getDateLocale, t } from "../../i18n/index.js";
import { interactionManager } from "../../interaction/manager.js";
import type { InteractionState } from "../../interaction/types.js";
import { getStoredModel } from "../../model/manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { taskCreationManager } from "../../scheduled-task/creation-manager.js";
import { parseTaskSchedule } from "../../scheduled-task/schedule-parser.js";
import {
  addScheduledTask,
  getScheduledTaskTopicByChatAndProject,
  listScheduledTasks,
  upsertScheduledTaskTopic,
} from "../../scheduled-task/store.js";
import { scheduledTaskRuntime } from "../../scheduled-task/runtime.js";
import { SCHEDULED_TASK_OUTPUT_TOPIC_NAME } from "../../scheduled-task/topic-output.js";
import {
  createScheduledTaskModel,
  type ParsedTaskSchedule,
  type ScheduledTask,
  type ScheduledTaskDeliveryTarget,
  type TaskCreationState,
} from "../../scheduled-task/types.js";
import { logger } from "../../utils/logger.js";
import { getScopeKeyFromContext } from "../scope.js";

const TASK_RETRY_SCHEDULE_CALLBACK = "task:retry-schedule";
const TASK_CANCEL_CALLBACK = "task:cancel";
const TASK_PROMPT_PREVIEW_LENGTH = 100;
const TELEGRAM_TOPIC_ICON_BLUE = 0x6fb9f0;

interface TaskInteractionMetadata {
  flow: "task";
  stage: "awaiting_schedule" | "parsing_schedule" | "awaiting_prompt";
  projectId: string;
  projectWorktree: string;
  previewMessageId?: number;
}

function buildRetryScheduleKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("task.button.retry_schedule"), TASK_RETRY_SCHEDULE_CALLBACK)
    .text(t("task.button.cancel"), TASK_CANCEL_CALLBACK);
}

function buildCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(t("task.button.cancel"), TASK_CANCEL_CALLBACK);
}

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function clearTaskInteraction(reason: string, scopeKey?: string): void {
  const state = interactionManager.getSnapshot(scopeKey);
  if (state?.kind === "task") {
    interactionManager.clear(reason, scopeKey);
  }
}

function clearTaskFlow(reason: string, scopeKey?: string): void {
  taskCreationManager.clear(scopeKey);
  clearTaskInteraction(reason, scopeKey);
}

function isTaskLimitReached(): boolean {
  return listScheduledTasks().length >= config.bot.taskLimit;
}

function truncateTaskPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= TASK_PROMPT_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, TASK_PROMPT_PREVIEW_LENGTH - 3)}...`;
}

function formatScheduledDate(dateIso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(getDateLocale(), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(dateIso));
  } catch {
    return dateIso;
  }
}

function getTaskKindLabel(schedule: ParsedTaskSchedule): string {
  return schedule.kind === "cron" ? t("task.kind.cron") : t("task.kind.once");
}

function formatParsedScheduleMessage(schedule: ParsedTaskSchedule): string {
  const cronLine =
    schedule.kind === "cron" ? `${t("task.schedule_preview.cron", { cron: schedule.cron })}\n` : "";

  return t("task.schedule_preview", {
    summary: schedule.summary,
    cronLine,
    timezone: schedule.timezone,
    kind: getTaskKindLabel(schedule),
    nextRunAt: formatScheduledDate(schedule.nextRunAt, schedule.timezone),
  });
}

function formatParsedSchedulePromptMessage(schedule: ParsedTaskSchedule): string {
  return `${formatParsedScheduleMessage(schedule)}\n\n${t("task.prompt.body")}`;
}

function formatTaskCreatedMessage(task: ScheduledTask): string {
  const variant = task.model.variant ? ` (${task.model.variant})` : "";
  const model = `${task.model.providerID}/${task.model.modelID}${variant}`;
  const cronLine = task.kind === "cron" ? `${t("task.created.cron", { cron: task.cron })}\n` : "";

  return t("task.created", {
    description: truncateTaskPrompt(task.prompt),
    project: task.projectWorktree,
    model,
    schedule: task.scheduleSummary,
    cronLine,
    nextRunAt: task.nextRunAt ? formatScheduledDate(task.nextRunAt, task.timezone) : "-",
  });
}

function isForumGroupContext(ctx: Context): boolean {
  return ctx.chat?.type === "supergroup" && Reflect.get(ctx.chat, "is_forum") === true;
}

function buildTopicThreadLink(chat: NonNullable<Context["chat"]>, threadId: number): string | null {
  const username = Reflect.get(chat, "username");
  if (typeof username === "string" && username.trim()) {
    return `https://t.me/${username}/${threadId}`;
  }

  const chatId = chat.id;
  if (chatId >= 0) {
    return null;
  }

  const normalizedChatId = String(Math.abs(chatId)).replace(/^100/, "");
  return `https://t.me/c/${normalizedChatId}/${threadId}`;
}

async function resolveScheduledTaskDeliveryTarget(
  ctx: Context,
  project: { id: string; worktree: string },
): Promise<{ delivery: ScheduledTaskDeliveryTarget; createdTopicLink: string | null }> {
  if (!ctx.chat) {
    throw new Error("Missing chat context for scheduled task delivery");
  }

  if (!isForumGroupContext(ctx)) {
    return {
      delivery: {
        chatId: ctx.chat.id,
        threadId: null,
      },
      createdTopicLink: null,
    };
  }

  const existingTopic = await getScheduledTaskTopicByChatAndProject(ctx.chat.id, project.id);
  if (existingTopic) {
    return {
      delivery: {
        chatId: existingTopic.chatId,
        threadId: existingTopic.threadId,
      },
      createdTopicLink: null,
    };
  }

  const createdTopic = await ctx.api.createForumTopic(ctx.chat.id, SCHEDULED_TASK_OUTPUT_TOPIC_NAME, {
    icon_color: TELEGRAM_TOPIC_ICON_BLUE,
  });
  const timestamp = new Date().toISOString();

  await upsertScheduledTaskTopic({
    chatId: ctx.chat.id,
    projectId: project.id,
    projectWorktree: project.worktree,
    threadId: createdTopic.message_thread_id,
    topicName: SCHEDULED_TASK_OUTPUT_TOPIC_NAME,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    delivery: {
      chatId: ctx.chat.id,
      threadId: createdTopic.message_thread_id,
    },
    createdTopicLink: buildTopicThreadLink(ctx.chat, createdTopic.message_thread_id),
  };
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
    return baseValues.filter((value, index) => {
      if (baseValues.length === 0) {
        return false;
      }

      return index % step === 0;
    });
  }

  return expandCronMinuteBase(rawBase);
}

function expandCronMinuteBase(base: string): number[] {
  if (base === "*") {
    return Array.from({ length: 60 }, (_, index) => index);
  }

  if (base.includes("-")) {
    const [rawStart, rawEnd] = base.split("-");
    const start = parseCronMinuteNumber(rawStart);
    const end = parseCronMinuteNumber(rawEnd);
    if (start > end) {
      throw new Error("Invalid cron minute range returned by parser");
    }

    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
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

function buildTaskInteractionMetadata(
  stage: TaskInteractionMetadata["stage"],
  projectId: string,
  projectWorktree: string,
  previewMessageId?: number,
): Record<string, unknown> {
  return {
    flow: "task",
    stage,
    projectId,
    projectWorktree,
    previewMessageId,
  };
}

function isTaskInteraction(state: InteractionState | null): boolean {
  return state?.kind === "task";
}

function isTaskCallbackActive(flowState: TaskCreationState, messageId: number): boolean {
  return [
    flowState.scheduleRequestMessageId,
    flowState.previewMessageId,
    flowState.promptRequestMessageId,
  ].includes(messageId);
}

async function deleteMessageIfPresent(
  ctx: Context,
  messageId: number | null | undefined,
): Promise<void> {
  if (!ctx.chat || typeof messageId !== "number") {
    return;
  }

  await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {});
}

function buildScheduledTask(
  projectId: string,
  projectWorktree: string,
  delivery: ScheduledTaskDeliveryTarget,
  model: ScheduledTask["model"],
  scheduleText: string,
  parsedSchedule: ParsedTaskSchedule,
  prompt: string,
): ScheduledTask {
  const baseTask = {
    id: randomUUID(),
    projectId,
    projectWorktree,
    delivery,
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

export async function taskCommand(ctx: CommandContext<Context>): Promise<void> {
  const scopeKey = getScopeKeyFromContext(ctx);
  const currentProject = getCurrentProject(scopeKey);
  if (!currentProject) {
    await ctx.reply(t("bot.project_not_selected"));
    return;
  }

  if (isTaskLimitReached()) {
    await ctx.reply(t("task.limit_reached", { limit: String(config.bot.taskLimit) }));
    return;
  }

  const currentModel = createScheduledTaskModel(getStoredModel(scopeKey));

  taskCreationManager.start(currentProject.id, currentProject.worktree, currentModel, scopeKey);
  interactionManager.start({
    kind: "task",
    expectedInput: "text",
    metadata: buildTaskInteractionMetadata(
      "awaiting_schedule",
      currentProject.id,
      currentProject.worktree,
    ),
  }, scopeKey);

  const message = await ctx.reply(t("task.prompt.schedule"), {
    reply_markup: buildCancelKeyboard(),
  });
  taskCreationManager.setScheduleRequestMessageId(message.message_id, scopeKey);
}

export async function handleTaskCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (data !== TASK_RETRY_SCHEDULE_CALLBACK && data !== TASK_CANCEL_CALLBACK) {
    return false;
  }

  const scopeKey = getScopeKeyFromContext(ctx);
  const flowState = taskCreationManager.getState(scopeKey);
  const interactionState = interactionManager.getSnapshot(scopeKey);
  const callbackMessageId = getCallbackMessageId(ctx);

  if (
    !flowState ||
    !isTaskInteraction(interactionState) ||
    callbackMessageId === null ||
    !isTaskCallbackActive(flowState, callbackMessageId)
  ) {
    if (!flowState && isTaskInteraction(interactionState)) {
      clearTaskInteraction("task_retry_inactive_state", scopeKey);
    }

    await ctx.answerCallbackQuery({ text: t("task.inactive_callback"), show_alert: true });
    return true;
  }

  if (data === TASK_CANCEL_CALLBACK) {
    await ctx.answerCallbackQuery({ text: t("task.cancel_callback") });
    await deleteMessageIfPresent(ctx, flowState.scheduleRequestMessageId);
    await deleteMessageIfPresent(ctx, flowState.previewMessageId);
    await deleteMessageIfPresent(ctx, flowState.promptRequestMessageId);
    clearTaskFlow("task_cancelled", scopeKey);
    await ctx.reply(t("task.cancelled"));
    return true;
  }

  if (
    !taskCreationManager.isWaitingForPrompt(scopeKey) ||
    callbackMessageId !== flowState.previewMessageId
  ) {
    await ctx.answerCallbackQuery({ text: t("task.inactive_callback"), show_alert: true });
    return true;
  }

  taskCreationManager.resetSchedule(scopeKey);
  interactionManager.transition({
    kind: "task",
    expectedInput: "text",
    metadata: buildTaskInteractionMetadata(
      "awaiting_schedule",
      flowState.projectId,
      flowState.projectWorktree,
    ),
  }, scopeKey);

  await ctx.answerCallbackQuery({ text: t("task.retry_schedule_callback") });
  await deleteMessageIfPresent(ctx, flowState.promptRequestMessageId);
  await deleteMessageIfPresent(ctx, flowState.previewMessageId);
  const message = await ctx.reply(t("task.prompt.schedule"), {
    reply_markup: buildCancelKeyboard(),
  });
  taskCreationManager.setScheduleRequestMessageId(message.message_id, scopeKey);

  return true;
}

export async function handleTaskTextInput(ctx: Context): Promise<boolean> {
  const scopeKey = getScopeKeyFromContext(ctx);
  const text = ctx.message?.text;
  if (!text || text.startsWith("/")) {
    return false;
  }

  if (!taskCreationManager.isActive(scopeKey)) {
    return false;
  }

  const interactionState = interactionManager.getSnapshot(scopeKey);
  if (!isTaskInteraction(interactionState)) {
    taskCreationManager.clear(scopeKey);
    await ctx.reply(t("task.inactive"));
    return true;
  }

  const flowState = taskCreationManager.getState(scopeKey);
  if (!flowState) {
    clearTaskFlow("task_state_missing", scopeKey);
    await ctx.reply(t("task.inactive"));
    return true;
  }

  if (taskCreationManager.isParsingSchedule(scopeKey)) {
    await ctx.reply(t("task.parse.in_progress"));
    return true;
  }

  if (taskCreationManager.isWaitingForSchedule(scopeKey)) {
    const scheduleText = text.trim();
    if (!scheduleText) {
      await ctx.reply(t("task.schedule_empty"));
      return true;
    }

    taskCreationManager.markScheduleParsing(scopeKey);
    interactionManager.transition({
      kind: "task",
      expectedInput: "text",
      metadata: buildTaskInteractionMetadata(
        "parsing_schedule",
        flowState.projectId,
        flowState.projectWorktree,
      ),
    }, scopeKey);

    const parsingMessage = await ctx.reply(t("task.parse.in_progress"));

    try {
      const parsedSchedule = await parseTaskSchedule(scheduleText, flowState.projectWorktree);
      validateParsedSchedule(parsedSchedule);
      await deleteMessageIfPresent(ctx, parsingMessage.message_id);
      await deleteMessageIfPresent(ctx, flowState.scheduleRequestMessageId);

      const previewMessage = await ctx.reply(formatParsedSchedulePromptMessage(parsedSchedule), {
        reply_markup: buildRetryScheduleKeyboard(),
      });

      taskCreationManager.setParsedSchedule(
        scheduleText,
        parsedSchedule,
        previewMessage.message_id,
        scopeKey,
      );
      interactionManager.transition({
        kind: "task",
        expectedInput: "mixed",
        metadata: buildTaskInteractionMetadata(
          "awaiting_prompt",
          flowState.projectId,
          flowState.projectWorktree,
          previewMessage.message_id,
        ),
      }, scopeKey);
      taskCreationManager.setPromptRequestMessageId(previewMessage.message_id, scopeKey);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("common.unknown_error");
      logger.warn(`[TaskCommand] Failed to parse task schedule: ${errorMessage}`);
      await deleteMessageIfPresent(ctx, flowState.scheduleRequestMessageId);
      taskCreationManager.resetSchedule(scopeKey);
      interactionManager.transition({
        kind: "task",
        expectedInput: "text",
        metadata: buildTaskInteractionMetadata(
          "awaiting_schedule",
          flowState.projectId,
          flowState.projectWorktree,
        ),
      }, scopeKey);
      await deleteMessageIfPresent(ctx, parsingMessage.message_id);
      const errorReply = await ctx.reply(t("task.parse_error", { message: errorMessage }), {
        reply_markup: buildCancelKeyboard(),
      });
      taskCreationManager.setScheduleRequestMessageId(errorReply.message_id, scopeKey);
    }

    return true;
  }

  if (!taskCreationManager.isWaitingForPrompt(scopeKey)) {
    return false;
  }

  const prompt = text.trim();
  if (!prompt) {
    await ctx.reply(t("task.prompt_empty"));
    return true;
  }

  if (!flowState.parsedSchedule || !flowState.scheduleText) {
    clearTaskFlow("task_missing_schedule_before_save", scopeKey);
    await ctx.reply(t("task.inactive"));
    return true;
  }

  try {
    if (isTaskLimitReached()) {
      await deleteMessageIfPresent(ctx, flowState.previewMessageId);
      await deleteMessageIfPresent(ctx, flowState.promptRequestMessageId);
      clearTaskFlow("task_limit_reached_before_save", scopeKey);
      await ctx.reply(t("task.limit_reached", { limit: String(config.bot.taskLimit) }));
      return true;
    }

    const { delivery, createdTopicLink } = await resolveScheduledTaskDeliveryTarget(ctx, {
      id: flowState.projectId,
      worktree: flowState.projectWorktree,
    });
    const task = buildScheduledTask(
      flowState.projectId,
      flowState.projectWorktree,
      delivery,
      flowState.model,
      flowState.scheduleText,
      flowState.parsedSchedule,
      prompt,
    );

    await addScheduledTask(task);
    scheduledTaskRuntime.registerTask(task);
    await deleteMessageIfPresent(ctx, flowState.previewMessageId);
    await deleteMessageIfPresent(ctx, flowState.promptRequestMessageId);
    clearTaskFlow("task_completed", scopeKey);
    const topicLinkText = createdTopicLink ? `\n\n${t("task.created_topic_link", { url: createdTopicLink })}` : "";
    await ctx.reply(`${formatTaskCreatedMessage(task)}${topicLinkText}`);
  } catch (error) {
    logger.error("[TaskCommand] Failed to save scheduled task", error);
    await ctx.reply(t("error.generic"));
  }

  return true;
}
