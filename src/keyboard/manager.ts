import type { Api } from "grammy";
import { createMainKeyboard } from "../bot/utils/keyboard.js";
import type { ModelInfo } from "../model/types.js";
import { getStoredAgent } from "../agent/manager.js";
import { getStoredModel } from "../model/manager.js";
import { formatVariantForButton } from "../variant/manager.js";
import { logger } from "../utils/logger.js";
import type { ContextInfo, KeyboardState } from "./types.js";
import { t } from "../i18n/index.js";
import { GLOBAL_SCOPE_KEY } from "../bot/scope.js";

/**
 * Keyboard Manager - manages Reply Keyboard state and updates
 * Singleton pattern
 */
class KeyboardManager {
  private states = new Map<string, KeyboardState>();

  private api: Api | null = null;
  private chatId: number | null = null;
  private lastUpdateTime: number = 0;
  private readonly UPDATE_DEBOUNCE_MS = 2000; // Don't update more than once per 2 seconds

  /**
   * Initialize the keyboard manager with Telegram API and chat ID
   * Loads initial state from settings/config
   */
  private normalizeScopeKey(scopeKey?: string): string {
    return scopeKey ?? GLOBAL_SCOPE_KEY;
  }

  private getStateForScope(scopeKey?: string): KeyboardState | null {
    return this.states.get(this.normalizeScopeKey(scopeKey)) ?? null;
  }

  public initialize(api: Api, chatId: number, scopeKey?: string): void {
    this.api = api;
    this.chatId = chatId;
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);

    // Initialize state from settings/config on first call
    if (!this.states.has(normalizedScopeKey)) {
      const currentModel = getStoredModel(normalizedScopeKey);
      const state: KeyboardState = {
        currentAgent: getStoredAgent(normalizedScopeKey),
        currentModel: currentModel,
        contextInfo: null,
        variantName: formatVariantForButton(currentModel.variant || "default"),
      };
      this.states.set(normalizedScopeKey, state);
      logger.debug(
        `[KeyboardManager] Initialized with agent="${state.currentAgent}", model="${state.currentModel.providerID}/${state.currentModel.modelID}", variant="${currentModel.variant || "default"}", chatId=${chatId}, scope=${normalizedScopeKey}`,
      );
    } else {
      logger.debug("[KeyboardManager] Already initialized, updating chatId:", chatId);
    }
  }

  /**
   * Update current agent
   */
  public updateAgent(agent: string, scopeKey?: string): void {
    const state = this.getStateForScope(scopeKey);
    if (!state) {
      logger.warn("[KeyboardManager] Cannot update agent: not initialized");
      return;
    }
    state.currentAgent = agent;
    logger.debug(`[KeyboardManager] Agent updated: ${agent}`);
  }

  /**
   * Update current model
   */
  public updateModel(model: ModelInfo, scopeKey?: string): void {
    const state = this.getStateForScope(scopeKey);
    if (!state) {
      logger.warn("[KeyboardManager] Cannot update model: not initialized");
      return;
    }
    state.currentModel = model;
    state.variantName = formatVariantForButton(model.variant || "default");
    logger.debug(
      `[KeyboardManager] Model updated: ${model.providerID}/${model.modelID}, variant: ${model.variant || "default"}`,
    );
  }

  /**
   * Update current variant
   */
  public updateVariant(variantId: string, scopeKey?: string): void {
    const state = this.getStateForScope(scopeKey);
    if (!state) {
      logger.warn("[KeyboardManager] Cannot update variant: not initialized");
      return;
    }
    state.variantName = formatVariantForButton(variantId);
    logger.debug(`[KeyboardManager] Variant updated: ${variantId}`);
  }

  /**
   * Update context information
   */
  public updateContext(tokensUsed: number, tokensLimit: number, scopeKey?: string): void {
    const state = this.getStateForScope(scopeKey);
    if (!state) {
      logger.warn("[KeyboardManager] Cannot update context: not initialized");
      return;
    }
    state.contextInfo = { tokensUsed, tokensLimit };
    logger.debug(`[KeyboardManager] Context updated: ${tokensUsed}/${tokensLimit}`);
  }

  /**
   * Clear context information
   */
  public clearContext(scopeKey?: string): void {
    const state = this.getStateForScope(scopeKey);
    if (!state) {
      logger.warn("[KeyboardManager] Cannot clear context: not initialized");
      return;
    }
    state.contextInfo = null;
    logger.debug("[KeyboardManager] Context cleared");
  }

  /**
   * Get current context info
   */
  public getContextInfo(scopeKey?: string): ContextInfo | null {
    return this.getStateForScope(scopeKey)?.contextInfo ?? null;
  }

  /**
   * Build keyboard with current state
   */
  private buildKeyboard(scopeKey?: string) {
    const state = this.getStateForScope(scopeKey);
    if (!state) {
      logger.warn("[KeyboardManager] Cannot build keyboard: not initialized");
      // Return a minimal keyboard as fallback
      return createMainKeyboard("build", { providerID: "", modelID: "" }, undefined);
    }
    return createMainKeyboard(
      state.currentAgent,
      state.currentModel,
      state.contextInfo ?? undefined,
      state.variantName,
    );
  }

  /**
   * Send keyboard update to user
   * Implements debouncing to avoid rate limits
   */
  public async sendKeyboardUpdate(chatId?: number, scopeKey?: string): Promise<void> {
    if (!this.api) {
      logger.warn("[KeyboardManager] API not initialized");
      return;
    }

    const targetChatId = chatId ?? this.chatId;
    if (!targetChatId) {
      logger.warn("[KeyboardManager] No chatId available");
      return;
    }

    // Debounce: don't update more frequently than UPDATE_DEBOUNCE_MS
    const now = Date.now();
    if (now - this.lastUpdateTime < this.UPDATE_DEBOUNCE_MS) {
      logger.debug("[KeyboardManager] Update debounced");
      return;
    }

    this.lastUpdateTime = now;

    try {
      const keyboard = this.buildKeyboard(scopeKey);

      // Send a dummy message with updated keyboard
      // This is needed because Reply Keyboard updates require a message
      await this.api.sendMessage(targetChatId, t("keyboard.updated"), {
        reply_markup: keyboard,
      });

      logger.debug("[KeyboardManager] Keyboard update sent");
    } catch (err) {
      logger.error("[KeyboardManager] Failed to send keyboard update:", err);
    }
  }

  /**
   * Update keyboard without sending a message (for use in existing messages)
   * Returns undefined if not initialized (caller should handle this)
   */
  public getKeyboard(scopeKey?: string) {
    if (!this.getStateForScope(scopeKey)) {
      logger.warn("[KeyboardManager] Cannot get keyboard: not initialized");
      return undefined;
    }
    return this.buildKeyboard(scopeKey);
  }

  /**
   * Get current keyboard state
   * Returns undefined if not initialized
   */
  public getState(scopeKey?: string): KeyboardState | undefined {
    return this.getStateForScope(scopeKey) ?? undefined;
  }

  /**
   * Check if keyboard manager is initialized
   */
  public isInitialized(scopeKey?: string): boolean {
    return this.states.has(this.normalizeScopeKey(scopeKey));
  }
}

// Export singleton instance
export const keyboardManager = new KeyboardManager();
