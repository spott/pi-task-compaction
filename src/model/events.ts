import type { PreservedOutput, ProtectedInteraction } from "./output.js";
import type { TaskId, TaskTranscriptSource } from "./task.js";
import type { TaskSummary } from "./summary.js";
import type { TaskExecution, WorkerId } from "./worker.js";
import type { TranscriptAnchor } from "../transcript/anchors.js";

export const TASK_EVENT_SCHEMA_VERSION = 1;
export const TASK_EVENT_CUSTOM_TYPE = "pi-task-framework/task-event";

interface TaskEventBase {
  at: number;
}

export interface TaskCreated extends TaskEventBase {
  type: "task_created";
  taskId: TaskId;
  task: string;
  parentTaskId: TaskId | null;
  localDepth: number;
  execution: TaskExecution;
  transcript: TaskTranscriptSource;
}

export interface TaskStarted extends TaskEventBase {
  type: "task_started";
  taskId: TaskId;
}

export interface TaskCompleted extends TaskEventBase {
  type: "task_completed";
  taskId: TaskId;
  endAnchor: TranscriptAnchor;
  summary?: TaskSummary;
}

export interface TaskFailed extends TaskEventBase {
  type: "task_failed";
  taskId: TaskId;
  endAnchor: TranscriptAnchor;
  error: string;
  summary?: TaskSummary;
}

export interface TaskCancelled extends TaskEventBase {
  type: "task_cancelled";
  taskId: TaskId;
  endAnchor: TranscriptAnchor;
  reason?: string;
}

export interface OutputPreserved extends TaskEventBase {
  type: "output_preserved";
  taskId: TaskId;
  output: PreservedOutput;
}

export interface UserResponseProtected extends TaskEventBase {
  type: "user_response_protected";
  taskId: TaskId;
  interaction: ProtectedInteraction;
}

export interface WorkerSpawnRequested extends TaskEventBase {
  type: "worker_spawn_requested";
  parentTaskId: TaskId | null;
  spawnedTaskId: TaskId;
  task: string;
  workerId: WorkerId;
  sessionId: string;
  agentDepth: number;
}

export type TaskEvent =
  | TaskCreated
  | TaskStarted
  | TaskCompleted
  | TaskFailed
  | TaskCancelled
  | OutputPreserved
  | UserResponseProtected
  | WorkerSpawnRequested;

export interface TaskEventEnvelope {
  schemaVersion: typeof TASK_EVENT_SCHEMA_VERSION;
  event: TaskEvent;
}

export function taskEventEnvelope(event: TaskEvent): TaskEventEnvelope {
  return { schemaVersion: TASK_EVENT_SCHEMA_VERSION, event };
}

const KNOWN_EVENT_TYPES = new Set<TaskEvent["type"]>([
  "task_created",
  "task_started",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "output_preserved",
  "user_response_protected",
  "worker_spawn_requested",
]);

export function isTaskEventEnvelope(value: unknown): value is TaskEventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { schemaVersion?: unknown; event?: unknown };
  if (envelope.schemaVersion !== TASK_EVENT_SCHEMA_VERSION) return false;
  if (typeof envelope.event !== "object" || envelope.event === null) return false;
  const event = envelope.event as { type?: unknown; at?: unknown };
  return (
    typeof event.type === "string" &&
    KNOWN_EVENT_TYPES.has(event.type as TaskEvent["type"]) &&
    typeof event.at === "number" &&
    Number.isFinite(event.at)
  );
}
