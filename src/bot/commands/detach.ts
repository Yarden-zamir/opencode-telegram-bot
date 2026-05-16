import { CommandContext, Context } from "grammy";
import { getCurrentProject } from "../../settings/manager.js";
import { clearSession, getCurrentSession } from "../../session/manager.js";
import { detachAttachedSession } from "../../attach/service.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { foregroundSessionState } from "../../scheduled-task/foreground-state.js";
import { assistantRunState } from "../assistant-run-state.js";
import { clearPromptResponseMode } from "../handlers/prompt.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { getScopeFromContext } from "../scope.js";

export async function detachCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const scope = getScopeFromContext(ctx);
    const scopeKey = scope?.key;
    const currentProject = getCurrentProject(scopeKey);
    if (!currentProject) {
      await ctx.reply(t("detach.project_not_selected"));
      return;
    }

    const currentSession = getCurrentSession(scopeKey);
    if (!currentSession) {
      await ctx.reply(t("detach.no_active_session"));
      return;
    }

    detachAttachedSession("detach_command");
    clearPromptResponseMode(currentSession.id);
    foregroundSessionState.markIdle(currentSession.id);
    assistantRunState.clearRun(currentSession.id, "detach_command");
    if (scopeKey) {
      clearAllInteractionState("detach_command", scopeKey);
    } else {
      clearAllInteractionState("detach_command");
    }
    clearSession(scopeKey);

    if (pinnedMessageManager.isInitialized(scopeKey)) {
      try {
        await pinnedMessageManager.clear(scopeKey);
      } catch (error) {
        logger.error("[Detach] Failed to clear pinned message:", error);
      }
    }

    if (ctx.chat) {
      keyboardManager.initialize(ctx.api, ctx.chat.id, scopeKey);
    }

    await pinnedMessageManager.refreshContextLimit(scopeKey);
    const contextLimit = pinnedMessageManager.getContextLimit(scopeKey);
    if (scopeKey) {
      keyboardManager.updateContext(0, contextLimit, scopeKey);
    } else {
      keyboardManager.updateContext(0, contextLimit);
    }

    const keyboard = keyboardManager.getKeyboard(scopeKey);

    logger.info(
      `[Detach] Detached from session: id=${currentSession.id}, title="${currentSession.title}", project=${currentProject.worktree}`,
    );

    await ctx.reply(t("detach.success", { title: currentSession.title }), {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (error) {
    logger.error("[Detach] Failed to detach from current session:", error);
    await ctx.reply(t("detach.error"));
  }
}
