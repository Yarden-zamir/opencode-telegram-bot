import type { ModelInfo } from "../model/types.js";
import {
  cloneScheduledTask,
  cloneScheduledTaskTopicBinding,
  type ScheduledTask,
  type ScheduledTaskTopicBinding,
} from "../scheduled-task/types.js";
import path from "node:path";
import { GLOBAL_SCOPE_KEY } from "../bot/scope.js";
import { getRuntimePaths } from "../runtime/paths.js";
import { logger } from "../utils/logger.js";

export interface ProjectInfo {
  id: string;
  worktree: string;
  name?: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
}

export interface SessionDirectoryCacheInfo {
  version: 1;
  lastSyncedUpdatedAt: number;
  directories: Array<{
    worktree: string;
    lastUpdated: number;
  }>;
}

export interface ScheduledTaskSessionIgnoreInfo {
  sessionId: string;
  createdAt: string;
}

export const TOPIC_SESSION_STATUS = {
  ACTIVE: "active",
  CLOSED: "closed",
  STALE: "stale",
  ABANDONED: "abandoned",
  ERROR: "error",
} as const;

export type TopicSessionStatus = (typeof TOPIC_SESSION_STATUS)[keyof typeof TOPIC_SESSION_STATUS];

export interface TopicSessionBinding {
  scopeKey: string;
  chatId: number;
  threadId: number;
  sessionId: string;
  projectId: string;
  projectWorktree?: string;
  topicName?: string;
  status: TopicSessionStatus;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface Settings {
  currentProject?: ProjectInfo;
  currentSession?: SessionInfo;
  currentAgent?: string;
  currentModel?: ModelInfo;
  pinnedMessageId?: number;
  ttsEnabled?: boolean;
  scopedProjects?: Record<string, ProjectInfo>;
  scopedSessions?: Record<string, SessionInfo>;
  scopedAgents?: Record<string, string>;
  scopedModels?: Record<string, ModelInfo>;
  scopedPinnedMessageIds?: Record<string, number>;
  scopedTtsEnabled?: Record<string, boolean>;
  topicSessionBindings?: Record<string, TopicSessionBinding>;
  sessionDirectoryCache?: SessionDirectoryCacheInfo;
  scheduledTasks?: ScheduledTask[];
  scheduledTaskTopics?: ScheduledTaskTopicBinding[];
  scheduledTaskSessionIgnores?: ScheduledTaskSessionIgnoreInfo[];
}

function cloneScheduledTasks(tasks: ScheduledTask[] | undefined): ScheduledTask[] | undefined {
  return tasks?.map((task) => cloneScheduledTask(task));
}

function cloneScheduledTaskSessionIgnores(
  ignores: ScheduledTaskSessionIgnoreInfo[] | undefined,
): ScheduledTaskSessionIgnoreInfo[] | undefined {
  return ignores?.map((ignore) => ({ ...ignore }));
}

function cloneScheduledTaskTopics(
  topics: ScheduledTaskTopicBinding[] | undefined,
): ScheduledTaskTopicBinding[] | undefined {
  return topics?.map((topic) => cloneScheduledTaskTopicBinding(topic));
}

function cloneProjectInfo(project: ProjectInfo): ProjectInfo {
  return { ...project };
}

function cloneSessionInfo(session: SessionInfo): SessionInfo {
  return { ...session };
}

function cloneModelInfo(model: ModelInfo): ModelInfo {
  return { ...model };
}

function cloneTopicSessionBinding(binding: TopicSessionBinding): TopicSessionBinding {
  return { ...binding };
}

function cloneRecord<T>(record: Record<string, T> | undefined, clone: (value: T) => T): Record<string, T> | undefined {
  if (!record) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, clone(value)]));
}

function normalizeScopeKey(scopeKey?: string): string {
  return scopeKey && scopeKey !== GLOBAL_SCOPE_KEY ? scopeKey : GLOBAL_SCOPE_KEY;
}

function isGlobalScope(scopeKey?: string): boolean {
  return normalizeScopeKey(scopeKey) === GLOBAL_SCOPE_KEY;
}

function setScopedValue<T>(
  recordName: keyof Settings,
  scopeKey: string | undefined,
  value: T | undefined,
): void {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  if (normalizedScopeKey === GLOBAL_SCOPE_KEY) {
    return;
  }

  const record = ((currentSettings[recordName] as Record<string, T> | undefined) ?? {}) as Record<
    string,
    T
  >;

  if (value === undefined) {
    delete record[normalizedScopeKey];
  } else {
    record[normalizedScopeKey] = value;
  }

  currentSettings[recordName] = Object.keys(record).length > 0 ? (record as never) : undefined;
}

function getScopedValue<T>(record: Record<string, T> | undefined, scopeKey: string | undefined): T | undefined {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  return normalizedScopeKey === GLOBAL_SCOPE_KEY ? undefined : record?.[normalizedScopeKey];
}

function getSettingsFilePath(): string {
  return getRuntimePaths().settingsFilePath;
}

async function readSettingsFile(): Promise<Settings> {
  try {
    const fs = await import("fs/promises");
    const content = await fs.readFile(getSettingsFilePath(), "utf-8");
    return JSON.parse(content) as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error("[SettingsManager] Error reading settings file:", error);
    }
    return {};
  }
}

let settingsWriteQueue: Promise<void> = Promise.resolve();

function writeSettingsFile(settings: Settings): Promise<void> {
  settingsWriteQueue = settingsWriteQueue
    .catch(() => {
      // Keep write queue alive after failed writes.
    })
    .then(async () => {
      try {
        const fs = await import("fs/promises");
        const settingsFilePath = getSettingsFilePath();
        await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
        await fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2));
      } catch (err) {
        logger.error("[SettingsManager] Error writing settings file:", err);
      }
    });

  return settingsWriteQueue;
}

let currentSettings: Settings = {};

export function getCurrentProject(scopeKey?: string): ProjectInfo | undefined {
  if (isGlobalScope(scopeKey)) {
    return currentSettings.currentProject ? cloneProjectInfo(currentSettings.currentProject) : undefined;
  }

  const project = getScopedValue(currentSettings.scopedProjects, scopeKey);
  return project ? cloneProjectInfo(project) : undefined;
}

export function setCurrentProject(projectInfo: ProjectInfo, scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.currentProject = cloneProjectInfo(projectInfo);
  } else {
    setScopedValue("scopedProjects", scopeKey, cloneProjectInfo(projectInfo));
  }
  void writeSettingsFile(currentSettings);
}

export function clearProject(scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.currentProject = undefined;
  } else {
    setScopedValue("scopedProjects", scopeKey, undefined);
  }
  void writeSettingsFile(currentSettings);
}

export function getCurrentSession(scopeKey?: string): SessionInfo | undefined {
  if (isGlobalScope(scopeKey)) {
    return currentSettings.currentSession ? cloneSessionInfo(currentSettings.currentSession) : undefined;
  }

  const session = getScopedValue(currentSettings.scopedSessions, scopeKey);
  return session ? cloneSessionInfo(session) : undefined;
}

export function setCurrentSession(sessionInfo: SessionInfo, scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.currentSession = cloneSessionInfo(sessionInfo);
  } else {
    setScopedValue("scopedSessions", scopeKey, cloneSessionInfo(sessionInfo));
  }
  void writeSettingsFile(currentSettings);
}

export function clearSession(scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.currentSession = undefined;
  } else {
    setScopedValue("scopedSessions", scopeKey, undefined);
  }
  void writeSettingsFile(currentSettings);
}

export function isTtsEnabled(scopeKey?: string): boolean {
  if (isGlobalScope(scopeKey)) {
    return currentSettings.ttsEnabled === true;
  }

  return getScopedValue(currentSettings.scopedTtsEnabled, scopeKey) === true;
}

export function setTtsEnabled(enabled: boolean, scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.ttsEnabled = enabled;
  } else {
    setScopedValue("scopedTtsEnabled", scopeKey, enabled);
  }
  void writeSettingsFile(currentSettings);
}

export function getCurrentAgent(scopeKey?: string): string | undefined {
  return isGlobalScope(scopeKey)
    ? currentSettings.currentAgent
    : getScopedValue(currentSettings.scopedAgents, scopeKey);
}

export function setCurrentAgent(agentName: string, scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.currentAgent = agentName;
  } else {
    setScopedValue("scopedAgents", scopeKey, agentName);
  }
  void writeSettingsFile(currentSettings);
}

export function clearCurrentAgent(scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.currentAgent = undefined;
  } else {
    setScopedValue("scopedAgents", scopeKey, undefined);
  }
  void writeSettingsFile(currentSettings);
}

export function getCurrentModel(scopeKey?: string): ModelInfo | undefined {
  if (isGlobalScope(scopeKey)) {
    return currentSettings.currentModel ? cloneModelInfo(currentSettings.currentModel) : undefined;
  }

  const model = getScopedValue(currentSettings.scopedModels, scopeKey);
  return model ? cloneModelInfo(model) : undefined;
}

export function setCurrentModel(modelInfo: ModelInfo, scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.currentModel = cloneModelInfo(modelInfo);
  } else {
    setScopedValue("scopedModels", scopeKey, cloneModelInfo(modelInfo));
  }
  void writeSettingsFile(currentSettings);
}

export function clearCurrentModel(scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.currentModel = undefined;
  } else {
    setScopedValue("scopedModels", scopeKey, undefined);
  }
  void writeSettingsFile(currentSettings);
}

export function getPinnedMessageId(scopeKey?: string): number | undefined {
  return isGlobalScope(scopeKey)
    ? currentSettings.pinnedMessageId
    : getScopedValue(currentSettings.scopedPinnedMessageIds, scopeKey);
}

export function setPinnedMessageId(messageId: number, scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.pinnedMessageId = messageId;
  } else {
    setScopedValue("scopedPinnedMessageIds", scopeKey, messageId);
  }
  void writeSettingsFile(currentSettings);
}

export function clearPinnedMessageId(scopeKey?: string): void {
  if (isGlobalScope(scopeKey)) {
    currentSettings.pinnedMessageId = undefined;
  } else {
    setScopedValue("scopedPinnedMessageIds", scopeKey, undefined);
  }
  void writeSettingsFile(currentSettings);
}

export function getScopedSessions(): Record<string, SessionInfo> {
  return cloneRecord(currentSettings.scopedSessions, cloneSessionInfo) ?? {};
}

export function getTopicSessionBindings(): Record<string, TopicSessionBinding> {
  return cloneRecord(currentSettings.topicSessionBindings, cloneTopicSessionBinding) ?? {};
}

export function getTopicSessionBinding(bindingKey: string): TopicSessionBinding | undefined {
  const binding = currentSettings.topicSessionBindings?.[bindingKey];
  return binding ? cloneTopicSessionBinding(binding) : undefined;
}

export function getTopicSessionBindingsByChat(chatId: number): TopicSessionBinding[] {
  return Object.values(currentSettings.topicSessionBindings ?? {})
    .filter((binding) => binding.chatId === chatId)
    .map((binding) => cloneTopicSessionBinding(binding));
}

export function findTopicSessionBindingByScopeKey(scopeKey: string): TopicSessionBinding | undefined {
  const binding = Object.values(currentSettings.topicSessionBindings ?? {}).find(
    (candidate) => candidate.scopeKey === scopeKey,
  );
  return binding ? cloneTopicSessionBinding(binding) : undefined;
}

export function findTopicSessionBindingBySessionId(sessionId: string): TopicSessionBinding | undefined {
  const binding = Object.values(currentSettings.topicSessionBindings ?? {}).find(
    (candidate) => candidate.sessionId === sessionId,
  );
  return binding ? cloneTopicSessionBinding(binding) : undefined;
}

export function setTopicSessionBinding(bindingKey: string, binding: TopicSessionBinding): void {
  currentSettings.topicSessionBindings ??= {};
  currentSettings.topicSessionBindings[bindingKey] = cloneTopicSessionBinding(binding);
  void writeSettingsFile(currentSettings);
}

export function clearTopicSessionBinding(bindingKey: string): void {
  if (!currentSettings.topicSessionBindings) {
    return;
  }

  delete currentSettings.topicSessionBindings[bindingKey];
  if (Object.keys(currentSettings.topicSessionBindings).length === 0) {
    currentSettings.topicSessionBindings = undefined;
  }
  void writeSettingsFile(currentSettings);
}

export function updateTopicSessionBindingStatus(
  bindingKey: string,
  status: TopicSessionStatus,
): void {
  const binding = currentSettings.topicSessionBindings?.[bindingKey];
  if (!binding) {
    return;
  }

  currentSettings.topicSessionBindings![bindingKey] = {
    ...binding,
    status,
    updatedAt: Date.now(),
    ...(status === TOPIC_SESSION_STATUS.CLOSED || status === TOPIC_SESSION_STATUS.STALE
      ? { closedAt: Date.now() }
      : {}),
  };
  void writeSettingsFile(currentSettings);
}

export function getSessionDirectoryCache(): SessionDirectoryCacheInfo | undefined {
  return currentSettings.sessionDirectoryCache;
}

export function setSessionDirectoryCache(cache: SessionDirectoryCacheInfo): Promise<void> {
  currentSettings.sessionDirectoryCache = cache;
  return writeSettingsFile(currentSettings);
}

export function clearSessionDirectoryCache(): void {
  currentSettings.sessionDirectoryCache = undefined;
  void writeSettingsFile(currentSettings);
}

export function getScheduledTasks(): ScheduledTask[] {
  return cloneScheduledTasks(currentSettings.scheduledTasks) ?? [];
}

export function setScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  currentSettings.scheduledTasks = cloneScheduledTasks(tasks);
  return writeSettingsFile(currentSettings);
}

export function getScheduledTaskTopics(): ScheduledTaskTopicBinding[] {
  return cloneScheduledTaskTopics(currentSettings.scheduledTaskTopics) ?? [];
}

export function setScheduledTaskTopics(topics: ScheduledTaskTopicBinding[]): Promise<void> {
  currentSettings.scheduledTaskTopics = cloneScheduledTaskTopics(topics);
  return writeSettingsFile(currentSettings);
}

export function getScheduledTaskSessionIgnores(): ScheduledTaskSessionIgnoreInfo[] {
  return cloneScheduledTaskSessionIgnores(currentSettings.scheduledTaskSessionIgnores) ?? [];
}

export function setScheduledTaskSessionIgnores(
  ignores: ScheduledTaskSessionIgnoreInfo[],
): Promise<void> {
  currentSettings.scheduledTaskSessionIgnores = cloneScheduledTaskSessionIgnores(ignores);
  return writeSettingsFile(currentSettings);
}

export function __resetSettingsForTests(): void {
  currentSettings = {};
  settingsWriteQueue = Promise.resolve();
}

export function __flushSettingsForTests(): Promise<void> {
  return settingsWriteQueue;
}

export async function loadSettings(): Promise<void> {
  const loadedSettings = (await readSettingsFile()) as Settings & {
    serverProcess?: unknown;
    toolMessagesIntervalSec?: unknown;
  };

  let requiresRewrite = false;

  if ("toolMessagesIntervalSec" in loadedSettings) {
    delete loadedSettings.toolMessagesIntervalSec;
    requiresRewrite = true;
  }

  if ("serverProcess" in loadedSettings) {
    delete loadedSettings.serverProcess;
    requiresRewrite = true;
  }

  currentSettings = loadedSettings;
  currentSettings.scheduledTasks = cloneScheduledTasks(loadedSettings.scheduledTasks) ?? [];
  currentSettings.scheduledTaskTopics = cloneScheduledTaskTopics(loadedSettings.scheduledTaskTopics) ?? [];
  currentSettings.scheduledTaskSessionIgnores =
    cloneScheduledTaskSessionIgnores(loadedSettings.scheduledTaskSessionIgnores) ?? [];
  currentSettings.scopedProjects = cloneRecord(loadedSettings.scopedProjects, cloneProjectInfo);
  currentSettings.scopedSessions = cloneRecord(loadedSettings.scopedSessions, cloneSessionInfo);
  currentSettings.scopedAgents = loadedSettings.scopedAgents ? { ...loadedSettings.scopedAgents } : undefined;
  currentSettings.scopedModels = cloneRecord(loadedSettings.scopedModels, cloneModelInfo);
  currentSettings.scopedPinnedMessageIds = loadedSettings.scopedPinnedMessageIds
    ? { ...loadedSettings.scopedPinnedMessageIds }
    : undefined;
  currentSettings.scopedTtsEnabled = loadedSettings.scopedTtsEnabled
    ? { ...loadedSettings.scopedTtsEnabled }
    : undefined;
  currentSettings.topicSessionBindings = cloneRecord(
    loadedSettings.topicSessionBindings,
    cloneTopicSessionBinding,
  );

  if (requiresRewrite) {
    void writeSettingsFile(currentSettings);
  }
}
