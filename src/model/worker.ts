export type WorkerId = string;
export type RunId = string;

export interface LocalTaskExecution {
  kind: "local";
  processId: string;
  sessionId: string;
}

export interface WorkerTaskExecution {
  kind: "worker";
  workerId: WorkerId;
  processId: string;
  sessionId: string;
  agentDepth: number;
}

export type TaskExecution = LocalTaskExecution | WorkerTaskExecution;

export type WorkerLifecycleStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkerRoute {
  schemaVersion: 1;
  workerId: WorkerId;
  taskId: string;
  runId: RunId;
  sessionId: string;
  sessionFile: string;
  spawningSessionId: string;
  parentTaskId: string | null;
  pid?: number;
  status: WorkerLifecycleStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  diagnostics?: string;
  startedAt?: number;
  exitedAt?: number;
}
