import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { resolveLocalOpencodeTarget } from "./process.js";

function isAllInterfacesHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

export async function checkLocalOpencodeServerBindAddress(
  reason: string,
): Promise<boolean | null> {
  const localTarget = resolveLocalOpencodeTarget(config.opencode.apiUrl);
  if (!localTarget) {
    return null;
  }

  if (isAllInterfacesHost(localTarget.host)) {
    logger.debug(
      `[OpenCodeBinding] OpenCode server is configured for all interfaces: reason=${reason}, host=${localTarget.host}, port=${localTarget.port}`,
    );
    return true;
  }

  logger.warn(
    `[OpenCodeBinding] OpenCode server is configured for ${localTarget.host}, not 0.0.0.0: reason=${reason}, port=${localTarget.port}. Set OPENCODE_API_URL=http://0.0.0.0:${localTarget.port} if the bot should start OpenCode on all interfaces.`,
  );
  return false;
}
