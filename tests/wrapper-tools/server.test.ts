import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  setWrapperToolTelegramContext,
  WrapperToolServer,
} from "../../src/wrapper-tools/server.js";

const mocked = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  sendBotText: vi.fn(),
  listScheduledTasks: vi.fn(),
  createScheduledTaskFromText: vi.fn(),
  deleteScheduledTask: vi.fn(),
}));

vi.mock("../../src/session/manager.js", () => ({
  getCurrentSession: mocked.getCurrentSession,
}));

vi.mock("../../src/bot/utils/telegram-text.js", () => ({
  sendBotText: mocked.sendBotText,
}));

vi.mock("../../src/scheduled-task/store.js", () => ({
  listScheduledTasks: mocked.listScheduledTasks,
}));

vi.mock("../../src/scheduled-task/service.js", () => ({
  createScheduledTaskFromText: mocked.createScheduledTaskFromText,
  deleteScheduledTask: mocked.deleteScheduledTask,
}));

function extractToolConnection(content: string): { endpoint: string; token: string } {
  const endpoint = content.match(/const ENDPOINT = "([^"]+)"/)?.[1];
  const token = content.match(/const TOKEN = "([^"]+)"/)?.[1];
  if (!endpoint || !token) {
    throw new Error("Generated tool file did not contain endpoint and token");
  }

  return { endpoint, token };
}

async function postTool(
  endpoint: string,
  token: string,
  tool: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${endpoint}/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("wrapper-tools/server", () => {
  let tempConfigHome: string;
  let server: WrapperToolServer;

  beforeEach(async () => {
    tempConfigHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-wrapper-tools-"));
    process.env.XDG_CONFIG_HOME = tempConfigHome;
    server = new WrapperToolServer();

    mocked.getCurrentSession.mockReset();
    mocked.sendBotText.mockReset();
    mocked.listScheduledTasks.mockReset();
    mocked.createScheduledTaskFromText.mockReset();
    mocked.deleteScheduledTask.mockReset();

    mocked.getCurrentSession.mockReturnValue({ id: "session-1", title: "Session", directory: "/repo" });
    mocked.sendBotText.mockResolvedValue(undefined);
    mocked.listScheduledTasks.mockReturnValue([]);
  });

  afterEach(async () => {
    await server.stop();
    delete process.env.XDG_CONFIG_HOME;
    await rm(tempConfigHome, { recursive: true, force: true });
  });

  it("installs an OpenCode custom tool file and sends Telegram notifications", async () => {
    await server.start();
    const toolFilePath = path.join(tempConfigHome, "opencode", "tools", "opencode_telegram_bot.ts");
    const { endpoint, token } = extractToolConnection(await fs.readFile(toolFilePath, "utf-8"));

    const bot = { api: { sendMessage: vi.fn() } } as unknown as Bot<Context>;
    setWrapperToolTelegramContext({ bot, chatId: 123, sessionId: "session-1" });

    const response = await postTool(endpoint, token, "notify", {
      sessionId: "session-1",
      args: { message: "Build finished" },
    });
    const body = (await response.json()) as { ok: boolean; output?: string };

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, output: "Telegram notification sent to the current chat." });
    expect(mocked.sendBotText).toHaveBeenCalledWith(
      expect.objectContaining({ api: bot.api, chatId: 123, text: "Build finished" }),
    );
  });

  it("rejects tool calls for non-current sessions", async () => {
    await server.start();
    const toolFilePath = path.join(tempConfigHome, "opencode", "tools", "opencode_telegram_bot.ts");
    const { endpoint, token } = extractToolConnection(await fs.readFile(toolFilePath, "utf-8"));

    const response = await postTool(endpoint, token, "scheduler_list_tasks", {
      sessionId: "other-session",
      args: {},
    });
    const body = (await response.json()) as { ok: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("current Telegram OpenCode session");
  });
});
