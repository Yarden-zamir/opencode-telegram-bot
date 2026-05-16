import { PermissionRequest, PermissionState } from "./types.js";
import { logger } from "../utils/logger.js";
import { GLOBAL_SCOPE_KEY } from "../bot/scope.js";

class PermissionManager {
  private states = new Map<string, PermissionState>();

  private normalizeScopeKey(scopeKey?: string): string {
    return scopeKey ?? GLOBAL_SCOPE_KEY;
  }

  private getState(scopeKey?: string): PermissionState {
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
    let state = this.states.get(normalizedScopeKey);
    if (!state) {
      state = { requestsByMessageId: new Map() };
      this.states.set(normalizedScopeKey, state);
    }
    return state;
  }

  /**
   * Register a new permission request message
   */
  startPermission(request: PermissionRequest, messageId: number, scopeKey?: string): void {
    const state = this.getState(scopeKey);
    logger.debug(
      `[PermissionManager] startPermission: scope=${this.normalizeScopeKey(scopeKey)}, id=${request.id}, permission=${request.permission}, messageId=${messageId}`,
    );

    if (state.requestsByMessageId.has(messageId)) {
      logger.warn(`[PermissionManager] Message ID already tracked, replacing: ${messageId}`);
    }

    state.requestsByMessageId.set(messageId, request);

    logger.info(
      `[PermissionManager] New permission request: type=${request.permission}, patterns=${request.patterns.join(", ")}, pending=${state.requestsByMessageId.size}`,
    );
  }

  /**
   * Get permission request by Telegram message ID
   */
  getRequest(messageId: number | null, scopeKey?: string): PermissionRequest | null {
    if (messageId === null) {
      return null;
    }

    return this.getState(scopeKey).requestsByMessageId.get(messageId) ?? null;
  }

  /**
   * Get request ID for API reply by Telegram message ID
   */
  getRequestID(messageId: number | null, scopeKey?: string): string | null {
    return this.getRequest(messageId, scopeKey)?.id ?? null;
  }

  /**
   * Get permission type (bash, edit, etc.) by message ID
   */
  getPermissionType(messageId: number | null, scopeKey?: string): string | null {
    return this.getRequest(messageId, scopeKey)?.permission ?? null;
  }

  /**
   * Get patterns (commands/files) by message ID
   */
  getPatterns(messageId: number | null, scopeKey?: string): string[] {
    return this.getRequest(messageId, scopeKey)?.patterns ?? [];
  }

  /**
   * Check if callback message ID belongs to active permission request
   */
  isActiveMessage(messageId: number | null, scopeKey?: string): boolean {
    return messageId !== null && this.getState(scopeKey).requestsByMessageId.has(messageId);
  }

  /**
   * Get latest Telegram message ID
   */
  getMessageId(scopeKey?: string): number | null {
    const messageIds = this.getMessageIds(scopeKey);
    if (messageIds.length === 0) {
      return null;
    }

    return messageIds[messageIds.length - 1];
  }

  /**
   * Get Telegram message IDs for all active requests
   */
  getMessageIds(scopeKey?: string): number[] {
    return Array.from(this.getState(scopeKey).requestsByMessageId.keys());
  }

  /**
   * Remove permission request by Telegram message ID
   */
  removeByMessageId(messageId: number | null, scopeKey?: string): PermissionRequest | null {
    const state = this.getState(scopeKey);
    const request = this.getRequest(messageId, scopeKey);
    if (!request || messageId === null) {
      return null;
    }

    state.requestsByMessageId.delete(messageId);

    logger.debug(
      `[PermissionManager] Removed permission request: id=${request.id}, messageId=${messageId}, pending=${state.requestsByMessageId.size}`,
    );

    return request;
  }

  /**
   * Get number of active permission requests
   */
  getPendingCount(scopeKey?: string): number {
    return this.getState(scopeKey).requestsByMessageId.size;
  }

  /**
   * Check if there are active permission requests
   */
  isActive(scopeKey?: string): boolean {
    return this.getState(scopeKey).requestsByMessageId.size > 0;
  }

  /**
   * Clear state after reply
   */
  clear(scopeKey?: string): void {
    const state = this.getState(scopeKey);
    logger.debug(
      `[PermissionManager] Clearing permission state: pending=${state.requestsByMessageId.size}`,
    );

    this.states.set(this.normalizeScopeKey(scopeKey), { requestsByMessageId: new Map() });
  }
}

export const permissionManager = new PermissionManager();
