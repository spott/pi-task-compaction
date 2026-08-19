import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunId, WorkerId } from "../model/worker.js";
import type { TaskId } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";

export const WORKER_BOOTSTRAP_ENV = "PI_TASK_FRAMEWORK_BOOTSTRAP";
export const WORKER_BOOTSTRAP_SCHEMA_VERSION = 1;

export interface WorkerContextSource {
  sessionId: string;
  sessionFile: string;
}

export interface RequiredTaskContext {
  taskId: TaskId;
  task: string;
  summary: TaskSummary;
  source: WorkerContextSource;
}

export interface AvailableTaskContext {
  taskId: TaskId;
  task: string;
  status: string;
  source: WorkerContextSource;
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
      (context as RequiredTaskContext).summary === null ||
      typeof (context as RequiredTaskContext).source !== "object" ||
      (context as RequiredTaskContext).source === null ||
      !isNonEmptyString((context as RequiredTaskContext).source.sessionId) ||
      !isNonEmptyString((context as RequiredTaskContext).source.sessionFile)
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
      !isNonEmptyString((context as AvailableTaskContext).status) ||
      typeof (context as AvailableTaskContext).source !== "object" ||
      (context as AvailableTaskContext).source === null ||
      !isNonEmptyString((context as AvailableTaskContext).source.sessionId) ||
      !isNonEmptyString((context as AvailableTaskContext).source.sessionFile)
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
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("bootstrap path is not a real file");
    }
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read task-framework worker bootstrap ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateWorkerBootstrap(parsed);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Worker bootstrap path is not a real directory: ${path}`);
  }
  await chmod(path, 0o700);
}

/** Persist an immutable private bootstrap payload before process launch. */
export async function writeWorkerBootstrap(
  runDirectory: string,
  bootstrap: WorkerBootstrap,
): Promise<string> {
  validateWorkerBootstrap(bootstrap);
  const directory = join(runDirectory, "bootstraps");
  await ensurePrivateDirectory(directory);
  const path = join(directory, `${bootstrap.workerId}.json`);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(bootstrap)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      const current = await lstat(path);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new Error(`Worker bootstrap target is unsafe: ${path}`);
      }
      throw new Error(`Worker bootstrap already exists: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    return path;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
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
