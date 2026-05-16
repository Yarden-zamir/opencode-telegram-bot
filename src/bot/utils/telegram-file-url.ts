import { config } from "../../config.js";

const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

export function telegramFileUrlBase(): string {
  const apiRoot = config.telegram.apiRoot
    ? config.telegram.apiRoot.replace(/\/+$/, "")
    : DEFAULT_TELEGRAM_API_ROOT;

  return `${apiRoot}/file/bot`;
}

export function buildTelegramFileUrl(filePath: string): string {
  return `${telegramFileUrlBase()}${config.telegram.token}/${filePath}`;
}
