import { Question, QuestionState, QuestionAnswer } from "./types.js";
import { logger } from "../utils/logger.js";
import { GLOBAL_SCOPE_KEY } from "../bot/scope.js";

function createEmptyQuestionState(): QuestionState {
  return {
    questions: [],
    currentIndex: 0,
    selectedOptions: new Map(),
    customAnswers: new Map(),
    customInputQuestionIndex: null,
    activeMessageId: null,
    messageIds: [],
    isActive: false,
    requestID: null,
  };
}

class QuestionManager {
  private states = new Map<string, QuestionState>();

  private normalizeScopeKey(scopeKey?: string): string {
    return scopeKey ?? GLOBAL_SCOPE_KEY;
  }

  private getState(scopeKey?: string): QuestionState {
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
    let state = this.states.get(normalizedScopeKey);
    if (!state) {
      state = createEmptyQuestionState();
      this.states.set(normalizedScopeKey, state);
    }
    return state;
  }

  startQuestions(questions: Question[], requestID: string, scopeKey?: string): void {
    const state = this.getState(scopeKey);
    logger.debug(
      `[QuestionManager] startQuestions called: scope=${this.normalizeScopeKey(scopeKey)}, isActive=${state.isActive}, currentQuestions=${state.questions.length}, newQuestions=${questions.length}, requestID=${requestID}`,
    );

    if (state.isActive) {
      logger.info(`[QuestionManager] Poll already active! Forcing reset before starting new poll.`);
      // Force-reset the previous poll before starting a new one
      this.clear(scopeKey);
    }

    logger.info(
      `[QuestionManager] Starting new poll with ${questions.length} questions, requestID=${requestID}`,
    );
    this.states.set(this.normalizeScopeKey(scopeKey), {
      questions,
      currentIndex: 0,
      selectedOptions: new Map(),
      customAnswers: new Map(),
      customInputQuestionIndex: null,
      activeMessageId: null,
      messageIds: [],
      isActive: true,
      requestID,
    });
  }

  getRequestID(scopeKey?: string): string | null {
    return this.getState(scopeKey).requestID;
  }

  getCurrentQuestion(scopeKey?: string): Question | null {
    const state = this.getState(scopeKey);
    if (state.currentIndex >= state.questions.length) {
      return null;
    }
    return state.questions[state.currentIndex];
  }

  selectOption(questionIndex: number, optionIndex: number, scopeKey?: string): void {
    const state = this.getState(scopeKey);
    if (!state.isActive) {
      return;
    }

    const question = state.questions[questionIndex];
    if (!question) {
      return;
    }

    const selected = state.selectedOptions.get(questionIndex) || new Set();

    if (question.multiple) {
      if (selected.has(optionIndex)) {
        selected.delete(optionIndex);
      } else {
        selected.add(optionIndex);
      }
    } else {
      selected.clear();
      selected.add(optionIndex);
    }

    state.selectedOptions.set(questionIndex, selected);

    logger.debug(
      `[QuestionManager] Selected options for question ${questionIndex}: ${Array.from(selected).join(", ")}`,
    );
  }

  getSelectedOptions(questionIndex: number, scopeKey?: string): Set<number> {
    return this.getState(scopeKey).selectedOptions.get(questionIndex) || new Set();
  }

  getSelectedAnswer(questionIndex: number, scopeKey?: string): string {
    const state = this.getState(scopeKey);
    const question = state.questions[questionIndex];
    if (!question) {
      return "";
    }

    const selected = state.selectedOptions.get(questionIndex) || new Set();
    const options = Array.from(selected)
      .map((idx) => question.options[idx])
      .filter((opt) => opt)
      .map((opt) => `* ${opt.label}: ${opt.description}`);

    return options.join("\n");
  }

  setCustomAnswer(questionIndex: number, answer: string, scopeKey?: string): void {
    logger.debug(
      `[QuestionManager] Custom answer received for question ${questionIndex}: ${answer}`,
    );
    this.getState(scopeKey).customAnswers.set(questionIndex, answer);
  }

  getCustomAnswer(questionIndex: number, scopeKey?: string): string | undefined {
    return this.getState(scopeKey).customAnswers.get(questionIndex);
  }

  hasCustomAnswer(questionIndex: number, scopeKey?: string): boolean {
    return this.getState(scopeKey).customAnswers.has(questionIndex);
  }

  nextQuestion(scopeKey?: string): void {
    const state = this.getState(scopeKey);
    state.currentIndex++;
    state.customInputQuestionIndex = null;
    state.activeMessageId = null;

    logger.debug(
      `[QuestionManager] Moving to next question: ${state.currentIndex}/${state.questions.length}`,
    );
  }

  hasNextQuestion(scopeKey?: string): boolean {
    const state = this.getState(scopeKey);
    return state.currentIndex < state.questions.length;
  }

  getCurrentIndex(scopeKey?: string): number {
    return this.getState(scopeKey).currentIndex;
  }

  getTotalQuestions(scopeKey?: string): number {
    return this.getState(scopeKey).questions.length;
  }

  addMessageId(messageId: number, scopeKey?: string): void {
    this.getState(scopeKey).messageIds.push(messageId);
  }

  setActiveMessageId(messageId: number, scopeKey?: string): void {
    this.getState(scopeKey).activeMessageId = messageId;
  }

  getActiveMessageId(scopeKey?: string): number | null {
    return this.getState(scopeKey).activeMessageId;
  }

  isActiveMessage(messageId: number | null, scopeKey?: string): boolean {
    const state = this.getState(scopeKey);
    return (
      state.isActive && state.activeMessageId !== null && messageId === state.activeMessageId
    );
  }

  startCustomInput(questionIndex: number, scopeKey?: string): void {
    const state = this.getState(scopeKey);
    if (!state.isActive || !state.questions[questionIndex]) {
      return;
    }

    state.customInputQuestionIndex = questionIndex;
  }

  clearCustomInput(scopeKey?: string): void {
    this.getState(scopeKey).customInputQuestionIndex = null;
  }

  isWaitingForCustomInput(questionIndex: number, scopeKey?: string): boolean {
    return this.getState(scopeKey).customInputQuestionIndex === questionIndex;
  }

  getMessageIds(scopeKey?: string): number[] {
    return [...this.getState(scopeKey).messageIds];
  }

  isActive(scopeKey?: string): boolean {
    const state = this.getState(scopeKey);
    logger.debug(
      `[QuestionManager] isActive check: ${state.isActive}, questions=${state.questions.length}, currentIndex=${state.currentIndex}`,
    );
    return state.isActive;
  }

  cancel(scopeKey?: string): void {
    logger.info("[QuestionManager] Poll cancelled");
    const state = this.getState(scopeKey);
    state.isActive = false;
    state.customInputQuestionIndex = null;
    state.activeMessageId = null;
  }

  clear(scopeKey?: string): void {
    this.states.set(this.normalizeScopeKey(scopeKey), createEmptyQuestionState());
  }

  getAllAnswers(scopeKey?: string): QuestionAnswer[] {
    const state = this.getState(scopeKey);
    const answers: QuestionAnswer[] = [];

    for (let i = 0; i < state.questions.length; i++) {
      const question = state.questions[i];
      const selectedAnswer = this.getSelectedAnswer(i, scopeKey);
      const customAnswer = this.getCustomAnswer(i, scopeKey);

      const finalAnswer = customAnswer || selectedAnswer;

      if (finalAnswer) {
        answers.push({
          question: question.question,
          answer: finalAnswer,
        });
      }
    }

    return answers;
  }
}

export const questionManager = new QuestionManager();
