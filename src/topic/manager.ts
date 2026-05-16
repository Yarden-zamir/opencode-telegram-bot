import {
  TOPIC_SESSION_STATUS,
  clearTopicSessionBinding,
  findTopicSessionBindingByScopeKey,
  findTopicSessionBindingBySessionId,
  getCurrentProject,
  getScopedSessions,
  getTopicSessionBinding,
  getTopicSessionBindings,
  getTopicSessionBindingsByChat,
  setTopicSessionBinding,
  updateTopicSessionBindingStatus,
  type TopicSessionBinding,
  type TopicSessionStatus,
} from "../settings/manager.js";
import { SCOPE_CONTEXT, getScopeFromKey } from "../bot/scope.js";
import { logger } from "../utils/logger.js";

const BINDING_KEY_SEPARATOR = ":";
let hydratedFromScopedSessions = false;

export interface TopicBindingInput {
  scopeKey: string;
  chatId: number;
  threadId: number;
  sessionId: string;
  projectId: string;
  projectWorktree?: string;
  topicName?: string;
  status?: TopicSessionStatus;
}

export interface SessionRouteTarget {
  scopeKey: string;
  chatId: number;
  threadId: number | null;
}

export function createTopicBindingKey(chatId: number, threadId: number): string {
  return `${chatId}${BINDING_KEY_SEPARATOR}${threadId}`;
}

function buildBinding(input: TopicBindingInput, existing?: TopicSessionBinding): TopicSessionBinding {
  const timestamp = Date.now();

  return {
    scopeKey: input.scopeKey,
    chatId: input.chatId,
    threadId: input.threadId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    projectWorktree: input.projectWorktree,
    topicName: input.topicName,
    status: input.status ?? existing?.status ?? TOPIC_SESSION_STATUS.ACTIVE,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    closedAt: existing?.closedAt,
  };
}

function ensureTopicBindingsHydrated(): void {
  if (hydratedFromScopedSessions) {
    return;
  }

  hydratedFromScopedSessions = true;

  for (const [scopeKey, sessionInfo] of Object.entries(getScopedSessions())) {
    const scope = getScopeFromKey(scopeKey);
    if (!scope || scope.context !== SCOPE_CONTEXT.GROUP_TOPIC || scope.threadId === null) {
      continue;
    }

    const bindingKey = createTopicBindingKey(scope.chatId, scope.threadId);
    if (getTopicSessionBinding(bindingKey) || findTopicSessionBindingBySessionId(sessionInfo.id)) {
      continue;
    }

    const project = getCurrentProject(scopeKey);
    if (!project) {
      continue;
    }

    setTopicSessionBinding(bindingKey, {
      scopeKey,
      chatId: scope.chatId,
      threadId: scope.threadId,
      sessionId: sessionInfo.id,
      projectId: project.id,
      projectWorktree: project.worktree,
      status: TOPIC_SESSION_STATUS.ACTIVE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    logger.info(
      `[TopicManager] Hydrated binding from scoped session: scope=${scopeKey}, session=${sessionInfo.id}`,
    );
  }
}

export function registerTopicSessionBinding(input: TopicBindingInput): TopicSessionBinding {
  ensureTopicBindingsHydrated();

  const bindingKey = createTopicBindingKey(input.chatId, input.threadId);
  const existingByTopic = getTopicSessionBinding(bindingKey);

  if (existingByTopic && existingByTopic.sessionId !== input.sessionId) {
    throw new Error(
      `[TopicManager] Topic ${bindingKey} is already bound to session ${existingByTopic.sessionId}`,
    );
  }

  const existingBySession = findTopicSessionBindingBySessionId(input.sessionId);
  if (existingBySession) {
    const existingKey = createTopicBindingKey(existingBySession.chatId, existingBySession.threadId);
    if (existingKey !== bindingKey) {
      clearTopicSessionBinding(existingKey);
      logger.warn(
        `[TopicManager] Rebinding session ${input.sessionId} from topic ${existingKey} to ${bindingKey}`,
      );
    }
  }

  const nextBinding = buildBinding(input, existingByTopic);
  setTopicSessionBinding(bindingKey, nextBinding);
  return nextBinding;
}

export function getTopicBinding(chatId: number, threadId: number): TopicSessionBinding | undefined {
  ensureTopicBindingsHydrated();
  return getTopicSessionBinding(createTopicBindingKey(chatId, threadId));
}

export function getTopicBindingByScopeKey(scopeKey: string): TopicSessionBinding | undefined {
  ensureTopicBindingsHydrated();
  return findTopicSessionBindingByScopeKey(scopeKey);
}

export function getTopicBindingBySessionId(sessionId: string): TopicSessionBinding | undefined {
  ensureTopicBindingsHydrated();
  return findTopicSessionBindingBySessionId(sessionId);
}

export function getTopicBindingsByChat(chatId: number): TopicSessionBinding[] {
  ensureTopicBindingsHydrated();
  return getTopicSessionBindingsByChat(chatId);
}

export function listAllTopicBindings(): TopicSessionBinding[] {
  ensureTopicBindingsHydrated();
  return Object.values(getTopicSessionBindings());
}

export function updateTopicBindingStatus(
  chatId: number,
  threadId: number,
  status: TopicSessionStatus,
): void {
  ensureTopicBindingsHydrated();
  updateTopicSessionBindingStatus(createTopicBindingKey(chatId, threadId), status);
}

export function updateTopicBindingStatusBySessionId(
  sessionId: string,
  status: TopicSessionStatus,
): void {
  ensureTopicBindingsHydrated();
  const binding = findTopicSessionBindingBySessionId(sessionId);
  if (!binding) {
    return;
  }

  updateTopicSessionBindingStatus(createTopicBindingKey(binding.chatId, binding.threadId), status);
}

export function updateTopicBindingNameBySessionId(sessionId: string, topicName: string): void {
  ensureTopicBindingsHydrated();
  const binding = findTopicSessionBindingBySessionId(sessionId);
  if (!binding) {
    return;
  }

  setTopicSessionBinding(createTopicBindingKey(binding.chatId, binding.threadId), {
    ...binding,
    topicName,
    updatedAt: Date.now(),
  });
}

export function removeTopicBinding(chatId: number, threadId: number): void {
  ensureTopicBindingsHydrated();
  clearTopicSessionBinding(createTopicBindingKey(chatId, threadId));
}

export function getSessionRouteTarget(sessionId: string): SessionRouteTarget | null {
  ensureTopicBindingsHydrated();
  const binding = findTopicSessionBindingBySessionId(sessionId);
  if (binding && binding.status === TOPIC_SESSION_STATUS.ACTIVE) {
    return {
      scopeKey: binding.scopeKey,
      chatId: binding.chatId,
      threadId: binding.threadId,
    };
  }

  for (const [scopeKey, session] of Object.entries(getScopedSessions())) {
    if (session.id !== sessionId) {
      continue;
    }

    const scope = getScopeFromKey(scopeKey);
    if (!scope) {
      return null;
    }

    return {
      scopeKey,
      chatId: scope.chatId,
      threadId: scope.threadId,
    };
  }

  return null;
}

export function __resetTopicManagerForTests(): void {
  hydratedFromScopedSessions = false;
}
