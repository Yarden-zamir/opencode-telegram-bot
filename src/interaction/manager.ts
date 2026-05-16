import type {
  InteractionClearReason,
  InteractionState,
  StartInteractionOptions,
  TransitionInteractionOptions,
} from "./types.js";
import { logger } from "../utils/logger.js";
import { GLOBAL_SCOPE_KEY } from "../bot/scope.js";

export const DEFAULT_ALLOWED_INTERACTION_COMMANDS = ["/help", "/status", "/abort", "/detach"] as const;

function normalizeCommand(command: string): string | null {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutMention = withSlash.split("@")[0];

  if (withoutMention.length <= 1) {
    return null;
  }

  return withoutMention;
}

function normalizeAllowedCommands(commands?: string[]): string[] {
  if (commands === undefined) {
    return [...DEFAULT_ALLOWED_INTERACTION_COMMANDS];
  }

  const normalized = new Set<string>();

  for (const command of commands) {
    const value = normalizeCommand(command);
    if (value) {
      normalized.add(value);
    }
  }

  return Array.from(normalized);
}

function cloneState(state: InteractionState): InteractionState {
  return {
    ...state,
    allowedCommands: [...state.allowedCommands],
    metadata: { ...state.metadata },
  };
}

class InteractionManager {
  private states = new Map<string, InteractionState>();

  private normalizeScopeKey(scopeKey?: string): string {
    return scopeKey ?? GLOBAL_SCOPE_KEY;
  }

  start(options: StartInteractionOptions, scopeKey?: string): InteractionState {
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
    const now = Date.now();
    let expiresAt: number | null = null;

    if (this.states.has(normalizedScopeKey)) {
      this.clear("state_replaced", normalizedScopeKey);
    }

    if (typeof options.expiresInMs === "number") {
      expiresAt = now + options.expiresInMs;
    }

    const nextState: InteractionState = {
      kind: options.kind,
      expectedInput: options.expectedInput,
      allowedCommands: normalizeAllowedCommands(options.allowedCommands),
      metadata: options.metadata ? { ...options.metadata } : {},
      createdAt: now,
      expiresAt,
    };

    this.states.set(normalizedScopeKey, nextState);

    logger.info(
      `[InteractionManager] Started interaction: scope=${normalizedScopeKey}, kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return cloneState(nextState);
  }

  get(scopeKey?: string): InteractionState | null {
    const state = this.states.get(this.normalizeScopeKey(scopeKey));
    if (!state) {
      return null;
    }

    return cloneState(state);
  }

  getSnapshot(scopeKey?: string): InteractionState | null {
    return this.get(scopeKey);
  }

  isActive(scopeKey?: string): boolean {
    return this.states.has(this.normalizeScopeKey(scopeKey));
  }

  isExpired(referenceTimeMs: number = Date.now(), scopeKey?: string): boolean {
    const state = this.states.get(this.normalizeScopeKey(scopeKey));
    if (!state || state.expiresAt === null) {
      return false;
    }

    return referenceTimeMs >= state.expiresAt;
  }

  transition(options: TransitionInteractionOptions, scopeKey?: string): InteractionState | null {
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
    const state = this.states.get(normalizedScopeKey);
    if (!state) {
      return null;
    }

    const now = Date.now();

    const nextState = {
      ...state,
      kind: options.kind ?? state.kind,
      expectedInput: options.expectedInput ?? state.expectedInput,
      allowedCommands:
        options.allowedCommands !== undefined
          ? normalizeAllowedCommands(options.allowedCommands)
          : [...state.allowedCommands],
      metadata: options.metadata ? { ...options.metadata } : { ...state.metadata },
      expiresAt:
        options.expiresInMs === undefined
          ? state.expiresAt
          : options.expiresInMs === null
            ? null
            : now + options.expiresInMs,
    };
    this.states.set(normalizedScopeKey, nextState);

    logger.debug(
      `[InteractionManager] Transitioned interaction: scope=${normalizedScopeKey}, kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return cloneState(nextState);
  }

  clear(reason: InteractionClearReason = "manual", scopeKey?: string): void {
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
    const state = this.states.get(normalizedScopeKey);
    if (!state) {
      return;
    }

    logger.info(
      `[InteractionManager] Cleared interaction: scope=${normalizedScopeKey}, reason=${reason}, kind=${state.kind}, expectedInput=${state.expectedInput}`,
    );

    this.states.delete(normalizedScopeKey);
  }
}

export const interactionManager = new InteractionManager();
