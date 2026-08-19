import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FLAGS, type Config } from "../config.js";
import type { PreservedOutput } from "../model/output.js";
import type { Task, TaskId, ResolvedTaskStatus } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";
import type { WorkerLifecycleStatus, WorkerRoute } from "../model/worker.js";
import type { RunRegistry } from "../store/run-registry.js";
import type { LocalTaskRuntime, TaskEventAppender, TaskRuntimeState } from "../store/task-runtime.js";
import type { TaskSource } from "../transcript/source.js";
import type { WorkerBootstrap } from "./bootstrap.js";
import {
  renderWorkerPrompt,
  WORKER_BOOTSTRAP_ENV,
  WORKER_BOOTSTRAP_SCHEMA_VERSION,
  writeWorkerBootstrap,
  type AvailableTaskContext,
  type RequiredTaskContext,
} from "./bootstrap.js";
import {
  NodeWorkerProcessLauncher,
  type WorkerProcessExit,
  type WorkerProcessHandle,
  type WorkerProcessLauncher,
} from "./process.js";
import { precreateWorkerTaskSource, readWorkerTaskSource } from "./source.js";

export interface SpawnTaskRequest {
  task: string;
  requiredContext: TaskId[];
  availableContext: TaskId[];
}

export interface SpawnTaskExecutionContext {
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  append: TaskEventAppender;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  projectTrusted: boolean;
}

export interface VisibleTaskResolution {
  source: Required<TaskSource>;
  task: Task;
  state: TaskRuntimeState;
  semanticStatus: Task["status"];
  resolvedStatus: ResolvedTaskStatus;
  lifecycleStatus: WorkerLifecycleStatus;
  evidence: "semantic" | "registry";
  diagnostics?: string;
}

export interface WorkerTaskResolution extends VisibleTaskResolution {
  route: WorkerRoute;
}

export interface WorkerOutputResolution {
  task: VisibleTaskResolution;
  output: PreservedOutput;
}

export interface WorkerJoinCompleted {
  task_id: TaskId;
  task: string;
  status: "completed";
  summary_retained: boolean;
  summary?: TaskSummary;
  evidence: "semantic";
}

export interface WorkerJoinPending {
  task_id: TaskId;
  task: string;
  status: "starting" | "running";
}

export interface WorkerJoinFailed {
  task_id: TaskId;
  task: string;
  status: "failed" | "cancelled";
  semantic_status: Task["status"];
  evidence: "semantic" | "registry";
  diagnostics: string;
}

export interface WorkerJoinResult {
  wait: "all" | "any";
  completed: WorkerJoinCompleted[];
  pending: WorkerJoinPending[];
  failed: WorkerJoinFailed[];
}

export interface WorkerCoordinator {
  spawn(request: SpawnTaskRequest, context: SpawnTaskExecutionContext): Promise<{ taskId: TaskId; status: "starting" }>;
  poll(taskId: TaskId): Promise<WorkerTaskResolution>;
  join(taskIds: TaskId[], wait: "all" | "any", signal?: AbortSignal): Promise<WorkerJoinResult>;
}

function resolveStatus(
  route: WorkerRoute,
  task: Task,
  started: boolean,
  assignedRoot: boolean,
): Omit<VisibleTaskResolution, "source" | "task" | "state" | "semanticStatus"> {
  if (task.status === "failed") {
    return {
      resolvedStatus: "failed",
      lifecycleStatus: "failed",
      evidence: "semantic",
      diagnostics: route.diagnostics ?? "Worker-owned task stream records failure",
    };
  }
  if (task.status === "cancelled") {
    return {
      resolvedStatus: "cancelled",
      lifecycleStatus: "cancelled",
      evidence: "semantic",
      diagnostics: route.diagnostics ?? "Worker-owned task stream records cancellation",
    };
  }
  if (task.status === "completed" && (!assignedRoot || (route.status === "completed" && route.exitCode === 0))) {
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
    resolvedStatus: started || route.status === "running" ? "running" : "starting",
    lifecycleStatus: started || route.status === "running" ? "running" : "starting",
    evidence: "registry",
    ...(route.diagnostics ? { diagnostics: route.diagnostics } : {}),
  };
}

interface CatalogTask {
  route?: WorkerRoute;
  source: Required<TaskSource>;
  task: Task;
  state: TaskRuntimeState;
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

  private async catalog(): Promise<{ routes: WorkerRoute[]; tasks: Map<TaskId, CatalogTask> }> {
    const routes = await this.registry.listWorkers();
    const tasks = new Map<TaskId, CatalogTask>();
    const loadedSessions = new Map<string, string>();
    const addSource = (
      source: Required<TaskSource>,
      expectedTaskId: TaskId,
      route?: WorkerRoute,
    ): void => {
      const loadedFile = loadedSessions.get(source.sessionId);
      if (loadedFile !== undefined) {
        if (loadedFile !== source.sessionFile) {
          throw new Error(`Session ${source.sessionId} has conflicting task-source paths`);
        }
        return;
      }
      const opened = readWorkerTaskSource(source.sessionFile, expectedTaskId);
      if (opened.manager.getSessionId() !== source.sessionId) {
        throw new Error(`Task context source ${source.sessionFile} has an unexpected session ID`);
      }
      loadedSessions.set(source.sessionId, source.sessionFile);
      for (const task of opened.state.tasks.values()) {
        if (tasks.has(task.id)) throw new Error(`Task ${task.id} is present in multiple task sources`);
        tasks.set(task.id, { source, ...(route ? { route } : {}), task, state: opened.state });
      }
    };

    for (const route of routes) {
      addSource(
        { sessionId: route.sessionId, sessionFile: route.sessionFile },
        route.taskId,
        route,
      );
    }
    for (const context of [
      ...(this.bootstrap?.requiredContext ?? []),
      ...(this.bootstrap?.availableContext ?? []),
    ]) {
      addSource(context.source, context.taskId);
    }
    return { routes, tasks };
  }

  private visible(item: CatalogTask, tasks: ReadonlyMap<TaskId, CatalogTask>): boolean {
    if (!this.bootstrap) return true;
    if (item.task.transcript.sessionId === this.localSessionId) return true;
    if (item.route?.spawningSessionId === this.localSessionId) return true;
    if (this.explicitlyVisible.has(item.task.id)) return true;

    let taskId: TaskId | null = item.task.parentId;
    const seen = new Set<TaskId>([item.task.id]);
    while (taskId !== null && !seen.has(taskId)) {
      if (taskId === this.bootstrap.taskId) return true;
      seen.add(taskId);
      taskId = tasks.get(taskId)?.task.parentId ?? null;
    }
    return false;
  }

  private resolution(item: CatalogTask): VisibleTaskResolution {
    if (!item.route) {
      return {
        source: item.source,
        task: item.task,
        state: item.state,
        semanticStatus: item.task.status,
        resolvedStatus: item.task.status,
        lifecycleStatus: item.task.status === "open" ? "running" : item.task.status,
        evidence: "semantic",
      };
    }
    const assignedRoot = item.route.taskId === item.task.id;
    const status = resolveStatus(
      item.route,
      item.task,
      item.state.startedTaskIds.has(item.task.id),
      assignedRoot,
    );
    return {
      source: item.source,
      task: item.task,
      state: item.state,
      semanticStatus: item.task.status,
      ...status,
    };
  }

  async listRoutes(): Promise<WorkerRoute[]> {
    const { routes, tasks } = await this.catalog();
    const visibleSessions = new Set(
      [...tasks.values()]
        .filter((item) => item.route && this.visible(item, tasks))
        .map((item) => item.source.sessionId),
    );
    return routes.filter((route) => visibleSessions.has(route.sessionId));
  }

  /** Resolve only a spawned worker root, suitable for poll/join. */
  async resolve(taskId: TaskId): Promise<WorkerTaskResolution | undefined> {
    const { tasks } = await this.catalog();
    const item = tasks.get(taskId);
    if (!item?.route || item.route.taskId !== taskId || !this.visible(item, tasks)) return undefined;
    return { ...this.resolution(item), route: item.route };
  }

  /** Resolve any visible semantic task, including explicitly granted coordinator-session tasks. */
  async resolveVisibleTask(taskId: TaskId): Promise<VisibleTaskResolution | undefined> {
    const { tasks } = await this.catalog();
    const item = tasks.get(taskId);
    if (!item || !this.visible(item, tasks)) return undefined;
    return this.resolution(item);
  }

  async list(): Promise<VisibleTaskResolution[]> {
    const { tasks } = await this.catalog();
    return [...tasks.values()]
      .filter((item) => this.visible(item, tasks))
      .map((item) => this.resolution(item));
  }

  async resolveOutput(outputId: string): Promise<WorkerOutputResolution | undefined> {
    const { tasks } = await this.catalog();
    const matches: WorkerOutputResolution[] = [];
    const seenStates = new Set<TaskRuntimeState>();
    for (const item of tasks.values()) {
      if (seenStates.has(item.state)) continue;
      seenStates.add(item.state);
      const output = item.state.outputs.get(outputId);
      if (!output) continue;
      const owner = tasks.get(output.taskId);
      if (owner && this.visible(owner, tasks)) matches.push({ task: this.resolution(owner), output });
    }
    if (matches.length > 1) throw new Error(`Preserved output ${outputId} exists in multiple worker sources`);
    return matches[0];
  }
}

export interface AsyncWorkerCoordinatorOptions {
  config: Config;
  registry: RunRegistry;
  runtime: LocalTaskRuntime;
  router: WorkerTaskRouter;
  bootstrap?: WorkerBootstrap;
  launcher?: WorkerProcessLauncher;
  extensionPath?: string;
  createId?: () => string;
  now?: () => number;
  joinPollMs?: number;
}

const DEFAULT_EXTENSION_PATH = fileURLToPath(new URL("../../extensions/task-framework.ts", import.meta.url));

/** Asynchronous spawn/poll/join coordinator; semantic state remains in each owning Pi session. */
export class AsyncWorkerCoordinator implements WorkerCoordinator {
  private readonly launcher: WorkerProcessLauncher;
  private readonly extensionPath: string;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly joinPollMs: number;

  constructor(private readonly options: AsyncWorkerCoordinatorOptions) {
    this.launcher = options.launcher ?? new NodeWorkerProcessLauncher();
    this.extensionPath = options.extensionPath ?? DEFAULT_EXTENSION_PATH;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.joinPollMs = options.joinPollMs ?? 25;
  }

  private async contextTask(
    taskId: TaskId,
    context: SpawnTaskExecutionContext,
  ): Promise<{ task: Task; status: ResolvedTaskStatus; source: Required<TaskSource> }> {
    const local = this.options.runtime.snapshot.tasks.get(taskId);
    if (local) {
      if (local.transcript.sessionId !== context.sessionId || !context.sessionFile) {
        throw new Error(`Context task ${taskId} has no process-independent owning session source`);
      }
      return {
        task: local,
        status: local.status,
        source: { sessionId: context.sessionId, sessionFile: context.sessionFile },
      };
    }
    const remote = await this.options.router.resolveVisibleTask(taskId);
    if (!remote) throw new Error(`Context task is unknown or not visible: ${taskId}`);
    return { task: remote.task, status: remote.resolvedStatus, source: remote.source };
  }

  private async prepareContexts(
    requiredIds: readonly TaskId[],
    availableIds: readonly TaskId[],
    context: SpawnTaskExecutionContext,
  ): Promise<{ required: RequiredTaskContext[]; available: AvailableTaskContext[] }> {
    if (new Set(requiredIds).size !== requiredIds.length) throw new Error("required_context contains duplicate task IDs");
    if (new Set(availableIds).size !== availableIds.length) throw new Error("available_context contains duplicate task IDs");
    const overlap = requiredIds.find((id) => availableIds.includes(id));
    if (overlap) throw new Error(`Task ${overlap} cannot be both required and available context`);
    if (requiredIds.length > 0 && !this.options.config.features.summaries) {
      throw new Error("required_context is unavailable when summaries are disabled");
    }

    const required: RequiredTaskContext[] = [];
    for (const taskId of requiredIds) {
      const resolved = await this.contextTask(taskId, context);
      if (resolved.status !== "completed" || !resolved.task.summary) {
        throw new Error(`required_context task ${taskId} has no retained completed summary`);
      }
      required.push({ taskId, task: resolved.task.task, summary: resolved.task.summary, source: resolved.source });
    }
    const available: AvailableTaskContext[] = [];
    for (const taskId of availableIds) {
      const resolved = await this.contextTask(taskId, context);
      available.push({ taskId, task: resolved.task.task, status: resolved.status, source: resolved.source });
    }
    return { required, available };
  }

  private workerArgs(
    bootstrap: WorkerBootstrap,
    context: SpawnTaskExecutionContext,
  ): string[] {
    const features = this.options.config.features;
    const limits = this.options.config.limits;
    const args = [
      "--mode", "json",
      "--print",
      "--session", bootstrap.sessionFile,
      "--no-extensions",
      "--extension", this.extensionPath,
      `--${CONFIG_FLAGS.tasks}`, String(features.tasks),
      `--${CONFIG_FLAGS.summaries}`, String(features.summaries),
      `--${CONFIG_FLAGS.compaction}`, String(features.compaction),
      `--${CONFIG_FLAGS.agents}`, String(features.agents),
      `--${CONFIG_FLAGS.maxTaskDepth}`, String(limits.maxTaskDepth),
      `--${CONFIG_FLAGS.maxAgentDepth}`, String(limits.maxAgentDepth),
      `--${CONFIG_FLAGS.maxConcurrentAgents}`, String(limits.maxConcurrentAgents),
      context.projectTrusted ? "--approve" : "--no-approve",
    ];
    if (context.model) args.push("--model", `${context.model.provider}/${context.model.id}`);
    if (context.thinkingLevel) args.push("--thinking", context.thinkingLevel);
    args.push(renderWorkerPrompt(bootstrap));
    return args;
  }

  async spawn(
    request: SpawnTaskRequest,
    context: SpawnTaskExecutionContext,
  ): Promise<{ taskId: TaskId; status: "starting" }> {
    const task = request.task.trim();
    if (task === "") throw new Error("spawn_task.task must be non-empty");
    if (context.sessionId === "") throw new Error("spawn_task requires an owning session ID");
    const parentTaskId = this.options.runtime.activeTask()?.id ?? null;
    const agentDepth = (this.options.bootstrap?.agentDepth ?? 0) + 1;
    if (agentDepth > this.options.config.limits.maxAgentDepth) {
      throw new Error(`spawn_task would exceed max_agent_depth ${this.options.config.limits.maxAgentDepth}`);
    }
    const contexts = await this.prepareContexts(request.requiredContext, request.availableContext, context);
    const workerId = this.createId();
    const taskId = this.createId();
    let registered = false;
    await this.options.registry.acquireLease(workerId, this.options.config.limits.maxConcurrentAgents);
    try {
      const source = await precreateWorkerTaskSource({
        runDirectory: this.options.registry.directory,
        cwd: context.cwd,
        workerId,
        taskId,
        task,
        parentTaskId,
        agentDepth,
        now: this.now,
      });
      const bootstrap: WorkerBootstrap = {
        schemaVersion: WORKER_BOOTSTRAP_SCHEMA_VERSION,
        workerId,
        taskId,
        task,
        parentTaskId,
        agentDepth,
        runId: this.options.registry.runId,
        runDirectory: this.options.registry.directory,
        sessionId: source.sessionId,
        sessionFile: source.sessionFile,
        spawningSessionId: context.sessionId,
        requiredContext: contexts.required,
        availableContext: contexts.available,
      };
      const bootstrapPath = await writeWorkerBootstrap(this.options.registry.directory, bootstrap);
      const route: WorkerRoute = {
        schemaVersion: 1,
        workerId,
        taskId,
        runId: this.options.registry.runId,
        sessionId: source.sessionId,
        sessionFile: source.sessionFile,
        spawningSessionId: context.sessionId,
        parentTaskId,
        status: "starting",
      };
      await this.options.registry.registerWorker(route);
      registered = true;
      this.options.runtime.recordWorkerSpawn(
        { spawnedTaskId: taskId, task, workerId, sessionId: source.sessionId, agentDepth },
        context.append,
      );
      const handle = await this.launcher.launch({
        sessionFile: source.sessionFile,
        cwd: context.cwd,
        environment: { [WORKER_BOOTSTRAP_ENV]: bootstrapPath },
        args: this.workerArgs(bootstrap, context),
      });
      await this.options.registry.updateWorker(workerId, { pid: handle.pid });
      void this.monitor(workerId, taskId, handle);
      return { taskId, status: "starting" };
    } catch (error) {
      const diagnostics = `Worker launch transaction failed: ${error instanceof Error ? error.message : String(error)}`;
      if (registered) {
        await this.options.registry.updateWorker(workerId, {
          status: "failed",
          diagnostics,
          exitedAt: this.now(),
        }).catch(() => undefined);
      }
      await this.options.registry.releaseLease(workerId);
      throw new Error(diagnostics);
    }
  }

  private async monitor(workerId: string, taskId: TaskId, handle: WorkerProcessHandle): Promise<void> {
    let exit: WorkerProcessExit;
    try {
      exit = await handle.wait();
    } catch (error) {
      exit = {
        exitCode: null,
        signal: null,
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const route = await this.options.registry.resolveWorker(workerId);
      if (!route) return;
      let status: WorkerLifecycleStatus = "failed";
      let diagnostics: string | undefined;
      try {
        const source = readWorkerTaskSource(route.sessionFile, taskId);
        if (source.task.status === "completed" && exit.exitCode === 0 && exit.signal === null) {
          status = "completed";
        } else if (source.task.status === "cancelled") {
          status = "cancelled";
          diagnostics = "Worker-owned task stream records cancellation";
        } else if (source.task.status === "failed") {
          diagnostics = "Worker-owned task stream records failure";
        } else {
          diagnostics = "Worker process exited without authoritative assigned-root completion";
        }
      } catch (error) {
        diagnostics = `Cannot validate worker-owned task stream: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (exit.stderr.trim() !== "") diagnostics = `${diagnostics ? `${diagnostics}; ` : ""}stderr: ${exit.stderr.trim()}`;
      await this.options.registry.updateWorker(workerId, {
        status,
        exitCode: exit.exitCode,
        signal: exit.signal,
        exitedAt: this.now(),
        ...(diagnostics ? { diagnostics } : {}),
      });
    } finally {
      await this.options.registry.releaseLease(workerId);
    }
  }

  async poll(taskId: TaskId): Promise<WorkerTaskResolution> {
    const resolved = await this.options.router.resolve(taskId);
    if (!resolved) throw new Error(`Worker task is unknown or not visible: ${taskId}`);
    return resolved;
  }

  private async partition(taskIds: readonly TaskId[], wait: "all" | "any"): Promise<WorkerJoinResult> {
    const resolutions = await Promise.all(taskIds.map((taskId) => this.poll(taskId)));
    const completed: WorkerJoinCompleted[] = [];
    const pending: WorkerJoinPending[] = [];
    const failed: WorkerJoinFailed[] = [];
    for (const item of resolutions) {
      if (item.lifecycleStatus === "completed") {
        if (item.semanticStatus !== "completed" || (this.options.config.features.summaries && !item.task.summary)) {
          failed.push({
            task_id: item.task.id,
            task: item.task.task,
            status: "failed",
            semantic_status: item.semanticStatus,
            evidence: "registry",
            diagnostics: "Completed worker is missing its configured retained authoritative task summary",
          });
        } else {
          completed.push({
            task_id: item.task.id,
            task: item.task.task,
            status: "completed",
            summary_retained: item.task.summary !== undefined,
            ...(item.task.summary ? { summary: item.task.summary } : {}),
            evidence: "semantic",
          });
        }
      } else if (item.lifecycleStatus === "starting" || item.lifecycleStatus === "running") {
        pending.push({ task_id: item.task.id, task: item.task.task, status: item.lifecycleStatus });
      } else {
        failed.push({
          task_id: item.task.id,
          task: item.task.task,
          status: item.lifecycleStatus,
          semantic_status: item.semanticStatus,
          evidence: item.evidence,
          diagnostics: item.diagnostics ?? `Worker task ended with ${item.lifecycleStatus}`,
        });
      }
    }
    return { wait, completed, pending, failed };
  }

  async join(
    taskIds: TaskId[],
    wait: "all" | "any",
    signal?: AbortSignal,
  ): Promise<WorkerJoinResult> {
    if (taskIds.length === 0) throw new Error("join_tasks.task_ids must not be empty");
    if (new Set(taskIds).size !== taskIds.length) throw new Error("join_tasks.task_ids contains duplicates");
    while (true) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("join_tasks was aborted");
      const partition = await this.partition(taskIds, wait);
      const terminalCount = partition.completed.length + partition.failed.length;
      if ((wait === "any" && terminalCount > 0) || (wait === "all" && partition.pending.length === 0)) {
        return partition;
      }
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(finish, this.joinPollMs);
        const abort = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("join_tasks was aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}

/** Convert an extension context into the launch metadata inherited by a worker. */
export function spawnExecutionContext(
  ctx: ExtensionContext,
  append: TaskEventAppender,
): SpawnTaskExecutionContext {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    ...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile()! } : {}),
    append,
    ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
    projectTrusted: ctx.isProjectTrusted(),
  };
}
