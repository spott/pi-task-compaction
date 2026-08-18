import type { Task, TaskId, ResolvedTaskStatus } from "../model/task.js";
import type { WorkerLifecycleStatus, WorkerRoute } from "../model/worker.js";
import type { RunRegistry } from "../store/run-registry.js";
import type { TaskRuntimeState } from "../store/task-runtime.js";
import type { WorkerBootstrap } from "./bootstrap.js";
import { readWorkerTaskSource } from "./source.js";

export interface SpawnTaskRequest {
  task: string;
  parentTaskId: TaskId | null;
  requiredContext: TaskId[];
  availableContext: TaskId[];
}

export interface WorkerTaskResolution {
  route: WorkerRoute;
  task: Task;
  state: TaskRuntimeState;
  semanticStatus: Task["status"];
  resolvedStatus: ResolvedTaskStatus;
  lifecycleStatus: WorkerLifecycleStatus;
  evidence: "semantic" | "registry";
  diagnostics?: string;
}

export interface WorkerCoordinator {
  spawn(request: SpawnTaskRequest): Promise<{ taskId: TaskId; status: "starting" }>;
  poll(taskId: TaskId): Promise<WorkerTaskResolution>;
  join(taskIds: TaskId[], wait: "all" | "any"): Promise<unknown>;
}

function resolveStatus(route: WorkerRoute, task: Task, started: boolean): Omit<WorkerTaskResolution, "route" | "task" | "state" | "semanticStatus"> {
  if (task.status === "failed") {
    return { resolvedStatus: "failed", lifecycleStatus: "failed", evidence: "semantic" };
  }
  if (task.status === "cancelled") {
    return { resolvedStatus: "cancelled", lifecycleStatus: "cancelled", evidence: "semantic" };
  }
  if (task.status === "completed" && route.status === "completed" && route.exitCode === 0) {
    return { resolvedStatus: "completed", lifecycleStatus: "completed", evidence: "semantic" };
  }
  if (route.status === "cancelled") {
    return {
      resolvedStatus: "cancelled",
      lifecycleStatus: "cancelled",
      evidence: "registry",
      diagnostics: route.diagnostics ?? "Worker was cancelled before recording TaskCancelled",
    };
  }
  if (route.status === "failed" || (route.status === "completed" && task.status !== "completed")) {
    return {
      resolvedStatus: "derived_failed",
      lifecycleStatus: "failed",
      evidence: "registry",
      diagnostics:
        route.diagnostics ??
        (task.status === "completed"
          ? "Worker recorded TaskCompleted but did not exit successfully"
          : "Worker exited without an authoritative TaskCompleted event"),
    };
  }
  return {
    resolvedStatus: started ? "running" : "starting",
    lifecycleStatus: started ? "running" : "starting",
    evidence: "registry",
    ...(route.diagnostics ? { diagnostics: route.diagnostics } : {}),
  };
}

/** Read-only, visibility-filtered router over worker-owned Pi sessions. */
export class WorkerTaskRouter {
  private readonly explicitlyVisible: Set<TaskId>;

  constructor(
    private readonly registry: RunRegistry,
    private readonly localSessionId: string,
    private readonly bootstrap?: WorkerBootstrap,
  ) {
    this.explicitlyVisible = new Set([
      ...(bootstrap?.requiredContext.map((item) => item.taskId) ?? []),
      ...(bootstrap?.availableContext.map((item) => item.taskId) ?? []),
    ]);
  }

  private visible(route: WorkerRoute, routes: readonly WorkerRoute[]): boolean {
    if (route.sessionId === this.localSessionId || route.spawningSessionId === this.localSessionId) return true;
    if (!this.bootstrap) return true;
    if (this.explicitlyVisible.has(route.taskId)) return true;

    const byTask = new Map(routes.map((candidate) => [candidate.taskId, candidate]));
    let taskId: TaskId | null = route.parentTaskId;
    const seen = new Set<TaskId>([route.taskId]);
    while (taskId !== null && !seen.has(taskId)) {
      if (taskId === this.bootstrap.taskId) return true;
      seen.add(taskId);
      taskId = byTask.get(taskId)?.parentTaskId ?? null;
    }
    return false;
  }

  async listRoutes(): Promise<WorkerRoute[]> {
    const routes = await this.registry.listWorkers();
    return routes.filter((route) => this.visible(route, routes));
  }

  async resolve(taskId: TaskId): Promise<WorkerTaskResolution | undefined> {
    const routes = await this.registry.listWorkers();
    const route = routes.find((candidate) => candidate.taskId === taskId);
    if (!route || !this.visible(route, routes)) return undefined;
    const source = readWorkerTaskSource(route.sessionFile, taskId);
    const status = resolveStatus(route, source.task, source.state.startedTaskIds.has(taskId));
    return {
      route,
      task: source.task,
      state: source.state,
      semanticStatus: source.task.status,
      ...status,
    };
  }

  async list(): Promise<WorkerTaskResolution[]> {
    const routes = await this.listRoutes();
    const resolved: WorkerTaskResolution[] = [];
    for (const route of routes) {
      const item = await this.resolve(route.taskId);
      if (item) resolved.push(item);
    }
    return resolved;
  }
}
