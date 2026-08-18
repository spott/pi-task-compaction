import { readFile } from "node:fs/promises";
import type { RunId, WorkerId } from "../model/worker.js";
import type { TaskId } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";

export const WORKER_BOOTSTRAP_ENV = "PI_TASK_FRAMEWORK_BOOTSTRAP";
export const WORKER_BOOTSTRAP_SCHEMA_VERSION = 1;

export interface RequiredTaskContext {
  taskId: TaskId;
  task: string;
  summary: TaskSummary;
}

export interface AvailableTaskContext {
  taskId: TaskId;
  task: string;
  status: string;
}

export interface WorkerBootstrap {
  schemaVersion: typeof WORKER_BOOTSTRAP_SCHEMA_VERSION;
  workerId: WorkerId;
  taskId: TaskId;
  task: string;
  parentTaskId: TaskId | null;
  agentDepth: number;
  runId: RunId;
  runDirectory: string;
  sessionId: string;
  sessionFile: string;
  spawningSessionId: string;
  requiredContext: RequiredTaskContext[];
  availableContext: AvailableTaskContext[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validateWorkerBootstrap(value: unknown): WorkerBootstrap {
  if (typeof value !== "object" || value === null) throw new Error("Worker bootstrap is not an object");
  const item = value as Partial<WorkerBootstrap>;
  if (
    item.schemaVersion !== WORKER_BOOTSTRAP_SCHEMA_VERSION ||
    !isNonEmptyString(item.workerId) ||
    !isNonEmptyString(item.taskId) ||
    !isNonEmptyString(item.task) ||
    (item.parentTaskId !== null && !isNonEmptyString(item.parentTaskId)) ||
    !Number.isSafeInteger(item.agentDepth) ||
    item.agentDepth! < 1 ||
    !isNonEmptyString(item.runId) ||
    !isNonEmptyString(item.runDirectory) ||
    !isNonEmptyString(item.sessionId) ||
    !isNonEmptyString(item.sessionFile) ||
    !isNonEmptyString(item.spawningSessionId) ||
    !Array.isArray(item.requiredContext) ||
    !Array.isArray(item.availableContext)
  ) {
    throw new Error("Worker bootstrap is malformed");
  }
  for (const context of item.requiredContext) {
    if (
      typeof context !== "object" ||
      context === null ||
      !isNonEmptyString((context as RequiredTaskContext).taskId) ||
      !isNonEmptyString((context as RequiredTaskContext).task) ||
      typeof (context as RequiredTaskContext).summary !== "object" ||
      (context as RequiredTaskContext).summary === null
    ) {
      throw new Error("Worker required context is malformed");
    }
  }
  for (const context of item.availableContext) {
    if (
      typeof context !== "object" ||
      context === null ||
      !isNonEmptyString((context as AvailableTaskContext).taskId) ||
      !isNonEmptyString((context as AvailableTaskContext).task) ||
      !isNonEmptyString((context as AvailableTaskContext).status)
    ) {
      throw new Error("Worker available context is malformed");
    }
  }
  return item as WorkerBootstrap;
}

export async function loadWorkerBootstrap(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkerBootstrap | undefined> {
  const path = environment[WORKER_BOOTSTRAP_ENV];
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read task-framework worker bootstrap ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateWorkerBootstrap(parsed);
}

export function renderWorkerPrompt(bootstrap: WorkerBootstrap): string {
  const lines = [
    "You are an asynchronous task worker in a shared working tree.",
    `Assigned task ID: ${bootstrap.taskId}`,
    `Task: ${bootstrap.task}`,
    "The assigned task is already the active execution root. Do not call begin_task for it.",
    "Complete the work, then call end_task with the assigned task ID. A normal process exit without authoritative task completion is failure.",
    "Avoid edits that can conflict with other workers; the spawning agent owns parallel mutation safety.",
  ];
  if (bootstrap.requiredContext.length > 0) {
    lines.push("", "Required prior task context:");
    for (const context of bootstrap.requiredContext) {
      lines.push(
        `\n[task:${context.taskId} — ${JSON.stringify(context.task)}]`,
        JSON.stringify(context.summary, null, 2),
      );
    }
  }
  if (bootstrap.availableContext.length > 0) {
    lines.push("", "Available task references (inspect only if useful):");
    for (const context of bootstrap.availableContext) {
      lines.push(`- ${context.taskId} [${context.status}] ${context.task}`);
    }
  }
  return lines.join("\n");
}
