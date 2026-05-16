import { permissionManager } from "../permission/manager.js";
import { questionManager } from "../question/manager.js";
import { renameManager } from "../rename/manager.js";
import { taskCreationManager } from "../scheduled-task/creation-manager.js";
import { interactionManager } from "./manager.js";
import { logger } from "../utils/logger.js";

export function clearAllInteractionState(reason: string, scopeKey?: string): void {
  const questionActive = questionManager.isActive(scopeKey);
  const permissionActive = permissionManager.isActive(scopeKey);
  const renameActive = renameManager.isWaitingForName(scopeKey);
  const taskCreationActive = taskCreationManager.isActive(scopeKey);
  const interactionSnapshot = interactionManager.getSnapshot(scopeKey);

  questionManager.clear(scopeKey);
  permissionManager.clear(scopeKey);
  renameManager.clear(scopeKey);
  taskCreationManager.clear(scopeKey);
  interactionManager.clear(reason, scopeKey);

  const hasAnyActiveState =
    questionActive ||
    permissionActive ||
    renameActive ||
    taskCreationActive ||
    interactionSnapshot !== null;

  const message =
    `[InteractionCleanup] Cleared state: reason=${reason}, scope=${scopeKey ?? "global"}, ` +
    `questionActive=${questionActive}, permissionActive=${permissionActive}, ` +
    `renameActive=${renameActive}, taskCreationActive=${taskCreationActive}, ` +
    `interactionKind=${interactionSnapshot?.kind || "none"}`;

  if (hasAnyActiveState) {
    logger.info(message);
    return;
  }

  logger.debug(message);
}
