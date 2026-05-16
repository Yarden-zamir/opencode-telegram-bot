import type { CommandContext, Context } from "grammy";
import { getCurrentProject } from "../../settings/manager.js";
import { getCurrentSession } from "../../session/manager.js";
import { questionManager } from "../../question/manager.js";
import {
  loadLastAssistantMessage,
  loadLastVisibleTurn,
  truncateText,
} from "../../session/history.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { showCurrentQuestion } from "../handlers/question.js";
import { getOptionalThreadSendOptions, getScopeFromContext } from "../scope.js";

const LAST_MESSAGE_MAX_LENGTH = 3500;

function formatLastMessage(role: "user" | "assistant", text: string): string {
  const label = role === "user" ? t("sessions.preview.you") : t("sessions.preview.agent");
  return `${t("last.title")}\n\n${label} ${truncateText(text, LAST_MESSAGE_MAX_LENGTH)}`;
}

export async function lastCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const scope = getScopeFromContext(ctx);
    const scopeKey = scope?.key;
    if (questionManager.isActive(scopeKey) && questionManager.getActiveMessageId(scopeKey) === null) {
      await showCurrentQuestion(ctx.api, ctx.chat!.id, scopeKey, scope?.threadId ?? null);
      return;
    }

    const currentProject = getCurrentProject(scopeKey);
    if (!currentProject) {
      await ctx.reply(t("bot.project_not_selected"));
      return;
    }

    const currentSession = getCurrentSession(scopeKey);
    if (!currentSession) {
      await ctx.reply(t("last.session_not_selected"));
      return;
    }

    const lastVisibleTurn =
      (await loadLastAssistantMessage(currentSession.id, currentSession.directory)) ??
      (await loadLastVisibleTurn(currentSession.id, currentSession.directory));
    if (!lastVisibleTurn) {
      await ctx.reply(t("last.empty"));
      return;
    }

    const message = formatLastMessage(lastVisibleTurn.role, lastVisibleTurn.text);
    const threadOptions = getOptionalThreadSendOptions(scope?.threadId ?? null);
    if (threadOptions) {
      await ctx.reply(message, threadOptions);
    } else {
      await ctx.reply(message);
    }
  } catch (error) {
    logger.error("[Last] Error loading latest session message:", error);
    await ctx.reply(t("last.fetch_error"));
  }
}
