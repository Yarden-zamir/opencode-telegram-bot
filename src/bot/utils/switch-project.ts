import type { Context } from "grammy";
import type { ProjectInfo } from "../../settings/manager.js";
import { setCurrentProject } from "../../settings/manager.js";
import { clearSession } from "../../session/manager.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { detachAttachedSession } from "../../attach/service.js";
import { stopEventListening } from "../../opencode/events.js";
import { backgroundSessionTracker } from "../../background-session/tracker.js";
import { getStoredAgent, resolveProjectAgent } from "../../agent/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { createMainKeyboard } from "./keyboard.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { getScopeFromContext } from "../scope.js";

/**
 * Shared logic for switching the active project.
 *
 * Called by both `/projects` (selecting an existing project) and `/open`
 * (browsing and adding a new directory). Performs the full state transition:
 * persists the project, clears the session, resets the pinned message and
 * keyboard, and returns a fresh reply keyboard for the caller to attach to
 * its confirmation message.
 *
 * @param ctx       grammY callback context (used for `ctx.chat` / `ctx.api`)
 * @param project   the project to switch to
 * @param reason    short tag for `clearAllInteractionState` (e.g. "project_switched")
 */
interface SwitchToProjectOptions {
  ensureEventSubscription?: (directory: string) => Promise<void>;
}

export async function switchToProject(
  ctx: Context,
  project: ProjectInfo,
  reason: string,
  options: SwitchToProjectOptions = {},
) {
  const scopeKey = getScopeFromContext(ctx)?.key;
  detachAttachedSession(reason);
  stopEventListening();
  backgroundSessionTracker.clear();
  if (scopeKey) {
    setCurrentProject(project, scopeKey);
    clearSession(scopeKey);
  } else {
    setCurrentProject(project);
    clearSession();
  }
  summaryAggregator.clear();
  if (scopeKey) {
    clearAllInteractionState(reason, scopeKey);
  } else {
    clearAllInteractionState(reason);
  }

  try {
    await pinnedMessageManager.clear(scopeKey);
  } catch (err) {
    logger.error("[Bot] Error clearing pinned message:", err);
  }

  if (ctx.chat) {
    if (scopeKey) {
      keyboardManager.initialize(ctx.api, ctx.chat.id, scopeKey);
    } else {
      keyboardManager.initialize(ctx.api, ctx.chat.id);
    }
  }

  await pinnedMessageManager.refreshContextLimit(scopeKey);
  const contextLimit = pinnedMessageManager.getContextLimit(scopeKey);
  if (scopeKey) {
    keyboardManager.updateContext(0, contextLimit, scopeKey);
  } else {
    keyboardManager.updateContext(0, contextLimit);
  }

  const currentAgent = await resolveProjectAgent(getStoredAgent(scopeKey), scopeKey);
  const currentModel = getStoredModel(scopeKey);
  const contextInfo = { tokensUsed: 0, tokensLimit: contextLimit };
  const variantName = formatVariantForButton(currentModel.variant || "default");
  if (scopeKey) {
    keyboardManager.updateAgent(currentAgent, scopeKey);
  } else {
    keyboardManager.updateAgent(currentAgent);
  }

  if (config.bot.trackBackgroundSessions && options.ensureEventSubscription) {
    await options.ensureEventSubscription(project.worktree);
  }

  return createMainKeyboard(currentAgent, currentModel, contextInfo, variantName);
}
