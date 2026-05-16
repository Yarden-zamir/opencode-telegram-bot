import type { ParsedTaskSchedule, ScheduledTaskModel, TaskCreationState } from "./types.js";
import { cloneParsedTaskSchedule, cloneScheduledTaskModel } from "./types.js";
import { logger } from "../utils/logger.js";
import { GLOBAL_SCOPE_KEY } from "../bot/scope.js";

function cloneState(state: TaskCreationState): TaskCreationState {
  return {
    ...state,
    model: cloneScheduledTaskModel(state.model),
    parsedSchedule: state.parsedSchedule ? cloneParsedTaskSchedule(state.parsedSchedule) : null,
  };
}

class TaskCreationManager {
  private states = new Map<string, TaskCreationState>();

  private normalizeScopeKey(scopeKey?: string): string {
    return scopeKey ?? GLOBAL_SCOPE_KEY;
  }

  private getMutableState(scopeKey?: string): TaskCreationState | null {
    return this.states.get(this.normalizeScopeKey(scopeKey)) ?? null;
  }

  start(projectId: string, projectWorktree: string, model: ScheduledTaskModel, scopeKey?: string): TaskCreationState {
    const nextState: TaskCreationState = {
      stage: "awaiting_schedule",
      projectId,
      projectWorktree,
      model: cloneScheduledTaskModel(model),
      scheduleText: null,
      parsedSchedule: null,
      scheduleRequestMessageId: null,
      previewMessageId: null,
      promptRequestMessageId: null,
    };
    this.states.set(this.normalizeScopeKey(scopeKey), nextState);

    logger.info(`[TaskCreationManager] Started task creation flow for project=${projectWorktree}`);

    return cloneState(nextState);
  }

  isActive(scopeKey?: string): boolean {
    return this.getMutableState(scopeKey) !== null;
  }

  isWaitingForSchedule(scopeKey?: string): boolean {
    return this.getMutableState(scopeKey)?.stage === "awaiting_schedule";
  }

  isParsingSchedule(scopeKey?: string): boolean {
    return this.getMutableState(scopeKey)?.stage === "parsing_schedule";
  }

  isWaitingForPrompt(scopeKey?: string): boolean {
    return this.getMutableState(scopeKey)?.stage === "awaiting_prompt";
  }

  getState(scopeKey?: string): TaskCreationState | null {
    const state = this.getMutableState(scopeKey);
    return state ? cloneState(state) : null;
  }

  setParsedSchedule(
    scheduleText: string,
    parsedSchedule: ParsedTaskSchedule,
    previewMessageId: number,
    scopeKey?: string,
  ): TaskCreationState | null {
    const state = this.getMutableState(scopeKey);
    if (!state) {
      return null;
    }

    const nextState: TaskCreationState = {
      ...state,
      stage: "awaiting_prompt",
      scheduleText,
      parsedSchedule: cloneParsedTaskSchedule(parsedSchedule),
      scheduleRequestMessageId: null,
      previewMessageId,
      promptRequestMessageId: null,
    };
    this.states.set(this.normalizeScopeKey(scopeKey), nextState);

    logger.info("[TaskCreationManager] Parsed schedule and switched flow to prompt input");

    return cloneState(nextState);
  }

  markScheduleParsing(scopeKey?: string): TaskCreationState | null {
    const state = this.getMutableState(scopeKey);
    if (!state) {
      return null;
    }

    const nextState: TaskCreationState = {
      ...state,
      stage: "parsing_schedule",
    };
    this.states.set(this.normalizeScopeKey(scopeKey), nextState);

    logger.info("[TaskCreationManager] Schedule parsing started");

    return cloneState(nextState);
  }

  setPromptRequestMessageId(messageId: number, scopeKey?: string): TaskCreationState | null {
    const state = this.getMutableState(scopeKey);
    if (!state) {
      return null;
    }

    const nextState: TaskCreationState = {
      ...state,
      promptRequestMessageId: messageId,
    };
    this.states.set(this.normalizeScopeKey(scopeKey), nextState);

    return cloneState(nextState);
  }

  setScheduleRequestMessageId(messageId: number, scopeKey?: string): TaskCreationState | null {
    const state = this.getMutableState(scopeKey);
    if (!state) {
      return null;
    }

    const nextState: TaskCreationState = {
      ...state,
      scheduleRequestMessageId: messageId,
    };
    this.states.set(this.normalizeScopeKey(scopeKey), nextState);

    return cloneState(nextState);
  }

  resetSchedule(scopeKey?: string): TaskCreationState | null {
    const state = this.getMutableState(scopeKey);
    if (!state) {
      return null;
    }

    const nextState: TaskCreationState = {
      ...state,
      stage: "awaiting_schedule",
      scheduleText: null,
      parsedSchedule: null,
      scheduleRequestMessageId: null,
      previewMessageId: null,
      promptRequestMessageId: null,
    };
    this.states.set(this.normalizeScopeKey(scopeKey), nextState);

    logger.info("[TaskCreationManager] Reset task creation flow back to schedule input");

    return cloneState(nextState);
  }

  clear(scopeKey?: string): void {
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
    if (!this.states.has(normalizedScopeKey)) {
      return;
    }

    logger.debug("[TaskCreationManager] Clearing task creation state");
    this.states.delete(normalizedScopeKey);
  }
}

export const taskCreationManager = new TaskCreationManager();
