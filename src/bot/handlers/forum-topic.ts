import type { Bot, Context } from "grammy";
import { getStoredAgent, resolveProjectAgent } from "../../agent/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { opencodeClient } from "../../opencode/client.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import type { SessionInfo } from "../../session/manager.js";
import { clearSession, setCurrentSession } from "../../session/manager.js";
import {
  TOPIC_SESSION_STATUS,
  getCurrentProject,
  setCurrentAgent,
  setCurrentModel,
  setCurrentProject,
  type ProjectInfo,
} from "../../settings/manager.js";
import {
  getTopicBindingByScopeKey,
  registerTopicSessionBinding,
  updateTopicBindingStatus,
} from "../../topic/manager.js";
import { formatTopicTitle } from "../../topic/title-format.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { attachToSession } from "../../attach/service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { CHAT_TYPE, TELEGRAM_CHAT_FIELD } from "../constants.js";
import {
  GENERAL_TOPIC_THREAD_ID,
  SCOPE_CONTEXT,
  createScopeKeyFromParams,
  getScopeFromContext,
  getThreadSendOptions,
  isTopicScope,
} from "../scope.js";
import { createMainKeyboard } from "../utils/keyboard.js";

export interface ForumTopicCreatedDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

export interface ForumTopicClosedDeps {
  bot: Bot<Context>;
}

interface ProjectContext {
  project: ProjectInfo;
  scopeKey?: string;
}

function getCreatedTopicName(ctx: Context): string | null {
  const createdTopic = ctx.message?.forum_topic_created;
  const name = createdTopic ? Reflect.get(createdTopic, "name") : null;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function getGeneralProjectContext(chatId: number): ProjectContext | null {
  const scopeKeys = [
    createScopeKeyFromParams({
      chatId,
      threadId: GENERAL_TOPIC_THREAD_ID,
      context: SCOPE_CONTEXT.GROUP_GENERAL,
    }),
    createScopeKeyFromParams({ chatId, context: SCOPE_CONTEXT.GROUP_GENERAL }),
  ];

  for (const scopeKey of scopeKeys) {
    const project = getCurrentProject(scopeKey);
    if (project) {
      return { project, scopeKey };
    }
  }

  return null;
}

export async function handleForumTopicCreated(
  ctx: Context,
  deps: ForumTopicCreatedDeps,
): Promise<boolean> {
  if (ctx.from?.is_bot === true) {
    return false;
  }

  if (
    !ctx.chat ||
    ctx.chat.type !== CHAT_TYPE.SUPERGROUP ||
    Reflect.get(ctx.chat, TELEGRAM_CHAT_FIELD.IS_FORUM) !== true
  ) {
    return false;
  }

  const scope = getScopeFromContext(ctx);
  if (!scope || !isTopicScope(scope) || scope.threadId === null) {
    return false;
  }

  if (getTopicBindingByScopeKey(scope.key)) {
    return true;
  }

  const projectContext = getGeneralProjectContext(ctx.chat.id);
  if (!projectContext) {
    await ctx.reply(t("new.project_not_selected"), getThreadSendOptions(scope.threadId));
    return true;
  }

  const { project, scopeKey: sourceScopeKey } = projectContext;
  const topicTitle = formatTopicTitle(getCreatedTopicName(ctx) ?? "", "Session");

  try {
    const { data: session, error } = await opencodeClient.session.create({
      directory: project.worktree,
    });

    if (error || !session) {
      throw error || new Error("No data received from server");
    }

    const sessionInfo: SessionInfo = {
      id: session.id,
      title: session.title,
      directory: project.worktree,
    };

    setCurrentProject(project, scope.key);
    setCurrentSession(sessionInfo, scope.key);
    setCurrentAgent(await resolveProjectAgent(getStoredAgent(sourceScopeKey), sourceScopeKey), scope.key);
    setCurrentModel(getStoredModel(sourceScopeKey), scope.key);
    registerTopicSessionBinding({
      scopeKey: scope.key,
      chatId: scope.chatId,
      threadId: scope.threadId,
      sessionId: sessionInfo.id,
      projectId: project.id,
      projectWorktree: project.worktree,
      topicName: topicTitle,
      status: TOPIC_SESSION_STATUS.ACTIVE,
    });
    clearAllInteractionState("manual_topic_session_created", scope.key);
    await ingestSessionInfoForCache(session);

    await attachToSession({
      bot: deps.bot,
      chatId: scope.chatId,
      threadId: scope.threadId,
      scopeKey: scope.key,
      session: sessionInfo,
      ensureEventSubscription: deps.ensureEventSubscription,
    });

    const currentAgent = await resolveProjectAgent(getStoredAgent(scope.key), scope.key);
    const currentModel = getStoredModel(scope.key);
    keyboardManager.updateAgent(currentAgent, scope.key);
    const contextInfo = keyboardManager.getContextInfo(scope.key);
    const variantName = formatVariantForButton(currentModel.variant || "default");
    const keyboard = createMainKeyboard(
      currentAgent,
      currentModel,
      contextInfo ?? undefined,
      variantName,
    );

    await ctx.reply(t("new.topic_created", { title: session.title }), {
      reply_markup: keyboard,
      ...getThreadSendOptions(scope.threadId),
    });

    logger.info(
      `[Bot] Created session for manually created forum topic: chat=${scope.chatId}, thread=${scope.threadId}, session=${session.id}`,
    );
    return true;
  } catch (error) {
    logger.error("[Bot] Error creating session for manually created forum topic", error);
    await ctx.reply(t("new.create_error"), getThreadSendOptions(scope.threadId));
    return true;
  }
}

export async function handleForumTopicClosed(
  ctx: Context,
  _deps: ForumTopicClosedDeps,
): Promise<boolean> {
  if (
    !ctx.chat ||
    ctx.chat.type !== CHAT_TYPE.SUPERGROUP ||
    Reflect.get(ctx.chat, TELEGRAM_CHAT_FIELD.IS_FORUM) !== true
  ) {
    return false;
  }

  const scope = getScopeFromContext(ctx);
  if (!scope || !isTopicScope(scope) || scope.threadId === null) {
    return false;
  }

  const binding = getTopicBindingByScopeKey(scope.key);
  if (!binding) {
    return false;
  }

  updateTopicBindingStatus(scope.chatId, scope.threadId, TOPIC_SESSION_STATUS.CLOSED);
  clearSession(scope.key);
  clearAllInteractionState("forum_topic_closed", scope.key);

  try {
    if (binding.projectWorktree) {
      const { error } = await opencodeClient.session.abort({
        sessionID: binding.sessionId,
        directory: binding.projectWorktree,
      });
      if (error) {
        logger.debug("[Bot] Session abort before topic close delete was not confirmed", {
          sessionId: binding.sessionId,
          error,
        });
      }
    }

    const { error } = await opencodeClient.session.delete({ sessionID: binding.sessionId });
    if (error) {
      throw error;
    }

    logger.info(
      `[Bot] Deleted session for closed forum topic: chat=${scope.chatId}, thread=${scope.threadId}, session=${binding.sessionId}`,
    );
    return true;
  } catch (error) {
    logger.error("[Bot] Failed to delete session for closed forum topic", {
      chatId: scope.chatId,
      threadId: scope.threadId,
      sessionId: binding.sessionId,
      error,
    });
    return true;
  }
}
