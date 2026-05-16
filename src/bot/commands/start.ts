import { Context } from "grammy";
import { createMainKeyboard } from "../utils/keyboard.js";
import { getStoredAgent } from "../../agent/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { formatVariantForButton } from "../../variant/manager.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { keyboardManager } from "../../keyboard/manager.js";
import { clearSession } from "../../session/manager.js";
import { clearProject } from "../../settings/manager.js";
import { foregroundSessionState } from "../../scheduled-task/foreground-state.js";
import { abortCurrentOperation } from "./abort.js";
import { t } from "../../i18n/index.js";
import { assistantRunState } from "../assistant-run-state.js";
import { detachAttachedSession } from "../../attach/service.js";
import { getScopeFromContext, getThreadSendOptions } from "../scope.js";

export async function startCommand(ctx: Context): Promise<void> {
  const scope = getScopeFromContext(ctx);
  const scopeKey = scope?.key;
  if (ctx.chat) {
    if (!pinnedMessageManager.isInitialized(scopeKey)) {
      if (scopeKey || scope?.threadId) {
        pinnedMessageManager.initialize(ctx.api, ctx.chat.id, scopeKey, scope?.threadId ?? null);
      } else {
        pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
      }
    }
    if (scopeKey) {
      keyboardManager.initialize(ctx.api, ctx.chat.id, scopeKey);
    } else {
      keyboardManager.initialize(ctx.api, ctx.chat.id);
    }
  }

  await abortCurrentOperation(ctx, { notifyUser: false });
  detachAttachedSession("start_command_reset");
  foregroundSessionState.clearAll("start_command_reset");
  assistantRunState.clearAll("start_command_reset");

  clearSession(scopeKey);
  clearProject(scopeKey);
  keyboardManager.clearContext(scopeKey);
  await pinnedMessageManager.clear(scopeKey);

  if (pinnedMessageManager.getContextLimit(scopeKey) === 0) {
    await pinnedMessageManager.refreshContextLimit(scopeKey);
  }

  // Get current agent, model, and context
  const currentAgent = getStoredAgent(scopeKey);
  const currentModel = getStoredModel(scopeKey);
  const variantName = formatVariantForButton(currentModel.variant || "default");
  const contextInfo =
    pinnedMessageManager.getContextInfo(scopeKey) ??
    (pinnedMessageManager.getContextLimit(scopeKey) > 0
      ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit(scopeKey) }
      : null);

  keyboardManager.updateAgent(currentAgent, scopeKey);
  keyboardManager.updateModel(currentModel, scopeKey);
  if (contextInfo) {
    keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit, scopeKey);
  }

  const keyboard = createMainKeyboard(
    currentAgent,
    currentModel,
    contextInfo ?? undefined,
    variantName,
  );

  await ctx.reply(t("start.welcome"), {
    reply_markup: keyboard,
    ...getThreadSendOptions(scope?.threadId ?? null),
  });
}
