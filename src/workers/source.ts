import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope, type TaskCreated } from "../model/events.js";
import type { Task, TaskId } from "../model/task.js";
import type { WorkerId } from "../model/worker.js";
import { reconstructTaskStateFromEntries, type TaskRuntimeState } from "../store/task-runtime.js";

export interface PrecreateWorkerSourceRequest {
  runDirectory: string;
  cwd: string;
  workerId: WorkerId;
  taskId: TaskId;
  task: string;
  parentTaskId: TaskId | null;
  agentDepth: number;
  now?: () => number;
}

export interface WorkerTaskSourceSnapshot {
  manager: SessionManager;
  state: TaskRuntimeState;
  task: Task;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Worker session path is not a real directory: ${path}`);
  }
  await chmod(path, 0o700);
}

/** Allocate the owning Pi source and persist TaskCreated before process launch. */
export async function precreateWorkerTaskSource(
  request: PrecreateWorkerSourceRequest,
): Promise<{ sessionId: string; sessionFile: string }> {
  const sessionDirectory = join(request.runDirectory, "sessions");
  await ensurePrivateDirectory(sessionDirectory);
  const sessionFile = join(sessionDirectory, `${request.workerId}.jsonl`);
  const handle = await open(
    sessionFile,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  await handle.close();
  const manager = SessionManager.open(sessionFile, sessionDirectory, request.cwd);
  const sessionId = manager.getSessionId();
  const event: TaskCreated = {
    type: "task_created",
    at: (request.now ?? Date.now)(),
    taskId: request.taskId,
    task: request.task,
    parentTaskId: request.parentTaskId,
    localDepth: 0,
    execution: {
      kind: "worker",
      workerId: request.workerId,
      processId: `worker:${request.workerId}`,
      sessionId,
      agentDepth: request.agentDepth,
    },
    transcript: {
      sessionId,
      beginAnchor: { sessionId, entryId: null, boundary: "before" },
    },
  };
  manager.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope(event));
  await chmod(sessionFile, 0o600);
  return { sessionId, sessionFile };
}

/** Reopen an owning worker session and defensively reconstruct its semantic stream. */
export function readWorkerTaskSource(sessionFile: string, taskId: TaskId): WorkerTaskSourceSnapshot {
  const manager = SessionManager.open(sessionFile, dirname(sessionFile));
  const state = reconstructTaskStateFromEntries(manager.getBranch());
  const task = state.tasks.get(taskId);
  if (!task) throw new Error(`Worker source ${sessionFile} does not own task ${taskId}`);
  if (task.transcript.sessionId !== manager.getSessionId()) {
    throw new Error(`Worker task ${taskId} source/session provenance is inconsistent`);
  }
  return { manager, state, task };
}
