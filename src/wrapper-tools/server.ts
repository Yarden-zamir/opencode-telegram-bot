import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";
import { getCurrentSession } from "../session/manager.js";
import { listScheduledTasks } from "../scheduled-task/store.js";
import {
  createScheduledTaskFromText,
  deleteScheduledTask,
} from "../scheduled-task/service.js";
import { sendBotText } from "../bot/utils/telegram-text.js";
import { logger } from "../utils/logger.js";

const TOOL_FILE_NAME = "opencode_telegram_bot.ts";
const MAX_REQUEST_BYTES = 64 * 1024;
const TELEGRAM_MESSAGE_LIMIT = 4096;

type ToolName =
  | "notify"
  | "scheduler_create_task"
  | "scheduler_list_tasks"
  | "scheduler_delete_task";

interface TelegramContext {
  bot: Bot<Context>;
  chatId: number;
  sessionId: string;
}

interface ToolPayload {
  sessionId: string;
  args: unknown;
}

interface ToolResponse {
  ok: boolean;
  output?: string;
  error?: string;
}

let telegramContext: TelegramContext | null = null;

function getOpenCodeToolsDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "tools");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringProperty(value: Record<string, unknown>, key: string): string {
  const property = value[key];
  if (typeof property !== "string" || !property.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return property.trim();
}

function getOptionalBooleanProperty(value: Record<string, unknown>, key: string): boolean | undefined {
  const property = value[key];
  if (property === undefined) {
    return undefined;
  }

  if (typeof property !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }

  return property;
}

function formatTaskListOutput(): string {
  const tasks = listScheduledTasks();
  if (tasks.length === 0) {
    return "No scheduled tasks are configured.";
  }

  return tasks
    .map((task) => {
      const kindLine = task.kind === "cron" ? `kind=cron cron=${task.cron}` : `kind=once runAt=${task.runAt}`;
      return [
        `id=${task.id}`,
        kindLine,
        `schedule=${task.scheduleSummary}`,
        `nextRunAt=${task.nextRunAt ?? "-"}`,
        `lastStatus=${task.lastStatus}`,
        `prompt=${task.prompt}`,
      ].join("\n");
    })
    .join("\n\n");
}

function assertCurrentSession(payload: ToolPayload): void {
  const currentSession = getCurrentSession();
  if (!currentSession || currentSession.id !== payload.sessionId) {
    throw new Error("Wrapper tools are available only for the current Telegram OpenCode session.");
  }
}

async function runNotify(args: unknown): Promise<string> {
  if (!telegramContext) {
    throw new Error("Telegram context is not initialized for wrapper tools.");
  }

  if (!isRecord(args)) {
    throw new Error("notify args must be an object");
  }

  const message = getStringProperty(args, "message");
  if (message.length > TELEGRAM_MESSAGE_LIMIT) {
    throw new Error(`message must be at most ${TELEGRAM_MESSAGE_LIMIT} characters`);
  }

  const disableNotification = getOptionalBooleanProperty(args, "disableNotification") ?? false;
  await sendBotText({
    api: telegramContext.bot.api,
    chatId: telegramContext.chatId,
    text: message,
    options: { disable_notification: disableNotification },
    format: "raw",
  });

  return "Telegram notification sent to the current chat.";
}

async function runCreateScheduledTask(args: unknown): Promise<string> {
  if (!isRecord(args)) {
    throw new Error("scheduler_create_task args must be an object");
  }

  const scheduleText = getStringProperty(args, "scheduleText");
  const prompt = getStringProperty(args, "prompt");
  const task = await createScheduledTaskFromText({ scheduleText, prompt });

  return [
    "Scheduled task created.",
    `id=${task.id}`,
    `schedule=${task.scheduleSummary}`,
    `nextRunAt=${task.nextRunAt ?? "-"}`,
  ].join("\n");
}

async function runDeleteScheduledTask(args: unknown): Promise<string> {
  if (!isRecord(args)) {
    throw new Error("scheduler_delete_task args must be an object");
  }

  const taskId = getStringProperty(args, "taskId");
  const removed = await deleteScheduledTask(taskId);
  return removed ? `Scheduled task deleted: ${taskId}` : `Scheduled task not found: ${taskId}`;
}

async function executeTool(name: ToolName, payload: ToolPayload): Promise<string> {
  assertCurrentSession(payload);

  switch (name) {
    case "notify":
      if (!telegramContext || telegramContext.sessionId !== payload.sessionId) {
        throw new Error("Telegram notification target is not the current session.");
      }
      return runNotify(payload.args);
    case "scheduler_create_task":
      return runCreateScheduledTask(payload.args);
    case "scheduler_list_tasks":
      return formatTaskListOutput();
    case "scheduler_delete_task":
      return runDeleteScheduledTask(payload.args);
  }
}

function parseToolName(url: string | undefined): ToolName | null {
  if (!url) {
    return null;
  }

  const match = url.match(/^\/tools\/([^/?#]+)/);
  const name = match?.[1];
  if (
    name === "notify" ||
    name === "scheduler_create_task" ||
    name === "scheduler_list_tasks" ||
    name === "scheduler_delete_task"
  ) {
    return name;
  }

  return null;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        request.destroy(new Error("Request body is too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function decodePayload(rawBody: string): ToolPayload {
  const payload = JSON.parse(rawBody) as unknown;
  if (!isRecord(payload)) {
    throw new Error("Request body must be a JSON object");
  }

  return {
    sessionId: getStringProperty(payload, "sessionId"),
    args: payload.args ?? {},
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: ToolResponse): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function buildToolFileContent(endpoint: string, token: string): string {
  return `import { tool } from "@opencode-ai/plugin"

const ENDPOINT = ${JSON.stringify(endpoint)}
const TOKEN = ${JSON.stringify(token)}

async function callTelegramTool(name, args, context) {
  const response = await fetch(ENDPOINT + "/tools/" + name, {
    method: "POST",
    headers: {
      "authorization": "Bearer " + TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: context.sessionID, args }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error || "OpenCode Telegram Bot tool call failed")
  }
  return body.output || "OK"
}

export const notify = tool({
  description: "Send a Telegram notification to the current OpenCode Telegram Bot chat for this session.",
  args: {
    message: tool.schema.string().describe("Notification text to send to Telegram"),
    disableNotification: tool.schema.boolean().optional().describe("Whether Telegram should deliver silently"),
  },
  async execute(args, context) {
    return callTelegramTool("notify", args, context)
  },
})

export const scheduler_create_task = tool({
  description: "Create a scheduled OpenCode task for the current Telegram bot project/session.",
  args: {
    scheduleText: tool.schema.string().describe("Natural-language schedule, for example 'every weekday at 9am'"),
    prompt: tool.schema.string().describe("Prompt to run when the scheduled task fires"),
  },
  async execute(args, context) {
    return callTelegramTool("scheduler_create_task", args, context)
  },
})

export const scheduler_list_tasks = tool({
  description: "List scheduled OpenCode tasks configured in the current OpenCode Telegram Bot instance.",
  args: {},
  async execute(args, context) {
    return callTelegramTool("scheduler_list_tasks", args, context)
  },
})

export const scheduler_delete_task = tool({
  description: "Delete a scheduled OpenCode task by id in the current OpenCode Telegram Bot instance.",
  args: {
    taskId: tool.schema.string().describe("Scheduled task id to delete"),
  },
  async execute(args, context) {
    return callTelegramTool("scheduler_delete_task", args, context)
  },
})
`;
}

async function installOpenCodeToolFile(endpoint: string, token: string): Promise<string> {
  const toolsDir = getOpenCodeToolsDir();
  await fs.mkdir(toolsDir, { recursive: true });
  const toolFilePath = path.join(toolsDir, TOOL_FILE_NAME);
  await fs.writeFile(toolFilePath, buildToolFileContent(endpoint, token), { mode: 0o600 });
  return toolFilePath;
}

export function setWrapperToolTelegramContext(input: {
  bot: Bot<Context>;
  chatId: number;
  sessionId: string;
}): void {
  telegramContext = input;
}

export function clearWrapperToolTelegramContext(sessionId?: string): void {
  if (!telegramContext) {
    return;
  }

  if (!sessionId || telegramContext.sessionId === sessionId) {
    telegramContext = null;
  }
}

export class WrapperToolServer {
  private server: Server | null = null;
  private token = randomBytes(32).toString("hex");
  private endpoint: string | null = null;

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve wrapper tool server address");
    }

    this.endpoint = `http://127.0.0.1:${address.port}`;
    let toolFilePath: string;
    try {
      toolFilePath = await installOpenCodeToolFile(this.endpoint, this.token);
    } catch (error) {
      await this.stop();
      throw error;
    }

    logger.info(`[WrapperTools] Started on ${this.endpoint}; installed ${toolFilePath}`);
  }

  async stop(): Promise<void> {
    clearWrapperToolTelegramContext();

    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.endpoint = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const toolName = parseToolName(request.url);
    if (request.method !== "POST" || !toolName) {
      sendJson(response, 404, { ok: false, error: "Unknown wrapper tool endpoint" });
      return;
    }

    if (request.headers.authorization !== `Bearer ${this.token}`) {
      sendJson(response, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    try {
      const payload = decodePayload(await readRequestBody(request));
      const output = await executeTool(toolName, payload);
      sendJson(response, 200, { ok: true, output });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[WrapperTools] Tool call failed: tool=${toolName}, error=${message}`);
      sendJson(response, 400, { ok: false, error: message });
    }
  }
}

export const wrapperToolServer = new WrapperToolServer();
