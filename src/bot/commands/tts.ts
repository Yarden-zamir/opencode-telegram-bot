import { CommandContext, Context } from "grammy";
import { isTtsConfigured } from "../../tts/client.js";
import { isTtsEnabled, setTtsEnabled } from "../../settings/manager.js";
import { t } from "../../i18n/index.js";
import { getOptionalThreadSendOptions, getScopeKeyFromContext } from "../scope.js";

export async function ttsCommand(ctx: CommandContext<Context>): Promise<void> {
  const scopeKey = getScopeKeyFromContext(ctx);
  const enabled = !isTtsEnabled(scopeKey);

  if (enabled && !isTtsConfigured()) {
    const threadOptions = getOptionalThreadSendOptions(ctx.message?.message_thread_id ?? null);
    if (threadOptions) {
      await ctx.reply(t("tts.not_configured"), threadOptions);
    } else {
      await ctx.reply(t("tts.not_configured"));
    }
    return;
  }

  setTtsEnabled(enabled, scopeKey);

  const message = enabled ? t("tts.enabled") : t("tts.disabled");

  const threadOptions = getOptionalThreadSendOptions(ctx.message?.message_thread_id ?? null);
  if (threadOptions) {
    await ctx.reply(message, threadOptions);
  } else {
    await ctx.reply(message);
  }
}
