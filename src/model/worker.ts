export type WorkerId = string;
export type RunId = string;
export type WorkerCoordinatorId = string;

export type WorkerShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface WorkerShutdownRequest {
  reason: WorkerShutdownReason;
  sessionId: string;
}

export interface WorkerShutdownReport {
  schemaVersion: 1;
  runId: RunId;
  sessionId: string;
  coordinatorId: WorkerCoordinatorId;
  reason: WorkerShutdownReason;
  startedAt: number;
  endedAt: number;
  status: "complete" | "failed";
  directWorkerCount: number;
  naturalExitCount: number;
  sigtermRequestedCount: number;
  sigkillRequestedCount: number;
  monitorFailureCount: number;
  activeOwnedRouteCount: number;
  activeDescendantRouteCount: number;
  activeUnmanagedRouteCount: number;
  remainingOwnedLeaseCount: number;
  unsettledSpawnCount: number;
  survivingHandleCount: number;
  diagnostics: string[];
}

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
  spawningCoordinatorId?: WorkerCoordinatorId;
  parentTaskId: string | null;
  pid?: number;
  status: WorkerLifecycleStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  diagnostics?: string;
  startedAt?: number;
  exitedAt?: number;
}
