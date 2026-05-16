import type { Api } from "grammy";
import { logger } from "../utils/logger.js";
import { opencodeClient } from "../opencode/client.js";
import { getGitWorktreeContext } from "../git/worktree.js";
import { getCurrentSession } from "../session/manager.js";
import {
  getCurrentProject,
  getPinnedMessageId,
  setPinnedMessageId,
  clearPinnedMessageId,
} from "../settings/manager.js";
import { getStoredModel } from "../model/manager.js";
import { getModelContextLimit } from "../model/context-limit.js";
import { isExpectedOpencodeUnavailableError } from "../utils/opencode-error.js";
import type { FileChange, PinnedMessageState, TokensInfo } from "./types.js";
import { t } from "../i18n/index.js";
import {
  DEFAULT_CONTEXT_LIMIT,
  formatContextLine,
  formatCostLine,
  formatModelDisplayName,
} from "./format.js";
import { GLOBAL_SCOPE_KEY, getMessageThreadId, getOptionalThreadSendOptions } from "../bot/scope.js";

interface PinnedScopeContext {
  api: Api | null;
  chatId: number | null;
  threadId: number | null;
  state: PinnedMessageState;
  contextLimit: number | null;
  updateDebounceTimer: ReturnType<typeof setTimeout> | null;
  updateTask: Promise<void> | null;
  pendingUpdate: boolean;
  pendingForceUpdate: boolean;
  lastRenderedMessageText: string | null;
}

class PinnedMessageManager {
  private contexts = new Map<string, PinnedScopeContext>();
  private onKeyboardUpdateCallback?: (
    tokensUsed: number,
    tokensLimit: number,
    scopeKey?: string,
  ) => void;

  private createDefaultState(): PinnedMessageState {
    return {
      messageId: null,
      chatId: null,
      threadId: null,
      sessionId: null,
      sessionTitle: t("pinned.default_session_title"),
      attachActive: false,
      attachBusy: false,
      projectPath: "",
      projectBranch: null,
      projectWorktreePath: null,
      tokensUsed: 0,
      tokensLimit: 0,
      lastUpdated: 0,
      changedFiles: [],
      cost: 0,
    };
  }

  private normalizeScopeKey(scopeKey?: string): string {
    return scopeKey ?? GLOBAL_SCOPE_KEY;
  }

  private getContext(scopeKey?: string): PinnedScopeContext {
    const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
    const existing = this.contexts.get(normalizedScopeKey);
    if (existing) {
      return existing;
    }

    const savedMessageId = getPinnedMessageId(normalizedScopeKey);
    const context: PinnedScopeContext = {
      api: null,
      chatId: null,
      threadId: null,
      state: {
        ...this.createDefaultState(),
        messageId: savedMessageId ?? null,
      },
      contextLimit: null,
      updateDebounceTimer: null,
      updateTask: null,
      pendingUpdate: false,
      pendingForceUpdate: false,
      lastRenderedMessageText: null,
    };
    this.contexts.set(normalizedScopeKey, context);
    return context;
  }

  private resetContextState(context: PinnedScopeContext): void {
    context.state = {
      ...this.createDefaultState(),
      chatId: context.chatId,
      threadId: context.threadId,
    };
    context.lastRenderedMessageText = null;
    context.pendingUpdate = false;
    context.pendingForceUpdate = false;
  }

  private emitKeyboardUpdate(tokensUsed: number, tokensLimit: number, scopeKey?: string): void {
    if (!this.onKeyboardUpdateCallback) {
      return;
    }

    if (scopeKey) {
      this.onKeyboardUpdateCallback(tokensUsed, tokensLimit, scopeKey);
    } else {
      this.onKeyboardUpdateCallback(tokensUsed, tokensLimit);
    }
  }

  /**
   * Initialize manager with bot API and chat ID
   */
  initialize(api: Api, chatId: number, scopeKey?: string, threadId?: number | null): void {
    const context = this.getContext(scopeKey);
    const messageThreadId = getMessageThreadId(threadId ?? null);
    context.api = api;
    context.chatId = chatId;
    context.threadId = messageThreadId;
    context.state.chatId = chatId;
    context.state.threadId = messageThreadId;

    const savedMessageId = getPinnedMessageId(this.normalizeScopeKey(scopeKey));
    if (savedMessageId) {
      context.state.messageId = savedMessageId;
    }
  }

  /**
   * Called when session changes - create new pinned message
   */
  async onSessionChange(sessionId: string, sessionTitle: string, scopeKey?: string): Promise<void> {
    logger.info(`[PinnedManager] Session changed: ${sessionId}, title: ${sessionTitle}`);
    const context = this.getContext(scopeKey);
    const state = context.state;

    // Reset tokens for new session
    state.tokensUsed = 0;
    state.cost = 0;

    // Update state
    state.sessionId = sessionId;
    state.sessionTitle = sessionTitle || t("pinned.default_session_title");
    state.attachActive = false;
    state.attachBusy = false;

    await this.refreshProjectMetadata(scopeKey);

    // Fetch context limit for current model
    await this.fetchContextLimit(scopeKey);

    // Trigger keyboard update callback with reset context (0 tokens)
    if (this.onKeyboardUpdateCallback && state.tokensLimit > 0) {
      this.emitKeyboardUpdate(state.tokensUsed, state.tokensLimit, scopeKey);
    }

    // Reset changed files for new session
    state.changedFiles = [];
    context.lastRenderedMessageText = null;
    context.pendingUpdate = false;
    context.pendingForceUpdate = false;

    // Unpin old message and create new one
    await this.unpinOldMessage(scopeKey);
    await this.createPinnedMessage(scopeKey);

    // Load existing diffs from API (for session restoration)
    await this.loadDiffsFromApi(sessionId, scopeKey);
  }

  /**
   * Restore in-memory state for a persisted pinned message without creating a new Telegram message.
   */
  async restoreExistingSession(
    sessionId: string,
    sessionTitle: string,
    scopeKey?: string,
  ): Promise<void> {
    logger.info(`[PinnedManager] Restoring existing pinned message for session: ${sessionId}`);
    const context = this.getContext(scopeKey);
    const state = context.state;

    state.sessionId = sessionId;
    state.sessionTitle = sessionTitle || t("pinned.default_session_title");
    state.attachActive = false;
    state.attachBusy = false;
    state.changedFiles = [];
    context.lastRenderedMessageText = null;
    context.pendingUpdate = false;
    context.pendingForceUpdate = false;

    await this.refreshProjectMetadata(scopeKey);
    await this.fetchContextLimit(scopeKey);

    if (this.onKeyboardUpdateCallback && state.tokensLimit > 0) {
      this.emitKeyboardUpdate(state.tokensUsed, state.tokensLimit, scopeKey);
    }

    await this.updatePinnedMessage(scopeKey, true);
    await this.loadDiffsFromApi(sessionId, scopeKey);
  }

  /**
   * Called when session title is updated (after first message)
   */
  async onSessionTitleUpdate(newTitle: string, scopeKey?: string): Promise<void> {
    const state = this.getContext(scopeKey).state;
    if (state.sessionTitle !== newTitle && newTitle) {
      logger.debug(`[PinnedManager] Session title updated: ${newTitle}`);
      state.sessionTitle = newTitle;
      await this.updatePinnedMessage(scopeKey);
    }
  }

  async setAttachState(active: boolean, busy: boolean, scopeKey?: string): Promise<void> {
    const state = this.getContext(scopeKey).state;
    const nextBusy = active ? busy : false;
    if (state.attachActive === active && state.attachBusy === nextBusy) {
      return;
    }

    state.attachActive = active;
    state.attachBusy = nextBusy;
    await this.updatePinnedMessage(scopeKey);
  }

  /**
   * Load context token usage from session history
   */
  async loadContextFromHistory(
    sessionId: string,
    directory: string,
    scopeKey?: string,
  ): Promise<void> {
    try {
      logger.debug(`[PinnedManager] Loading context from history for session: ${sessionId}`);
      const state = this.getContext(scopeKey).state;

      const { data: messagesData, error } = await opencodeClient.session.messages({
        sessionID: sessionId,
        directory,
      });

      if (error || !messagesData) {
        if (isExpectedOpencodeUnavailableError(error)) {
          logger.warn("[PinnedManager] OpenCode server unavailable; skipping session history load");
        } else {
          logger.warn("[PinnedManager] Failed to load session history:", error);
        }
        return;
      }

      // Get the maximum context size and total cost from session history
      // Context = input + cache.read (cache.read contains previously cached context)
      let maxContextSize = 0;
      let totalCost = 0;
      logger.debug(`[PinnedManager] Processing ${messagesData.length} messages from history`);

      messagesData.forEach(({ info }) => {
        if (info.role === "assistant") {
          const assistantInfo = info as {
            summary?: boolean;
            tokens?: {
              input: number;
              cache?: { read: number };
            };
            cost?: number;
          };

          // Skip summary messages (technical, not real agent responses)
          if (assistantInfo.summary) {
            logger.debug(`[PinnedManager] Skipping summary message`);
            return;
          }

          const input = assistantInfo.tokens?.input || 0;
          const cacheRead = assistantInfo.tokens?.cache?.read || 0;
          const contextSize = input + cacheRead;
          const cost = assistantInfo.cost || 0;

          logger.debug(
            `[PinnedManager] Assistant message: input=${input}, cache.read=${cacheRead}, total=${contextSize}, cost=$${cost.toFixed(2)}`,
          );

          // Keep track of maximum context size (peak usage in session)
          if (contextSize > maxContextSize) {
            maxContextSize = contextSize;
          }

          // Accumulate total session cost
          totalCost += cost;
        }
      });

      state.tokensUsed = maxContextSize;
      state.cost = totalCost;
      state.sessionId = sessionId;

      logger.info(
        `[PinnedManager] Loaded context from history: ${state.tokensUsed} tokens, cost: $${state.cost.toFixed(2)}`,
      );

      await this.updatePinnedMessage(scopeKey);
    } catch (err) {
      if (isExpectedOpencodeUnavailableError(err)) {
        logger.warn("[PinnedManager] OpenCode server unavailable; skipping session history load");
      } else {
        logger.error("[PinnedManager] Error loading context from history:", err);
      }
    }
  }

  /**
   * Called when session is compacted - reload context from history
   */
  async onSessionCompacted(sessionId: string, directory: string, scopeKey?: string): Promise<void> {
    logger.info(`[PinnedManager] Session compacted, reloading context: ${sessionId}`);

    // Reload context from updated history (after compaction)
    await this.loadContextFromHistory(sessionId, directory, scopeKey);
  }

  /**
   * Called when assistant message completes with token info
   */
  async onMessageComplete(tokens: TokensInfo, scopeKey?: string): Promise<void> {
    // Ensure context limit is available even if session was restored
    // without a fresh onSessionChange call (for example after /abort + continue).
    if (this.getContextLimit(scopeKey) === 0) {
      await this.fetchContextLimit(scopeKey);
    }
    const state = this.getContext(scopeKey).state;

    // Context = input + cache.read (cache.read contains previously cached context)
    // This represents the actual context window usage
    state.tokensUsed = tokens.input + tokens.cacheRead;

    logger.debug(
      `[PinnedManager] Tokens updated: ${state.tokensUsed}/${state.tokensLimit}`,
    );

    // Also fetch latest session title (it may have changed after first message)
    await this.refreshSessionTitle(scopeKey);

    await this.updatePinnedMessage(scopeKey);
  }

  /**
   * Update tokens in memory without triggering an API call.
   * Used for intermediate (non-completed) message.updated events
   * to keep pinned state in sync with keyboardManager.
   */
  updateTokensSilent(tokens: TokensInfo, scopeKey?: string): void {
    const state = this.getContext(scopeKey).state;
    state.tokensUsed = tokens.input + tokens.cacheRead;
    logger.debug(
      `[PinnedManager] Tokens updated (silent): ${state.tokensUsed}/${state.tokensLimit}`,
    );
  }

  /**
   * Refresh the pinned message with current in-memory state.
   * Used at thinking time to push accumulated silent updates to Telegram.
   */
  async refresh(scopeKey?: string): Promise<void> {
    await this.refreshProjectMetadata(scopeKey);
    await this.updatePinnedMessage(scopeKey, true);
  }

  /**
   * Called when cost info is received from SSE events
   */
  async onCostUpdate(cost: number, scopeKey?: string): Promise<void> {
    if (!Number.isFinite(cost) || cost === 0) {
      logger.debug("[PinnedManager] Ignoring non-impacting cost update");
      return;
    }

    const state = this.getContext(scopeKey).state;
    const currentCost = state.cost || 0;
    state.cost = currentCost + cost;
    logger.debug(
      `[PinnedManager] Cost added: $${cost.toFixed(2)}, total session: $${(state.cost || 0).toFixed(2)}`,
    );
    await this.updatePinnedMessage(scopeKey);
  }

  /**
   * Set callback for keyboard updates when context changes
   */
  setOnKeyboardUpdate(
    callback: (tokensUsed: number, tokensLimit: number, scopeKey?: string) => void,
    scopeKey?: string,
  ): void {
    this.onKeyboardUpdateCallback = callback;
    logger.debug("[PinnedManager] Keyboard update callback registered");
    const context = this.getContext(scopeKey);

    // Fire immediately with current state to fix race condition:
    // onSessionChange may have already run before this callback was registered.
    const limit = context.state.tokensLimit > 0 ? context.state.tokensLimit : context.contextLimit || 0;
    if (limit > 0) {
      if (scopeKey) {
        callback(context.state.tokensUsed, limit, scopeKey);
      } else {
        callback(context.state.tokensUsed, limit);
      }
    }
  }

  /**
   * Get current context information
   */
  getContextInfo(scopeKey?: string): { tokensUsed: number; tokensLimit: number } | null {
    // Use cached contextLimit if tokensLimit is not set yet
    const context = this.getContext(scopeKey);
    const limit = context.state.tokensLimit > 0 ? context.state.tokensLimit : context.contextLimit || 0;
    if (limit === 0) {
      return null;
    }
    return {
      tokensUsed: context.state.tokensUsed,
      tokensLimit: limit,
    };
  }

  /**
   * Get context limit (for keyboard display when no session)
   * Returns cached limit or 0 if not available
   */
  getContextLimit(scopeKey?: string): number {
    const context = this.getContext(scopeKey);
    return context.contextLimit || context.state.tokensLimit || 0;
  }

  /**
   * Refresh context limit for current model (call after model change)
   */
  async refreshContextLimit(scopeKey?: string): Promise<void> {
    await this.fetchContextLimit(scopeKey);
  }

  /**
   * Called when session.diff SSE event is received.
   * Only overwrites if non-empty (API may return empty while tool events collected data).
   */
  async onSessionDiff(diffs: FileChange[], scopeKey?: string): Promise<void> {
    const state = this.getContext(scopeKey).state;
    if (diffs.length === 0 && state.changedFiles.length > 0) {
      logger.debug("[PinnedManager] Ignoring empty session.diff, keeping tool-collected data");
      return;
    }

    if (this.areFileDiffsEqual(state.changedFiles, diffs)) {
      logger.debug("[PinnedManager] Ignoring unchanged session.diff");
      return;
    }

    state.changedFiles = diffs;
    logger.debug(`[PinnedManager] Session diff updated: ${diffs.length} files`);
    await this.updatePinnedMessage(scopeKey);
  }

  /**
   * Called when a single file is changed (from tool events: edit/write)
   */
  addFileChange(change: FileChange, scopeKey?: string): void {
    const state = this.getContext(scopeKey).state;
    const existing = state.changedFiles.find((f) => f.file === change.file);
    if (existing) {
      existing.additions += change.additions;
      existing.deletions += change.deletions;
    } else {
      state.changedFiles.push(change);
    }
    logger.debug(
      `[PinnedManager] File change added: ${change.file} (+${change.additions} -${change.deletions}), total: ${state.changedFiles.length}`,
    );

    // Schedule debounced update (avoid spamming Telegram API on rapid tool events)
    this.scheduleDebouncedUpdate(scopeKey);
  }

  private scheduleDebouncedUpdate(scopeKey?: string): void {
    const context = this.getContext(scopeKey);
    if (context.updateDebounceTimer) {
      clearTimeout(context.updateDebounceTimer);
    }
    context.updateDebounceTimer = setTimeout(() => {
      context.updateDebounceTimer = null;
      void this.updatePinnedMessage(scopeKey);
    }, 1000);
  }

  /**
   * Load file diffs from API for current session.
   * Tries session.diff() first, falls back to parsing session.messages() tool parts.
   */
  private async loadDiffsFromApi(sessionId: string, scopeKey?: string): Promise<void> {
    try {
      const project = getCurrentProject(scopeKey);
      if (!project) {
        logger.debug("[PinnedManager] loadDiffsFromApi: no project");
        return;
      }

      logger.debug(`[PinnedManager] loadDiffsFromApi: trying session.diff() for ${sessionId}`);

      // Try session.diff() API first
      const { data, error } = await opencodeClient.session.diff({
        sessionID: sessionId,
        directory: project.worktree,
      });

      logger.debug(
        `[PinnedManager] session.diff() result: error=${!!error}, data.length=${data?.length ?? 0}`,
      );

      if (!error && data && data.length > 0) {
          this.getContext(scopeKey).state.changedFiles = data.map((d) => ({
            file: d.file,
            additions: d.additions,
            deletions: d.deletions,
        }));
        logger.info(
            `[PinnedManager] Loaded ${this.getContext(scopeKey).state.changedFiles.length} file diffs from session.diff()`,
          );
        await this.updatePinnedMessage(scopeKey);
        return;
      }

      // Fallback: parse tool parts from session messages
      logger.debug("[PinnedManager] session.diff() empty, trying loadDiffsFromMessages()");
      await this.loadDiffsFromMessages(sessionId, project.worktree, scopeKey);
    } catch (err) {
      if (isExpectedOpencodeUnavailableError(err)) {
        logger.debug("[PinnedManager] OpenCode server unavailable; skipping diff restore");
      } else {
        logger.debug("[PinnedManager] Could not load diffs from API:", err);
      }
    }
  }

  /**
   * Fallback: extract file changes from session message tool parts
   */
  private async loadDiffsFromMessages(
    sessionId: string,
    directory: string,
    scopeKey?: string,
  ): Promise<void> {
    try {
      logger.debug(`[PinnedManager] loadDiffsFromMessages: fetching messages for ${sessionId}`);

      const { data: messagesData, error } = await opencodeClient.session.messages({
        sessionID: sessionId,
        directory,
      });

      if (error || !messagesData) {
        if (isExpectedOpencodeUnavailableError(error)) {
          logger.debug("[PinnedManager] OpenCode server unavailable; skipping diff message restore");
        } else {
          logger.debug(`[PinnedManager] loadDiffsFromMessages: error or no data`);
        }
        return;
      }

      logger.debug(`[PinnedManager] loadDiffsFromMessages: ${messagesData.length} messages`);

      const filesMap = new Map<string, FileChange>();

      let toolCount = 0;
      let fileToolCount = 0;

      for (const { parts } of messagesData) {
        for (const part of parts) {
          if (part.type !== "tool") continue;
          toolCount++;

          const toolPart = part as {
            tool: string;
            state: {
              status: string;
              input?: { [key: string]: unknown };
              metadata?: { [key: string]: unknown };
            };
          };

          if (toolPart.state.status !== "completed") continue;

          if (
            toolPart.tool === "edit" ||
            toolPart.tool === "write" ||
            toolPart.tool === "apply_patch"
          ) {
            fileToolCount++;
          }

          if (
            (toolPart.tool === "edit" || toolPart.tool === "apply_patch") &&
            toolPart.state.metadata &&
            "filediff" in toolPart.state.metadata
          ) {
            const filediff = toolPart.state.metadata.filediff as {
              file?: string;
              additions?: number;
              deletions?: number;
            };
            if (filediff.file) {
              const existing = filesMap.get(filediff.file);
              if (existing) {
                existing.additions += filediff.additions || 0;
                existing.deletions += filediff.deletions || 0;
              } else {
                filesMap.set(filediff.file, {
                  file: filediff.file,
                  additions: filediff.additions || 0,
                  deletions: filediff.deletions || 0,
                });
              }
            }
          } else if (
            toolPart.tool === "write" &&
            toolPart.state.input &&
            "filePath" in toolPart.state.input &&
            "content" in toolPart.state.input
          ) {
            const filePath = toolPart.state.input.filePath as string;
            const content = toolPart.state.input.content as string;
            const lines = content.split("\n").length;
            const existing = filesMap.get(filePath);
            if (existing) {
              existing.additions += lines;
            } else {
              filesMap.set(filePath, {
                file: filePath,
                additions: lines,
                deletions: 0,
              });
            }
          }
        }
      }

      logger.debug(
        `[PinnedManager] loadDiffsFromMessages: found ${toolCount} tool parts, ${fileToolCount} file tools`,
      );

      if (filesMap.size > 0) {
        this.getContext(scopeKey).state.changedFiles = Array.from(filesMap.values());
        logger.info(
          `[PinnedManager] Loaded ${this.getContext(scopeKey).state.changedFiles.length} file diffs from messages`,
        );
        await this.updatePinnedMessage(scopeKey);
      } else {
        logger.debug("[PinnedManager] loadDiffsFromMessages: no file changes found");
      }
    } catch (err) {
      if (isExpectedOpencodeUnavailableError(err)) {
        logger.debug("[PinnedManager] OpenCode server unavailable; skipping diff message restore");
      } else {
        logger.debug("[PinnedManager] Could not load diffs from messages:", err);
      }
    }
  }

  /**
   * Refresh session title from API
   */
  private async refreshSessionTitle(scopeKey?: string): Promise<void> {
    const session = getCurrentSession(scopeKey);
    const project = getCurrentProject(scopeKey);
    const state = this.getContext(scopeKey).state;

    if (!session || !project) {
      return;
    }

    try {
      const { data: sessionData } = await opencodeClient.session.get({
        sessionID: session.id,
        directory: project.worktree,
      });

      if (sessionData && sessionData.title !== state.sessionTitle) {
        state.sessionTitle = sessionData.title;
        logger.debug(`[PinnedManager] Session title refreshed: ${sessionData.title}`);
      }
    } catch (err) {
      if (isExpectedOpencodeUnavailableError(err)) {
        logger.debug("[PinnedManager] OpenCode server unavailable; skipping session title refresh");
      } else {
        logger.debug("[PinnedManager] Could not refresh session title:", err);
      }
    }
  }

  /**
   * Refresh current project name and git branch.
   */
  private async refreshProjectMetadata(scopeKey?: string): Promise<void> {
    const project = getCurrentProject(scopeKey);
    const state = this.getContext(scopeKey).state;
    state.projectPath = project?.worktree || t("pinned.unknown");
    state.projectBranch = null;
    state.projectWorktreePath = null;

    if (!project?.worktree) {
      return;
    }

    try {
      const worktreeContext = await getGitWorktreeContext(project.worktree);
      if (!worktreeContext) {
        return;
      }

      state.projectPath = worktreeContext.mainProjectPath;
      state.projectBranch = worktreeContext.branch;
      state.projectWorktreePath = worktreeContext.isLinkedWorktree
        ? worktreeContext.activeWorktreePath
        : null;
    } catch (err) {
      logger.debug("[PinnedManager] Could not resolve git worktree metadata:", err);
    }
  }

  /**
   * Make file path relative to project worktree
   */
  private makeRelativePath(filePath: string, scopeKey?: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const project = getCurrentProject(scopeKey);

    if (project?.worktree) {
      const worktree = project.worktree.replace(/\\/g, "/");
      if (normalized.startsWith(worktree)) {
        // Remove worktree prefix and leading slash
        let relative = normalized.slice(worktree.length);
        if (relative.startsWith("/")) {
          relative = relative.slice(1);
        }
        return relative || normalized;
      }
    }

    // Fallback: just show last 3 segments if path is still absolute
    const segments = normalized.split("/");
    if (segments.length <= 3) return normalized;
    return ".../" + segments.slice(-3).join("/");
  }

  private areFileDiffsEqual(current: FileChange[], next: FileChange[]): boolean {
    if (current.length !== next.length) {
      return false;
    }

    for (let index = 0; index < current.length; index++) {
      const left = current[index];
      const right = next[index];
      if (
        left.file !== right.file ||
        left.additions !== right.additions ||
        left.deletions !== right.deletions
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Fetch context limit from current model configuration
   */
  private async fetchContextLimit(scopeKey?: string): Promise<void> {
    try {
      const context = this.getContext(scopeKey);
      const model = getStoredModel(scopeKey);
      context.contextLimit = await getModelContextLimit(model.providerID, model.modelID);
      context.state.tokensLimit = context.contextLimit;
      logger.debug(`[PinnedManager] Context limit: ${context.contextLimit}`);
    } catch (err) {
      if (isExpectedOpencodeUnavailableError(err)) {
        logger.warn("[PinnedManager] OpenCode server unavailable; using default context limit");
      } else {
        logger.error("[PinnedManager] Error fetching context limit:", err);
      }
      const context = this.getContext(scopeKey);
      context.contextLimit = DEFAULT_CONTEXT_LIMIT;
      context.state.tokensLimit = context.contextLimit;
    }
  }

  /**
   * Format the pinned message text
   */
  private formatMessage(scopeKey?: string): string {
    const state = this.getContext(scopeKey).state;
    const currentModel = getStoredModel(scopeKey);
    const modelName = formatModelDisplayName(currentModel.providerID, currentModel.modelID);
    const projectDisplayName = state.projectBranch
      ? `${state.projectPath}: ${state.projectBranch}`
      : state.projectPath;

    const lines = [
      `${state.sessionTitle}`,
      t("pinned.line.project", { project: projectDisplayName }),
    ];

    if (state.projectWorktreePath) {
      lines.push(t("pinned.line.worktree", { worktree: state.projectWorktreePath }));
    }

    lines.push(t("pinned.line.model", { model: modelName }));

    lines.push(formatContextLine(state.tokensUsed, state.tokensLimit));

    if (state.cost !== undefined && state.cost !== null) {
      lines.push(formatCostLine(state.cost));
    }

    if (state.changedFiles.length > 0) {
      const maxFiles = 10;
      const total = state.changedFiles.length;
      const filesToShow = state.changedFiles.slice(0, maxFiles);

      lines.push("");
      lines.push(t("pinned.files.title", { count: total }));

      for (const f of filesToShow) {
        const relativePath = this.makeRelativePath(f.file, scopeKey);
        const parts = [];
        if (f.additions > 0) parts.push(`+${f.additions}`);
        if (f.deletions > 0) parts.push(`-${f.deletions}`);
        const diffStr = parts.length > 0 ? ` (${parts.join(" ")})` : "";
        lines.push(t("pinned.files.item", { path: relativePath, diff: diffStr }));
      }

      if (total > maxFiles) {
        lines.push(t("pinned.files.more", { count: total - maxFiles }));
      }
    }

    return lines.join("\n");
  }
  /**
   * Create and pin a new status message
   */
  private async createPinnedMessage(scopeKey?: string): Promise<void> {
    const context = this.getContext(scopeKey);
    if (!context.api || !context.chatId) {
      logger.warn("[PinnedManager] API or chatId not initialized");
      return;
    }

    try {
      const text = this.formatMessage(scopeKey);

      // Send new message
      const threadOptions = getOptionalThreadSendOptions(context.threadId);
      const sentMessage = threadOptions
        ? await context.api.sendMessage(context.chatId, text, threadOptions)
        : await context.api.sendMessage(context.chatId, text);

      context.state.messageId = sentMessage.message_id;
      context.state.chatId = context.chatId;
      context.state.threadId = context.threadId;
      context.state.lastUpdated = Date.now();
      context.lastRenderedMessageText = text;

      // Save to settings for persistence
      setPinnedMessageId(sentMessage.message_id, this.normalizeScopeKey(scopeKey));

      // Pin the message (silently)
      await context.api.pinChatMessage(context.chatId, sentMessage.message_id, {
        disable_notification: true,
      });

      logger.info(`[PinnedManager] Created and pinned message: ${sentMessage.message_id}`);
    } catch (err) {
      logger.error("[PinnedManager] Error creating pinned message:", err);
    }
  }

  /**
   * Update existing pinned message text
   */
  private async updatePinnedMessage(scopeKey?: string, forceUpdate: boolean = false): Promise<void> {
    const context = this.getContext(scopeKey);
    if (!context.api || !context.chatId || !context.state.messageId) {
      return;
    }

    context.pendingUpdate = true;
    if (forceUpdate) {
      context.pendingForceUpdate = true;
    }

    if (context.updateTask) {
      await context.updateTask;
      return;
    }

    context.updateTask = this.flushPendingPinnedUpdates(context, scopeKey).finally(() => {
      context.updateTask = null;
    });

    await context.updateTask;
  }

  private async flushPendingPinnedUpdates(
    context: PinnedScopeContext,
    scopeKey?: string,
  ): Promise<void> {
    while (context.pendingUpdate) {
      context.pendingUpdate = false;
      const shouldForceUpdate = context.pendingForceUpdate;
      context.pendingForceUpdate = false;

      if (!context.api || !context.chatId || !context.state.messageId) {
        return;
      }

      const text = this.formatMessage(scopeKey);

      if (!shouldForceUpdate && text === context.lastRenderedMessageText) {
        logger.debug("[PinnedManager] Skipping pinned update: message content unchanged");
        continue;
      }

      try {
        await context.api.editMessageText(context.chatId, context.state.messageId, text);
        context.state.lastUpdated = Date.now();
        context.lastRenderedMessageText = text;

        logger.debug(`[PinnedManager] Updated pinned message: ${context.state.messageId}`);

        // Trigger keyboard update callback
        if (this.onKeyboardUpdateCallback && context.state.tokensLimit > 0) {
          setImmediate(() => {
            this.emitKeyboardUpdate(context.state.tokensUsed, context.state.tokensLimit, scopeKey);
          });
        }
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

        // Handle "message is not modified" error silently
        if (errorMessage.includes("message is not modified")) {
          context.lastRenderedMessageText = text;
          continue;
        }

        // Handle "message to edit not found" - recreate
        if (errorMessage.includes("message to edit not found")) {
          logger.warn("[PinnedManager] Pinned message was deleted, recreating...");
          context.state.messageId = null;
          context.lastRenderedMessageText = null;
          context.pendingForceUpdate = false;
          clearPinnedMessageId(this.normalizeScopeKey(scopeKey));
          await this.createPinnedMessage(scopeKey);
          continue;
        }

        logger.error("[PinnedManager] Error updating pinned message:", err);
      }
    }
  }

  /**
   * Unpin old message before creating new one
   */
  private async unpinOldMessage(scopeKey?: string): Promise<void> {
    const context = this.getContext(scopeKey);
    if (!context.api || !context.chatId) {
      return;
    }

    try {
      // Unpin all messages (ensures clean state)
      await context.api.unpinAllChatMessages(context.chatId).catch(() => {});

      context.state.messageId = null;
      context.lastRenderedMessageText = null;
      context.pendingUpdate = false;
      context.pendingForceUpdate = false;
      clearPinnedMessageId(this.normalizeScopeKey(scopeKey));

      logger.debug("[PinnedManager] Unpinned old messages");
    } catch (err) {
      logger.error("[PinnedManager] Error unpinning messages:", err);
    }
  }

  /**
   * Get current state (for debugging/status)
   */
  getState(scopeKey?: string): PinnedMessageState {
    return { ...this.getContext(scopeKey).state };
  }

  /**
   * Check if manager is initialized
   */
  isInitialized(scopeKey?: string): boolean {
    const context = this.getContext(scopeKey);
    return context.api !== null && context.chatId !== null;
  }

  /**
   * Clear pinned message (when switching projects)
   */
  async clear(scopeKey?: string): Promise<void> {
    const context = this.getContext(scopeKey);
    if (!context.api || !context.chatId) {
      // Just reset state if not initialized
      this.resetContextState(context);
      clearPinnedMessageId(this.normalizeScopeKey(scopeKey));
      return;
    }

    try {
      // Unpin all messages
      await context.api.unpinAllChatMessages(context.chatId).catch(() => {});

      // Reset state
      this.resetContextState(context);
      clearPinnedMessageId(this.normalizeScopeKey(scopeKey));

      logger.info("[PinnedManager] Cleared pinned message state");
    } catch (err) {
      logger.error("[PinnedManager] Error clearing pinned message:", err);
    }
  }
}

export const pinnedMessageManager = new PinnedMessageManager();
