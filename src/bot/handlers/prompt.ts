import { Bot, Context } from "grammy";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "../../opencode/client.js";
import { classifyPromptSubmitError } from "../../opencode/prompt-submit-error.js";
import { clearSession, getCurrentSession, setCurrentSession } from "../../session/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import { getCurrentProject, isTtsEnabled } from "../../settings/manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../agent/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { createMainKeyboard } from "../utils/keyboard.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { stopEventListening } from "../../opencode/events.js";
import { interactionManager } from "../../interaction/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { foregroundSessionState } from "../../scheduled-task/foreground-state.js";
import { assistantRunState } from "../assistant-run-state.js";
import {
  attachToSession,
  detachAttachedSession,
  markAttachedSessionBusy,
  markAttachedSessionIdle,
} from "../../attach/service.js";
import { externalUserInputSuppressionManager } from "../../external-input/suppression.js";
import { setWrapperToolTelegramContext } from "../../wrapper-tools/server.js";
import {
  getOptionalThreadSendOptions,
  getScopeFromContext,
  getThreadSendOptions,
  isTopicScope,
} from "../scope.js";
import { getTopicBindingByScopeKey, registerTopicSessionBinding } from "../../topic/manager.js";
import { formatTopicTitle } from "../../topic/title-format.js";
import { getScheduledTaskTopicByChatAndThread } from "../../scheduled-task/store.js";

/** Module-level references for async callbacks that don't have ctx. */
let botInstance: Bot<Context> | null = null;
let chatIdInstance: number | null = null;
const promptResponseModes = new Map<string, PromptResponseMode>();
const queuedPromptRequests = new Map<string, QueuedPromptRequest[]>();
const drainingQueuedSessions = new Set<string>();

export type PromptResponseMode = "text_only" | "text_and_tts";

type ProcessPromptOptions = {
  responseMode?: PromptResponseMode;
};

type PromptRequestOptions = {
  sessionID: string;
  directory: string;
  parts: Array<TextPartInput | FilePartInput>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
};

type PromptErrorLogContext = {
  sessionId: string;
  directory: string;
  agent: string;
  modelProvider: string;
  modelId: string;
  variant: string;
  promptLength: number;
  fileCount: number;
};

interface QueuedPromptRequest {
  sessionId: string;
  chatId: number;
  threadId: number | null;
  responseMode: PromptResponseMode;
  promptOptions: PromptRequestOptions;
  promptErrorLogContext: PromptErrorLogContext;
  notifyOnQueue: boolean;
}

const QUEUED_PROMPT_PREVIEW_MAX_LENGTH = 280;

export function getPromptBotInstance(): Bot<Context> | null {
  return botInstance;
}

export function getPromptChatId(): number | null {
  return chatIdInstance;
}

export function setPromptResponseMode(sessionId: string, responseMode: PromptResponseMode): void {
  promptResponseModes.set(sessionId, responseMode);
}

export function clearPromptResponseMode(sessionId: string): void {
  promptResponseModes.delete(sessionId);
}

export function consumePromptResponseMode(sessionId: string): PromptResponseMode | null {
  const responseMode = promptResponseModes.get(sessionId) ?? null;
  promptResponseModes.delete(sessionId);
  return responseMode;
}

function getQueuedPromptCount(sessionId: string): number {
  return queuedPromptRequests.get(sessionId)?.length ?? 0;
}

function enqueuePromptRequest(request: QueuedPromptRequest): number {
  const queue = queuedPromptRequests.get(request.sessionId) ?? [];
  queue.push(request);
  queuedPromptRequests.set(request.sessionId, queue);
  return queue.length;
}

function takeNextQueuedPromptRequest(sessionId: string): QueuedPromptRequest | null {
  const queue = queuedPromptRequests.get(sessionId);
  if (!queue || queue.length === 0) {
    return null;
  }

  const nextRequest = queue.shift() ?? null;
  if (queue.length === 0) {
    queuedPromptRequests.delete(sessionId);
  } else {
    queuedPromptRequests.set(sessionId, queue);
  }

  return nextRequest;
}

function truncateQueuedPromptPreview(text: string): string {
  if (text.length <= QUEUED_PROMPT_PREVIEW_MAX_LENGTH) {
    return text;
  }

  return `${text.slice(0, QUEUED_PROMPT_PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
}

function getQueuedPromptPreview(request: QueuedPromptRequest): string {
  const textParts = request.promptOptions.parts
    .filter((part): part is TextPartInput => part.type === "text")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0);

  return truncateQueuedPromptPreview(textParts[0] ?? "See attached file");
}

async function sendPromptMessage(
  bot: Bot<Context>,
  chatId: number,
  text: string,
  threadId: number | null,
): Promise<void> {
  const threadOptions = getOptionalThreadSendOptions(threadId);
  if (threadOptions) {
    await bot.api.sendMessage(chatId, text, threadOptions);
    return;
  }

  await bot.api.sendMessage(chatId, text);
}

async function replyPromptMessage(
  ctx: Context,
  text: string,
  threadId: number | null,
): Promise<void> {
  const threadOptions = getOptionalThreadSendOptions(threadId);
  if (threadOptions) {
    await ctx.reply(text, threadOptions);
    return;
  }

  await ctx.reply(text);
}

async function sendQueuedPromptNotice(
  bot: Bot<Context>,
  chatId: number,
  threadId: number | null,
  position: number,
): Promise<void> {
  await sendPromptMessage(
    bot,
    chatId,
    t("bot.session_queued", { position: String(position) }),
    threadId,
  ).catch(() => {});
}

async function sendQueuedPromptStartedNotice(
  bot: Bot<Context>,
  request: QueuedPromptRequest,
): Promise<void> {
  await sendPromptMessage(
    bot,
    request.chatId,
    t("bot.session_queue_started", { preview: getQueuedPromptPreview(request) }),
    request.threadId,
  ).catch(() => {});
}

function buildPromptRequest(
  currentSession: { id: string; directory: string },
  currentAgent: string | null,
  storedModel: { providerID?: string | null; modelID?: string | null; variant?: string | null },
  text: string,
  fileParts: FilePartInput[],
): { promptOptions: PromptRequestOptions; promptErrorLogContext: PromptErrorLogContext } {
  const parts: Array<TextPartInput | FilePartInput> = [];

  if (text.trim().length > 0) {
    parts.push({ type: "text", text });
  }

  parts.push(...fileParts);

  if (parts.length === 0 || parts.every((part) => part.type === "file")) {
    if (fileParts.length > 0) {
      parts.unshift({ type: "text", text: "See attached file" });
    }
  }

  const promptOptions: PromptRequestOptions = {
    sessionID: currentSession.id,
    directory: currentSession.directory,
    parts,
    agent: currentAgent ?? undefined,
  };

  if (storedModel.providerID && storedModel.modelID) {
    promptOptions.model = {
      providerID: storedModel.providerID,
      modelID: storedModel.modelID,
    };

    if (storedModel.variant) {
      promptOptions.variant = storedModel.variant;
    }
  }

  return {
    promptOptions,
    promptErrorLogContext: {
      sessionId: currentSession.id,
      directory: currentSession.directory,
      agent: currentAgent || "default",
      modelProvider: storedModel.providerID || "default",
      modelId: storedModel.modelID || "default",
      variant: storedModel.variant || "default",
      promptLength: text.length,
      fileCount: fileParts.length,
    },
  };
}

function handlePromptStartFailure(
  bot: Bot<Context>,
  request: QueuedPromptRequest,
  error: unknown,
  reason: string,
): void {
  const errorType = classifyPromptSubmitError(error);
  const details = formatErrorDetails(error, 6000);

  logger.error("[Bot] session.promptAsync start failed", request.promptErrorLogContext);
  logger.error("[Bot] session.promptAsync failure details:", details);
  logger.error("[Bot] session.promptAsync raw failure object:", error);

  clearPromptResponseMode(request.sessionId);
  assistantRunState.clearRun(request.sessionId, reason);

  if (errorType === "busy") {
    const position = enqueuePromptRequest({ ...request, notifyOnQueue: false });
    if (request.notifyOnQueue) {
      void sendQueuedPromptNotice(bot, request.chatId, request.threadId, position);
    }
    return;
  }

  foregroundSessionState.markIdle(request.sessionId);
  void markAttachedSessionIdle(request.sessionId);

  const errorMessageKey =
    errorType === "session_not_found"
      ? "bot.prompt_send_error_session_not_found"
      : "bot.prompt_send_error";
  void sendPromptMessage(bot, request.chatId, t(errorMessageKey), request.threadId).catch(() => {});
}

async function submitPromptRequest(
  bot: Bot<Context>,
  request: QueuedPromptRequest,
  suppressionText?: string,
): Promise<void> {
  foregroundSessionState.markBusy(request.sessionId, request.promptOptions.directory);
  await markAttachedSessionBusy(request.sessionId);
  assistantRunState.startRun(request.sessionId, {
    startedAt: Date.now(),
    configuredAgent: request.promptOptions.agent,
    configuredProviderID: request.promptOptions.model?.providerID,
    configuredModelID: request.promptOptions.model?.modelID,
  });
  setPromptResponseMode(request.sessionId, request.responseMode);

  if (suppressionText?.trim()) {
    externalUserInputSuppressionManager.register(request.sessionId, suppressionText);
  }

  logger.info(
    `[Bot] Calling session.promptAsync (start-only) with agent=${request.promptOptions.agent}, fileCount=${request.promptErrorLogContext.fileCount}...`,
  );

  safeBackgroundTask({
    taskName: "session.promptAsync",
    task: () => opencodeClient.session.promptAsync(request.promptOptions),
    onSuccess: ({ error }) => {
      if (error) {
        handlePromptStartFailure(bot, request, error, "session_prompt_api_error");
        return;
      }

      logger.info("[Bot] session.promptAsync accepted");
    },
    onError: (error) => {
      handlePromptStartFailure(bot, request, error, "session_prompt_background_error");
    },
  });
}

export async function dispatchNextQueuedPrompt(sessionId: string): Promise<boolean> {
  if (!botInstance || drainingQueuedSessions.has(sessionId) || getQueuedPromptCount(sessionId) === 0) {
    return false;
  }

  const nextRequest = takeNextQueuedPromptRequest(sessionId);
  if (!nextRequest) {
    return false;
  }

  drainingQueuedSessions.add(sessionId);
  try {
    const sessionBusy = await isSessionBusy(sessionId, nextRequest.promptOptions.directory);
    if (sessionBusy) {
      enqueuePromptRequest(nextRequest);
      return false;
    }

    await sendQueuedPromptStartedNotice(botInstance, nextRequest);
    await submitPromptRequest(botInstance, { ...nextRequest, notifyOnQueue: false });
    return true;
  } finally {
    drainingQueuedSessions.delete(sessionId);
  }
}

export function __resetQueuedPromptsForTests(): void {
  queuedPromptRequests.clear();
  drainingQueuedSessions.clear();
  promptResponseModes.clear();
}

async function isSessionBusy(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory });

    if (error || !data) {
      logger.warn("[Bot] Failed to check session status before prompt:", error);
      return false;
    }

    const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
    if (!sessionStatus) {
      return false;
    }

    logger.debug(`[Bot] Current session status before prompt: ${sessionStatus.type || "unknown"}`);
    return sessionStatus.type === "busy";
  } catch (err) {
    logger.warn("[Bot] Error checking session status before prompt:", err);
    return false;
  }
}

async function resetMismatchedSessionContext(scopeKey?: string): Promise<void> {
  detachAttachedSession("session_mismatch_reset");
  stopEventListening();
  summaryAggregator.clear();
  foregroundSessionState.clearAll("session_mismatch_reset");
  assistantRunState.clearAll("session_mismatch_reset");
  clearAllInteractionState("session_mismatch_reset", scopeKey);
  clearSession(scopeKey);
  keyboardManager.clearContext(scopeKey);

  if (!pinnedMessageManager.isInitialized(scopeKey)) {
    return;
  }

  try {
    await pinnedMessageManager.clear(scopeKey);
  } catch (err) {
    logger.error("[Bot] Failed to clear pinned message during session reset:", err);
  }
}

export interface ProcessPromptDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

/**
 * Processes a user prompt: ensures project/session, subscribes to events, and sends
 * the prompt to OpenCode. Used by text, voice, and photo message handlers.
 *
 * @param ctx - Grammy context
 * @param text - Text content of the prompt
 * @param deps - Dependencies (bot and event subscription)
 * @param fileParts - Optional file parts (for photo/document attachments)
 * @returns true if the prompt was dispatched, false if it was blocked/failed early.
 */
export async function processUserPrompt(
  ctx: Context,
  text: string,
  deps: ProcessPromptDeps,
  fileParts: FilePartInput[] = [],
  options: ProcessPromptOptions = {},
): Promise<boolean> {
  const { bot, ensureEventSubscription } = deps;
  const scope = getScopeFromContext(ctx);
  const scopeKey = scope?.key;
  const responseMode = options.responseMode ?? (isTtsEnabled(scopeKey) ? "text_and_tts" : "text_only");

  if (scope && isTopicScope(scope) && ctx.chat && typeof scope.threadId === "number") {
    const scheduledTopic = await getScheduledTaskTopicByChatAndThread(ctx.chat.id, scope.threadId);
    if (scheduledTopic) {
      await ctx.reply(t("task.output_topic_blocked"), getThreadSendOptions(scope.threadId));
      return false;
    }

    if (!getTopicBindingByScopeKey(scope.key)) {
      await ctx.reply(t("topic.unbound"), getThreadSendOptions(scope.threadId));
      return false;
    }
  }

  const currentProject = getCurrentProject(scopeKey);
  if (!currentProject) {
    await ctx.reply(t("bot.project_not_selected"));
    return false;
  }

  botInstance = bot;
  chatIdInstance = ctx.chat!.id;

  let currentSession = getCurrentSession(scopeKey);
  let createdNewSession = false;

  if (currentSession && currentSession.directory !== currentProject.worktree) {
    logger.warn(
      `[Bot] Session/project mismatch detected. sessionDirectory=${currentSession.directory}, projectDirectory=${currentProject.worktree}. Resetting session context.`,
    );
    await resetMismatchedSessionContext(scopeKey);
    await ctx.reply(t("bot.session_reset_project_mismatch"));
    return false;
  }

  if (!currentSession) {
    await ctx.reply(t("bot.creating_session"));

    const { data: session, error } = await opencodeClient.session.create({
      directory: currentProject.worktree,
    });

    if (error || !session) {
      await ctx.reply(t("bot.create_session_error"));
      return false;
    }

    logger.info(
      `[Bot] Created new session: id=${session.id}, title="${session.title}", project=${currentProject.worktree}`,
    );

    currentSession = {
      id: session.id,
      title: session.title,
      directory: currentProject.worktree,
    };

    setCurrentSession(currentSession, scopeKey);
    await ingestSessionInfoForCache(session);
    createdNewSession = true;
  } else {
    logger.info(
      `[Bot] Using existing session: id=${currentSession.id}, title="${currentSession.title}"`,
    );
  }

  const attachDeps = {
    bot,
    chatId: ctx.chat!.id,
    session: currentSession,
    ensureEventSubscription,
    ...(scopeKey ? { scopeKey } : {}),
    ...(scope?.threadId ? { threadId: scope.threadId } : {}),
  };
  await attachToSession(attachDeps);
  setWrapperToolTelegramContext({ bot, chatId: ctx.chat!.id, sessionId: currentSession.id });

  if (scope && isTopicScope(scope)) {
    registerTopicSessionBinding({
      scopeKey: scope.key,
      chatId: scope.chatId,
      threadId: scope.threadId!,
      sessionId: currentSession.id,
      projectId: currentProject.id,
      projectWorktree: currentProject.worktree,
      topicName: formatTopicTitle(currentSession.title),
    });
  }

  if (createdNewSession) {
    const currentAgent = await resolveProjectAgent(getStoredAgent(scopeKey), scopeKey);
    const currentModel = getStoredModel(scopeKey);
    keyboardManager.updateAgent(currentAgent, scopeKey);
    const contextInfo = keyboardManager.getContextInfo(scopeKey);
    const variantName = formatVariantForButton(currentModel.variant || "default");
    const keyboard = createMainKeyboard(
      currentAgent,
      currentModel,
      contextInfo ?? undefined,
      variantName,
    );

    await ctx.reply(t("bot.session_created", { title: currentSession.title }), {
      reply_markup: keyboard,
      ...getThreadSendOptions(scope?.threadId ?? null),
    });
  }

  const sessionIsBusy = await isSessionBusy(currentSession.id, currentSession.directory);
  if (sessionIsBusy) {
    const currentAgent = await resolveProjectAgent(getStoredAgent(scopeKey), scopeKey);
    const storedModel = getStoredModel(scopeKey);
    const request = buildPromptRequest(currentSession, currentAgent, storedModel, text, fileParts);
    const position = enqueuePromptRequest({
      sessionId: currentSession.id,
      chatId: ctx.chat!.id,
      threadId: scope?.threadId ?? null,
      responseMode,
      promptOptions: request.promptOptions,
      promptErrorLogContext: request.promptErrorLogContext,
      notifyOnQueue: true,
    });

    logger.info(
      `[Bot] Queued prompt for busy session ${currentSession.id} at position ${position}`,
    );
    await replyPromptMessage(
      ctx,
      t("bot.session_queued", { position: String(position) }),
      scope?.threadId ?? null,
    );
    return true;
  }

  try {
    const currentAgent = await resolveProjectAgent(getStoredAgent(scopeKey), scopeKey);
    const storedModel = getStoredModel(scopeKey);
    const request = buildPromptRequest(currentSession, currentAgent, storedModel, text, fileParts);

    // CRITICAL: Use the async prompt start endpoint here. The actual assistant result
    // arrives via the SSE event subscription.
    await submitPromptRequest(bot, {
      sessionId: currentSession.id,
      chatId: ctx.chat!.id,
      threadId: scope?.threadId ?? null,
      responseMode,
      promptOptions: request.promptOptions,
      promptErrorLogContext: request.promptErrorLogContext,
      notifyOnQueue: true,
    }, text);

    return true;
  } catch (err) {
    if (currentSession) {
      foregroundSessionState.markIdle(currentSession.id);
      await markAttachedSessionIdle(currentSession.id);
      assistantRunState.clearRun(currentSession.id, "session_prompt_handler_error");
    }
    logger.error("Error in prompt handler:", err);
    if (interactionManager.getSnapshot()) {
      clearAllInteractionState("message_handler_error");
    }
    await ctx.reply(t("error.generic"));
    return false;
  }
}
