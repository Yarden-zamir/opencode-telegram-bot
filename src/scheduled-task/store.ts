import {
  getScheduledTaskTopics,
  getScheduledTasks,
  setScheduledTaskTopics,
  setScheduledTasks,
} from "../settings/manager.js";
import { logger } from "../utils/logger.js";
import type { ScheduledTask, ScheduledTaskTopicBinding } from "./types.js";
import { cloneScheduledTask, cloneScheduledTaskTopicBinding } from "./types.js";

let scheduledTaskMutationQueue: Promise<unknown> = Promise.resolve();
let scheduledTaskTopicMutationQueue: Promise<unknown> = Promise.resolve();

async function mutateScheduledTasks<T>(
  mutator: (tasks: ScheduledTask[]) =>
    | Promise<{ tasks: ScheduledTask[]; result: T }>
    | {
        tasks: ScheduledTask[];
        result: T;
      },
): Promise<T> {
  const runMutation = async (): Promise<T> => {
    const currentTasks = listScheduledTasks();
    const { tasks, result } = await mutator(currentTasks);
    await setScheduledTasks(tasks.map((task) => cloneScheduledTask(task)));
    return result;
  };

  const mutationPromise = scheduledTaskMutationQueue.then(runMutation, runMutation);
  scheduledTaskMutationQueue = mutationPromise.catch(() => undefined);
  return mutationPromise;
}

export function listScheduledTasks(): ScheduledTask[] {
  return getScheduledTasks().map((task) => cloneScheduledTask(task));
}

export function getScheduledTask(taskId: string): ScheduledTask | null {
  const task = listScheduledTasks().find((item) => item.id === taskId);
  return task ? cloneScheduledTask(task) : null;
}

export async function addScheduledTask(task: ScheduledTask): Promise<void> {
  await mutateScheduledTasks((tasks) => ({
    tasks: [...tasks, cloneScheduledTask(task)],
    result: undefined,
  }));
  logger.info(`[ScheduledTaskStore] Added scheduled task: id=${task.id}, kind=${task.kind}`);
}

export async function replaceScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  await mutateScheduledTasks(() => ({
    tasks: tasks.map((task) => cloneScheduledTask(task)),
    result: undefined,
  }));
  logger.info(`[ScheduledTaskStore] Replaced scheduled task collection: count=${tasks.length}`);
}

export async function removeScheduledTask(taskId: string): Promise<boolean> {
  const removed = await mutateScheduledTasks((tasks) => {
    const nextTasks = tasks.filter((task) => task.id !== taskId);
    return {
      tasks: nextTasks,
      result: nextTasks.length !== tasks.length,
    };
  });

  if (!removed) {
    return false;
  }

  logger.info(`[ScheduledTaskStore] Removed scheduled task: id=${taskId}`);
  return true;
}

export async function updateScheduledTask(
  taskId: string,
  updater: (task: ScheduledTask) => ScheduledTask,
): Promise<ScheduledTask | null> {
  return mutateScheduledTasks((tasks) => {
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) {
      return { tasks, result: null };
    }

    const nextTask = cloneScheduledTask(updater(cloneScheduledTask(tasks[index])));
    const nextTasks = [...tasks];
    nextTasks[index] = nextTask;

    return {
      tasks: nextTasks,
      result: cloneScheduledTask(nextTask),
    };
  });
}

async function mutateScheduledTaskTopics<T>(
  mutator: (
    topics: ScheduledTaskTopicBinding[],
  ) =>
    | Promise<{ topics: ScheduledTaskTopicBinding[]; result: T }>
    | { topics: ScheduledTaskTopicBinding[]; result: T },
): Promise<T> {
  const runMutation = async (): Promise<T> => {
    const currentTopics = listScheduledTaskTopics();
    const { topics, result } = await mutator(currentTopics);
    await setScheduledTaskTopics(topics.map((topic) => cloneScheduledTaskTopicBinding(topic)));
    return result;
  };

  const mutationPromise = scheduledTaskTopicMutationQueue.then(runMutation, runMutation);
  scheduledTaskTopicMutationQueue = mutationPromise.catch(() => undefined);
  return mutationPromise;
}

export function listScheduledTaskTopics(): ScheduledTaskTopicBinding[] {
  return getScheduledTaskTopics().map((binding) => cloneScheduledTaskTopicBinding(binding));
}

export async function upsertScheduledTaskTopic(
  topic: ScheduledTaskTopicBinding,
): Promise<ScheduledTaskTopicBinding> {
  return mutateScheduledTaskTopics((topics) => {
    const nextTopics = topics.filter(
      (candidate) =>
        !(candidate.chatId === topic.chatId && candidate.projectId === topic.projectId),
    );
    nextTopics.push(cloneScheduledTaskTopicBinding(topic));

    return {
      topics: nextTopics,
      result: cloneScheduledTaskTopicBinding(topic),
    };
  });
}

export async function getScheduledTaskTopicByChatAndProject(
  chatId: number,
  projectId: string,
): Promise<ScheduledTaskTopicBinding | null> {
  const binding = listScheduledTaskTopics().find(
    (topic) => topic.chatId === chatId && topic.projectId === projectId,
  );
  return binding ? cloneScheduledTaskTopicBinding(binding) : null;
}

export async function getScheduledTaskTopicByChatAndThread(
  chatId: number,
  threadId: number,
): Promise<ScheduledTaskTopicBinding | null> {
  const binding = listScheduledTaskTopics().find(
    (topic) => topic.chatId === chatId && topic.threadId === threadId,
  );
  return binding ? cloneScheduledTaskTopicBinding(binding) : null;
}
