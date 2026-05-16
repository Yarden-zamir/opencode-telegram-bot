import type { Context, NextFunction } from "grammy";
import { t } from "../../i18n/index.js";
import { getScheduledTaskTopicByChatAndThread } from "../../scheduled-task/store.js";
import { extractCommandName } from "../utils/commands.js";

const ALLOWED_COMMANDS = new Set<string>(["start", "help"]);

function getMessageThreadId(ctx: Context): number | null {
  const threadId = ctx.message?.message_thread_id;
  return typeof threadId === "number" && Number.isInteger(threadId) && threadId > 0
    ? threadId
    : null;
}

export async function isScheduledTaskOutputTopicContext(ctx: Context): Promise<boolean> {
  if (ctx.chat?.type === "private" || !ctx.chat) {
    return false;
  }

  const threadId = getMessageThreadId(ctx);
  if (threadId === null) {
    return false;
  }

  const binding = await getScheduledTaskTopicByChatAndThread(ctx.chat.id, threadId);
  return Boolean(binding);
}

export async function scheduledOutputTopicMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const text = ctx.message?.text;
  if (!text) {
    await next();
    return;
  }

  const commandName = extractCommandName(text);
  if (!commandName) {
    await next();
    return;
  }

  const threadId = getMessageThreadId(ctx);
  if (!(await isScheduledTaskOutputTopicContext(ctx)) || threadId === null) {
    await next();
    return;
  }

  if (ALLOWED_COMMANDS.has(commandName)) {
    await next();
    return;
  }

  await ctx.reply(t("task.output_topic_commands_only"), { message_thread_id: threadId });
}
