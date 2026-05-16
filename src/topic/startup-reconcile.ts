import { getStoredAgent, resolveProjectAgent } from "../agent/manager.js";
import { SCOPE_CONTEXT, createScopeKeyFromParams, getScopeFromKey } from "../bot/scope.js";
import { TOPIC_COLORS } from "./colors.js";
import { clearAllInteractionState } from "../interaction/cleanup.js";
import { getStoredModel } from "../model/manager.js";
import { opencodeClient } from "../opencode/client.js";
import { setCurrentSession, type SessionInfo } from "../session/manager.js";
import {
  TOPIC_SESSION_STATUS,
  getScopedProjects,
  setCurrentAgent,
  setCurrentModel,
  setCurrentProject,
  type ProjectInfo,
} from "../settings/manager.js";
import { logger } from "../utils/logger.js";
import { getTopicBindingBySessionId, registerTopicSessionBinding } from "./manager.js";
import { formatTopicTitle } from "./title-format.js";

interface TopicCreateApi {
  createForumTopic: (
    chatId: number,
    name: string,
    options?: { icon_color?: (typeof TOPIC_COLORS)[keyof typeof TOPIC_COLORS] },
  ) => Promise<{ message_thread_id: number }>;
}

interface ForumProjectContext {
  chatId: number;
  sourceScopeKey: string;
  project: ProjectInfo;
}

interface SessionListItem {
  id: string;
  title: string;
  directory?: string;
}

function getStoredForumProjectContexts(): ForumProjectContext[] {
  const contexts: ForumProjectContext[] = [];
  const seen = new Set<string>();

  for (const [scopeKey, project] of Object.entries(getScopedProjects())) {
    const scope = getScopeFromKey(scopeKey);
    if (!scope || scope.context !== SCOPE_CONTEXT.GROUP_GENERAL) {
      continue;
    }

    const key = `${scope.chatId}:${project.id}:${project.worktree}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    contexts.push({ chatId: scope.chatId, sourceScopeKey: scope.key, project });
  }

  return contexts;
}

async function listProjectSessions(project: ProjectInfo): Promise<SessionListItem[]> {
  const { data: sessions, error } = await opencodeClient.session.list({
    directory: project.worktree,
    roots: true,
  });

  if (error || !sessions) {
    throw error || new Error("No session list received from OpenCode");
  }

  return sessions as SessionListItem[];
}

async function createTopicForSession(
  api: TopicCreateApi,
  context: ForumProjectContext,
  session: SessionListItem,
): Promise<boolean> {
  if (getTopicBindingBySessionId(session.id)) {
    return false;
  }

  const topicTitle = formatTopicTitle(session.title, session.id);
  const createdTopic = await api.createForumTopic(context.chatId, topicTitle, {
    icon_color: TOPIC_COLORS.BLUE,
  });
  const topicScopeKey = createScopeKeyFromParams({
    chatId: context.chatId,
    threadId: createdTopic.message_thread_id,
    context: SCOPE_CONTEXT.GROUP_TOPIC,
  });
  const sessionInfo: SessionInfo = {
    id: session.id,
    title: session.title,
    directory: session.directory || context.project.worktree,
  };

  setCurrentProject(context.project, topicScopeKey);
  setCurrentSession(sessionInfo, topicScopeKey);
  setCurrentAgent(
    await resolveProjectAgent(getStoredAgent(context.sourceScopeKey), context.sourceScopeKey),
    topicScopeKey,
  );
  setCurrentModel(getStoredModel(context.sourceScopeKey), topicScopeKey);
  registerTopicSessionBinding({
    scopeKey: topicScopeKey,
    chatId: context.chatId,
    threadId: createdTopic.message_thread_id,
    sessionId: session.id,
    projectId: context.project.id,
    projectWorktree: context.project.worktree,
    topicName: topicTitle,
    status: TOPIC_SESSION_STATUS.ACTIVE,
  });
  clearAllInteractionState("startup_topic_reconciled", topicScopeKey);
  return true;
}

export async function reconcileStoredSessionsWithForumTopics(
  api: TopicCreateApi,
  reason: string,
): Promise<void> {
  const contexts = getStoredForumProjectContexts();
  if (contexts.length === 0) {
    logger.debug(`[TopicStartup] No stored forum project contexts to reconcile: reason=${reason}`);
    return;
  }

  for (const context of contexts) {
    try {
      const sessions = await listProjectSessions(context.project);
      let createdCount = 0;

      for (const session of sessions) {
        if (await createTopicForSession(api, context, session)) {
          createdCount += 1;
        }
      }

      logger.info(
        `[TopicStartup] Reconciled forum topics: chat=${context.chatId}, project=${context.project.worktree}, created=${createdCount}, reason=${reason}`,
      );
    } catch (error) {
      logger.warn(
        `[TopicStartup] Failed to reconcile forum topics: chat=${context.chatId}, project=${context.project.worktree}, reason=${reason}`,
        error,
      );
    }
  }
}
