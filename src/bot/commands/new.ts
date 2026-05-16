import type { Bot } from "grammy";
import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { setCurrentSession, SessionInfo } from "../../session/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import {
  TOPIC_SESSION_STATUS,
  getCurrentProject,
  setCurrentAgent,
  setCurrentModel,
  setCurrentProject,
} from "../../settings/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../agent/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { createMainKeyboard } from "../utils/keyboard.js";
import { isForegroundBusy, replyBusyBlocked } from "../utils/busy-guard.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { attachToSession } from "../../attach/service.js";
import {
  GENERAL_TOPIC_THREAD_ID,
  SCOPE_CONTEXT,
  createScopeKeyFromParams,
  getScopeFromContext,
  getThreadSendOptions,
  isTopicScope,
} from "../scope.js";
import { registerTopicSessionBinding } from "../../topic/manager.js";
import { formatTopicTitle } from "../../topic/title-format.js";
import { CHAT_TYPE, TELEGRAM_CHAT_FIELD, TELEGRAM_ERROR_MARKER } from "../constants.js";
import { TOPIC_COLORS } from "../../topic/colors.js";
import { buildTopicMessageLink } from "../utils/topic-link.js";

export interface NewCommandDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

function isGeneralForumScope(ctx: CommandContext<Context>): boolean {
  const scope = getScopeFromContext(ctx);
  const isForumEnabled =
    ctx.chat?.type === CHAT_TYPE.SUPERGROUP &&
    Reflect.get(ctx.chat, TELEGRAM_CHAT_FIELD.IS_FORUM) === true;

  return Boolean(
    isForumEnabled &&
      scope?.context === SCOPE_CONTEXT.GROUP_GENERAL &&
      (scope.threadId === null || scope.threadId === GENERAL_TOPIC_THREAD_ID),
  );
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }

  const description =
    typeof error === "object" && error !== null ? Reflect.get(error, "description") : null;
  return typeof description === "string" ? description.toLowerCase() : String(error).toLowerCase();
}

export async function newCommand(ctx: CommandContext<Context>, deps: NewCommandDeps) {
  try {
    if (isForegroundBusy()) {
      await replyBusyBlocked(ctx);
      return;
    }

    const scope = getScopeFromContext(ctx);
    const scopeKey = scope?.key;
    const currentProject = getCurrentProject(scopeKey);

    if (!currentProject) {
      await ctx.reply(t("new.project_not_selected"));
      return;
    }

    if (isTopicScope(scope)) {
      await ctx.reply(t("new.topic_only_in_general"), getThreadSendOptions(scope?.threadId ?? null));
      return;
    }

    logger.debug("[Bot] Creating new session for directory:", currentProject.worktree);

    const { data: session, error } = await opencodeClient.session.create({
      directory: currentProject.worktree,
    });

    if (error || !session) {
      throw error || new Error("No data received from server");
    }

    logger.info(
      `[Bot] Created new session via /new command: id=${session.id}, title="${session.title}", project=${currentProject.worktree}`,
    );

    const sessionInfo: SessionInfo = {
      id: session.id,
      title: session.title,
      directory: currentProject.worktree,
    };

    if (isGeneralForumScope(ctx)) {
      const topicTitle = formatTopicTitle(session.title, session.title);
      const createdTopic = await (async () => {
        try {
          return await ctx.api.createForumTopic(ctx.chat!.id, topicTitle, {
            icon_color: TOPIC_COLORS.BLUE,
          });
        } catch (error) {
          logger.error("[Bot] Error creating forum topic for new session", error);
          const errorText = getErrorText(error);
          if (errorText.includes(TELEGRAM_ERROR_MARKER.NOT_ENOUGH_RIGHTS_CREATE_TOPIC)) {
            await ctx.reply(t("new.topic_create_no_rights"), getThreadSendOptions(scope?.threadId ?? null));
            return null;
          }

          await ctx.reply(t("new.topic_create_error"), getThreadSendOptions(scope?.threadId ?? null));
          return null;
        }
      })();

      if (!createdTopic) {
        return;
      }

      const topicThreadId = createdTopic.message_thread_id;
      const topicScopeKey = createScopeKeyFromParams({
        chatId: ctx.chat!.id,
        threadId: topicThreadId,
        context: SCOPE_CONTEXT.GROUP_TOPIC,
      });

      setCurrentProject(currentProject, topicScopeKey);
      setCurrentSession(sessionInfo, topicScopeKey);
      setCurrentAgent(await resolveProjectAgent(getStoredAgent(scopeKey), scopeKey), topicScopeKey);
      setCurrentModel(getStoredModel(scopeKey), topicScopeKey);

      registerTopicSessionBinding({
        scopeKey: topicScopeKey,
        chatId: ctx.chat!.id,
        threadId: topicThreadId,
        sessionId: sessionInfo.id,
        projectId: currentProject.id,
        projectWorktree: currentProject.worktree,
        topicName: topicTitle,
        status: TOPIC_SESSION_STATUS.ACTIVE,
      });
      clearAllInteractionState("session_created", topicScopeKey);
      await ingestSessionInfoForCache(session);

      await attachToSession({
        bot: deps.bot,
        chatId: ctx.chat!.id,
        threadId: topicThreadId,
        scopeKey: topicScopeKey,
        session: sessionInfo,
        ensureEventSubscription: deps.ensureEventSubscription,
      });

      const currentAgent = await resolveProjectAgent(getStoredAgent(topicScopeKey), topicScopeKey);
      const currentModel = getStoredModel(topicScopeKey);
      keyboardManager.updateAgent(currentAgent, topicScopeKey);
      const contextInfo = keyboardManager.getContextInfo(topicScopeKey);
      const variantName = formatVariantForButton(currentModel.variant || "default");
      const keyboard = createMainKeyboard(
        currentAgent,
        currentModel,
        contextInfo ?? undefined,
        variantName,
      );

      const topicReadyMessage = await ctx.api.sendMessage(
        ctx.chat!.id,
        t("new.topic_created", { title: session.title }),
        {
          reply_markup: keyboard,
          ...getThreadSendOptions(topicThreadId),
        },
      );

      const topicMessageLink = buildTopicMessageLink(ctx.chat, topicReadyMessage.message_id);
      const generalReplyText = topicMessageLink
        ? `${t("new.general_created")}\n${t("new.general_open_link", { url: topicMessageLink })}`
        : t("new.topic_create_error");

      await ctx.reply(generalReplyText, getThreadSendOptions(scope?.threadId ?? null));
      return;
    }

    setCurrentSession(sessionInfo, scopeKey);
    if (scope && isTopicScope(scope)) {
      registerTopicSessionBinding({
        scopeKey: scope.key,
        chatId: scope.chatId,
        threadId: scope.threadId!,
        sessionId: sessionInfo.id,
        projectId: currentProject.id,
        projectWorktree: currentProject.worktree,
        topicName: formatTopicTitle(sessionInfo.title),
      });
    }
    clearAllInteractionState("session_created", scopeKey);
    await ingestSessionInfoForCache(session);

    await attachToSession({
      bot: deps.bot,
      chatId: ctx.chat.id,
      session: sessionInfo,
      ensureEventSubscription: deps.ensureEventSubscription,
    });

    // Get current state for keyboard
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

    await ctx.reply(t("new.created", { title: session.title }), {
      reply_markup: keyboard,
      ...getThreadSendOptions(scope?.threadId ?? null),
    });
  } catch (error) {
    logger.error("[Bot] Error creating session:", error);
    await ctx.reply(t("new.create_error"));
  }
}
