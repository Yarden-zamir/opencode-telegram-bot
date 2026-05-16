import { logger } from "../utils/logger.js";
import { GLOBAL_SCOPE_KEY } from "../bot/scope.js";

interface RenameState {
  isWaiting: boolean;
  sessionId: string | null;
  sessionDirectory: string | null;
  currentTitle: string | null;
  messageId: number | null;
}

class RenameManager {
  private states = new Map<string, RenameState>();

  private normalizeScopeKey(scopeKey?: string): string {
    return scopeKey ?? GLOBAL_SCOPE_KEY;
  }

  private createEmptyState(): RenameState {
    return {
    isWaiting: false,
    sessionId: null,
    sessionDirectory: null,
    currentTitle: null,
    messageId: null,
  };
  }

  private getState(scopeKey?: string): RenameState {
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
    let state = this.states.get(normalizedScopeKey);
    if (!state) {
      state = this.createEmptyState();
      this.states.set(normalizedScopeKey, state);
    }
    return state;
  }

  startWaiting(sessionId: string, directory: string, currentTitle: string, scopeKey?: string): void {
    logger.info(`[RenameManager] Starting rename flow for session: ${sessionId}`);
    this.states.set(this.normalizeScopeKey(scopeKey), {
      isWaiting: true,
      sessionId,
      sessionDirectory: directory,
      currentTitle,
      messageId: null,
    });
  }

  setMessageId(messageId: number, scopeKey?: string): void {
    this.getState(scopeKey).messageId = messageId;
  }

  getMessageId(scopeKey?: string): number | null {
    return this.getState(scopeKey).messageId;
  }

  isActiveMessage(messageId: number | null, scopeKey?: string): boolean {
    const state = this.getState(scopeKey);
    return (
      state.isWaiting && state.messageId !== null && state.messageId === messageId
    );
  }

  isWaitingForName(scopeKey?: string): boolean {
    return this.getState(scopeKey).isWaiting;
  }

  getSessionInfo(scopeKey?: string): { sessionId: string; directory: string; currentTitle: string } | null {
    const state = this.getState(scopeKey);
    if (!state.isWaiting || !state.sessionId) {
      return null;
    }
    return {
      sessionId: state.sessionId,
      directory: state.sessionDirectory!,
      currentTitle: state.currentTitle!,
    };
  }

  clear(scopeKey?: string): void {
    logger.debug("[RenameManager] Clearing rename state");
    this.states.set(this.normalizeScopeKey(scopeKey), this.createEmptyState());
  }
}

export const renameManager = new RenameManager();
