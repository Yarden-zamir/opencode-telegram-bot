import {
  getCurrentSession as getSettingsSession,
  setCurrentSession as setSettingsSession,
  clearSession as clearSettingsSession,
  SessionInfo,
} from "../settings/manager.js";
import { parseScopeKey, SCOPE_CONTEXT } from "../bot/scope.js";
import { logger } from "../utils/logger.js";

export type { SessionInfo };

export function setCurrentSession(sessionInfo: SessionInfo, scopeKey?: string): void {
  const existing = getSettingsSession(scopeKey);
  const parsedScope = scopeKey ? parseScopeKey(scopeKey) : null;
  if (parsedScope?.context === SCOPE_CONTEXT.GROUP_TOPIC && existing && existing.id !== sessionInfo.id) {
    logger.warn(
      `[SessionManager] Rejecting session switch in immutable topic scope: scope=${scopeKey}, existing=${existing.id}, requested=${sessionInfo.id}`,
    );
    return;
  }

  setSettingsSession(sessionInfo, scopeKey);
}

export function getCurrentSession(scopeKey?: string): SessionInfo | null {
  return getSettingsSession(scopeKey) ?? null;
}

export function clearSession(scopeKey?: string): void {
  clearSettingsSession(scopeKey);
}
