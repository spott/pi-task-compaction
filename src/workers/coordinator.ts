import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FLAGS, type Config } from "../config.js";
import type { PreservedOutput } from "../model/output.js";
import type { Task, TaskId, ResolvedTaskStatus } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";
import type {
  WorkerLifecycleStatus,
  WorkerRoute,
  WorkerShutdownReport,
  WorkerShutdownRequest,
} from "../model/worker.js";
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
  shutdown(request: WorkerShutdownRequest): Promise<WorkerShutdownReport>;
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
    readonly localSessionId: string,
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

export interface WorkerMonitorResult {
  workerId: string;
  taskId: TaskId;
  exit: WorkerProcessExit;
  routeFinalized: boolean;
  leaseReleased: boolean;
  error?: string;
}

interface ManagedWorker {
  workerId: string;
  taskId: TaskId;
  handle: WorkerProcessHandle;
  monitorPromise: Promise<WorkerMonitorResult>;
}

interface WorkerHistory {
  workerId: string;
  taskId: TaskId;
  terminationRequests: NodeJS.Signals[];
  signalFailures: string[];
}

interface SpawnTransaction {
  id: string;
  abortController: AbortController;
  promise: Promise<void>;
  workerId?: string;
  taskId?: TaskId;
}

type ShutdownStage = "open" | "drain" | "term" | "kill" | "audit";

export type WorkerSpawnStage =
  | "context_prepared"
  | "lease_acquired"
  | "source_created"
  | "bootstrap_written"
  | "route_registered"
  | "launch_start"
  | "handle_returned"
  | "pid_recorded";

const MAX_DIAGNOSTIC_LENGTH = 512;
const MAX_REPORT_DIAGNOSTICS = 100;

function boundedDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.length <= MAX_DIAGNOSTIC_LENGTH ? text : `${text.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Worker launch transaction was aborted");
  }
}

function isActiveRoute(route: WorkerRoute): boolean {
  return route.status === "starting" || route.status === "running";
}

async function defaultWaitFor(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0 || timeoutMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  ownerSessionId: string;
  coordinatorId?: string;
  monotonicNow?: () => number;
  waitFor?: (promises: readonly Promise<unknown>[], timeoutMs: number) => Promise<void>;
  onSpawnStage?: (stage: WorkerSpawnStage, signal: AbortSignal) => Promise<void> | void;
}

const DEFAULT_EXTENSION_PATH = fileURLToPath(new URL("../../extensions/task-framework.ts", import.meta.url));

/** Asynchronous spawn/poll/join coordinator; semantic state remains in each owning Pi session. */
export class AsyncWorkerCoordinator implements WorkerCoordinator {
  readonly ownerSessionId: string;
  readonly coordinatorId: string;
  private readonly launcher: WorkerProcessLauncher;
  private readonly extensionPath: string;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly waitFor: (promises: readonly Promise<unknown>[], timeoutMs: number) => Promise<void>;
  private readonly joinPollMs: number;
  private closing = false;
  private shutdownStage: ShutdownStage = "open";
  private shutdownPromise?: Promise<WorkerShutdownReport>;
  private readonly spawnTransactions = new Map<string, SpawnTransaction>();
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly workerHistory = new Map<string, WorkerHistory>();
  private readonly monitorOutcomes = new Map<string, WorkerMonitorResult>();
  private readonly ownedWorkerIds = new Set<string>();
  private readonly spawnCleanupFailures: string[] = [];

  constructor(private readonly options: AsyncWorkerCoordinatorOptions) {
    if (options.ownerSessionId === "") throw new Error("Worker coordinator requires an owning session ID");
    this.ownerSessionId = options.ownerSessionId;
    this.launcher = options.launcher ?? new NodeWorkerProcessLauncher();
    this.extensionPath = options.extensionPath ?? DEFAULT_EXTENSION_PATH;
    this.createId = options.createId ?? randomUUID;
    this.coordinatorId = options.coordinatorId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.waitFor = options.waitFor ?? defaultWaitFor;
    this.joinPollMs = options.joinPollMs ?? 25;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  private async reachSpawnStage(stage: WorkerSpawnStage, signal: AbortSignal): Promise<void> {
    await this.options.onSpawnStage?.(stage, signal);
    throwIfAborted(signal);
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
      `--${CONFIG_FLAGS.workerShutdownDrainMs}`, String(this.options.config.shutdown.workerDrainMs),
      `--${CONFIG_FLAGS.workerShutdownTermGraceMs}`, String(this.options.config.shutdown.workerTermGraceMs),
      `--${CONFIG_FLAGS.workerShutdownKillGraceMs}`, String(this.options.config.shutdown.workerKillGraceMs),
      context.projectTrusted ? "--approve" : "--no-approve",
    ];
    if (context.model) args.push("--model", `${context.model.provider}/${context.model.id}`);
    if (context.thinkingLevel) args.push("--thinking", context.thinkingLevel);
    args.push(renderWorkerPrompt(bootstrap));
    return args;
  }

  spawn(
    request: SpawnTaskRequest,
    context: SpawnTaskExecutionContext,
  ): Promise<{ taskId: TaskId; status: "starting" }> {
    if (this.closing) return Promise.reject(new Error("Worker coordinator is shutting down"));
    if (context.sessionId !== this.ownerSessionId) {
      return Promise.reject(new Error(`Worker coordinator belongs to session ${this.ownerSessionId}`));
    }
    const task = request.task.trim();
    if (task === "") return Promise.reject(new Error("spawn_task.task must be non-empty"));
    const parentTaskId = this.options.runtime.activeTask()?.id ?? null;
    const agentDepth = (this.options.bootstrap?.agentDepth ?? 0) + 1;
    if (agentDepth > this.options.config.limits.maxAgentDepth) {
      return Promise.reject(
        new Error(`spawn_task would exceed max_agent_depth ${this.options.config.limits.maxAgentDepth}`),
      );
    }

    const transaction: SpawnTransaction = {
      id: randomUUID(),
      abortController: new AbortController(),
      promise: Promise.resolve(),
    };
    const result = Promise.resolve().then(() =>
      this.spawnTransaction(request, context, task, parentTaskId, agentDepth, transaction),
    );
    transaction.promise = result.then(
      () => undefined,
      () => undefined,
    );
    this.spawnTransactions.set(transaction.id, transaction);
    void transaction.promise.finally(() => {
      this.spawnTransactions.delete(transaction.id);
    });
    return result;
  }

  private async spawnTransaction(
    request: SpawnTaskRequest,
    context: SpawnTaskExecutionContext,
    task: string,
    parentTaskId: TaskId | null,
    agentDepth: number,
    transaction: SpawnTransaction,
  ): Promise<{ taskId: TaskId; status: "starting" }> {
    const signal = transaction.abortController.signal;
    let workerId: string | undefined;
    let taskId: string | undefined;
    let leaseAcquired = false;
    let registered = false;
    let managed: ManagedWorker | undefined;
    try {
      throwIfAborted(signal);
      const contexts = await this.prepareContexts(request.requiredContext, request.availableContext, context);
      await this.reachSpawnStage("context_prepared", signal);
      workerId = this.createId();
      taskId = this.createId();
      transaction.workerId = workerId;
      transaction.taskId = taskId;

      await this.options.registry.acquireLease(workerId, this.options.config.limits.maxConcurrentAgents);
      leaseAcquired = true;
      this.ownedWorkerIds.add(workerId);
      await this.reachSpawnStage("lease_acquired", signal);
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
      await this.reachSpawnStage("source_created", signal);
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
      await this.reachSpawnStage("bootstrap_written", signal);
      const route: WorkerRoute = {
        schemaVersion: 1,
        workerId,
        taskId,
        runId: this.options.registry.runId,
        sessionId: source.sessionId,
        sessionFile: source.sessionFile,
        spawningSessionId: context.sessionId,
        spawningCoordinatorId: this.coordinatorId,
        parentTaskId,
        status: "starting",
      };
      await this.options.registry.registerWorker(route);
      registered = true;
      await this.reachSpawnStage("route_registered", signal);
      this.options.runtime.recordWorkerSpawn(
        { spawnedTaskId: taskId, task, workerId, sessionId: source.sessionId, agentDepth },
        context.append,
      );
      await this.reachSpawnStage("launch_start", signal);
      const handle = await this.launcher.launch({
        sessionFile: source.sessionFile,
        cwd: context.cwd,
        environment: { [WORKER_BOOTSTRAP_ENV]: bootstrapPath },
        args: this.workerArgs(bootstrap, context),
      }, signal);
      managed = this.manageWorker(workerId, taskId, handle);
      if (signal.aborted || this.closing) {
        this.requestSignal(
          managed,
          this.shutdownStage === "kill" || this.shutdownStage === "audit" ? "SIGKILL" : "SIGTERM",
        );
      }
      await this.reachSpawnStage("handle_returned", signal);
      await this.options.registry.updateWorker(workerId, { pid: handle.pid });
      await this.reachSpawnStage("pid_recorded", signal);
      return { taskId, status: "starting" };
    } catch (error) {
      const diagnostics = boundedDiagnostic(`Worker launch transaction failed: ${boundedDiagnostic(error)}`);
      if (managed) {
        this.requestSignal(
          managed,
          this.shutdownStage === "kill" || this.shutdownStage === "audit" ? "SIGKILL" : "SIGTERM",
        );
      } else {
        if (registered && workerId) {
          try {
            await this.options.registry.updateWorker(workerId, {
              status: "failed",
              diagnostics,
              exitedAt: this.now(),
            });
          } catch (rollbackError) {
            this.spawnCleanupFailures.push(
              `Spawn rollback route finalization failed for worker ${workerId}: ${boundedDiagnostic(rollbackError)}`,
            );
          }
        }
        if (leaseAcquired && workerId) {
          try {
            await this.options.registry.releaseLease(workerId);
          } catch (rollbackError) {
            this.spawnCleanupFailures.push(
              `Spawn rollback lease release failed for worker ${workerId}: ${boundedDiagnostic(rollbackError)}`,
            );
          }
        }
      }
      throw new Error(diagnostics);
    }
  }

  private manageWorker(workerId: string, taskId: TaskId, handle: WorkerProcessHandle): ManagedWorker {
    const history: WorkerHistory = {
      workerId,
      taskId,
      terminationRequests: [],
      signalFailures: [],
    };
    this.workerHistory.set(workerId, history);
    const monitorPromise = this.monitor(workerId, taskId, handle);
    const managed: ManagedWorker = { workerId, taskId, handle, monitorPromise };
    this.workers.set(workerId, managed);
    void monitorPromise.then((outcome) => {
      this.monitorOutcomes.set(workerId, outcome);
      if (this.workers.get(workerId) === managed) this.workers.delete(workerId);
    });
    return managed;
  }

  private requestSignal(worker: ManagedWorker, signal: NodeJS.Signals): void {
    const history = this.workerHistory.get(worker.workerId);
    if (!history || history.terminationRequests.includes(signal)) return;
    history.terminationRequests.push(signal);
    try {
      if (!worker.handle.terminate(signal)) {
        history.signalFailures.push(`${signal} request returned false for worker ${worker.workerId}`);
      }
    } catch (error) {
      history.signalFailures.push(`${signal} request failed for worker ${worker.workerId}: ${boundedDiagnostic(error)}`);
    }
  }

  private async monitor(
    workerId: string,
    taskId: TaskId,
    handle: WorkerProcessHandle,
  ): Promise<WorkerMonitorResult> {
    const errors: string[] = [];
    let exit: WorkerProcessExit;
    try {
      exit = await handle.wait();
    } catch (error) {
      errors.push(`process wait failed: ${boundedDiagnostic(error)}`);
      exit = { exitCode: null, signal: null, stderr: "" };
    }
    let routeFinalized = false;
    try {
      const route = await this.options.registry.resolveWorker(workerId);
      if (!route) throw new Error(`Worker route disappeared before monitor finalization: ${workerId}`);
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
        diagnostics = `Cannot validate worker-owned task stream: ${boundedDiagnostic(error)}`;
      }
      const requests = this.workerHistory.get(workerId)?.terminationRequests ?? [];
      if (requests.length > 0) {
        diagnostics = `${diagnostics ? `${diagnostics}; ` : ""}Coordinator shutdown requested ${requests.join(" then ")}`;
      }
      if (exit.stderr.trim() !== "") {
        diagnostics = `${diagnostics ? `${diagnostics}; ` : ""}stderr: ${exit.stderr.trim()}`;
      }
      await this.options.registry.updateWorker(workerId, {
        status,
        exitCode: exit.exitCode,
        signal: exit.signal,
        exitedAt: this.now(),
        ...(diagnostics ? { diagnostics: boundedDiagnostic(diagnostics) } : {}),
      });
      routeFinalized = true;
    } catch (error) {
      errors.push(`route finalization failed: ${boundedDiagnostic(error)}`);
    }

    let leaseReleased = false;
    try {
      await this.options.registry.releaseLease(workerId);
      leaseReleased = true;
    } catch (error) {
      errors.push(`lease release failed: ${boundedDiagnostic(error)}`);
    }
    return {
      workerId,
      taskId,
      exit,
      routeFinalized,
      leaseReleased,
      ...(errors.length > 0 ? { error: boundedDiagnostic(errors.join("; ")) } : {}),
    };
  }

  shutdown(request: WorkerShutdownRequest): Promise<WorkerShutdownReport> {
    if (request.sessionId !== this.ownerSessionId) {
      return Promise.reject(new Error(`Worker coordinator belongs to session ${this.ownerSessionId}`));
    }
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownStage = "drain";
    const reason = new Error(`Worker coordinator shutdown: ${request.reason}`);
    for (const transaction of this.spawnTransactions.values()) transaction.abortController.abort(reason);
    this.shutdownPromise = Promise.resolve().then(() => this.performShutdown(request));
    return this.shutdownPromise;
  }

  private pendingSettlementPromises(): Promise<unknown>[] {
    return [
      ...[...this.spawnTransactions.values()].map((transaction) => transaction.promise),
      ...[...this.workers.values()].map((worker) => worker.monitorPromise),
    ];
  }

  private async waitForSettlement(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return;
    const deadline = this.monotonicNow() + timeoutMs;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const pending = this.pendingSettlementPromises();
      if (pending.length === 0) return;
      const remaining = deadline - this.monotonicNow();
      if (remaining <= 0) return;
      await this.waitFor(pending, remaining);
      await Promise.resolve();
      const next = this.pendingSettlementPromises();
      if (next.length === 0) return;
      if (this.monotonicNow() >= deadline) return;
      if (next.length === pending.length && next.every((promise) => pending.includes(promise))) return;
    }
  }

  private async auditShutdown(): Promise<{
    activeOwnedRouteCount: number;
    activeDescendantRouteCount: number;
    activeUnmanagedRouteCount: number;
    remainingOwnedLeaseCount: number;
    diagnostics: string[];
  }> {
    const routes = await this.options.registry.listWorkers();
    const leases = new Set(await this.options.registry.listLeaseWorkerIds());
    const direct = routes.filter(
      (route) =>
        route.spawningCoordinatorId === this.coordinatorId &&
        route.spawningSessionId === this.ownerSessionId,
    );
    const directIds = new Set(direct.map((route) => route.workerId));
    const closureIds = new Set(directIds);
    const descendantIds = new Set<string>();
    const descendantSessions = new Set(direct.map((route) => route.sessionId));
    let changed = true;
    while (changed) {
      changed = false;
      for (const route of routes) {
        if (closureIds.has(route.workerId) || !descendantSessions.has(route.spawningSessionId)) continue;
        closureIds.add(route.workerId);
        descendantIds.add(route.workerId);
        descendantSessions.add(route.sessionId);
        changed = true;
      }
    }

    const activeDirect = direct.filter(isActiveRoute);
    const activeDescendants = routes.filter(
      (route) => descendantIds.has(route.workerId) && isActiveRoute(route),
    );
    const unmanaged = new Set<string>();
    for (const route of activeDirect) {
      if (!this.workerHistory.has(route.workerId) || !this.workers.has(route.workerId)) {
        unmanaged.add(route.workerId);
      }
    }
    const activeRoutes = routes.filter(isActiveRoute);
    if (!this.options.bootstrap) {
      for (const route of activeRoutes) {
        if (!closureIds.has(route.workerId)) unmanaged.add(route.workerId);
      }
    } else {
      for (const route of activeRoutes) {
        if (
          route.spawningSessionId === this.ownerSessionId &&
          !closureIds.has(route.workerId)
        ) {
          unmanaged.add(route.workerId);
        }
      }
    }
    const remainingOwnedLeases = [...leases].filter(
      (workerId) => closureIds.has(workerId) || this.ownedWorkerIds.has(workerId),
    );
    const diagnostics: string[] = [];
    if (activeDirect.length > 0) diagnostics.push(`Active direct worker routes: ${activeDirect.map((r) => r.workerId).join(", ")}`);
    if (activeDescendants.length > 0) diagnostics.push(`Active descendant worker routes: ${activeDescendants.map((r) => r.workerId).join(", ")}`);
    if (unmanaged.size > 0) diagnostics.push(`Active unmanaged worker routes: ${[...unmanaged].join(", ")}`);
    if (remainingOwnedLeases.length > 0) diagnostics.push(`Remaining owned worker leases: ${remainingOwnedLeases.join(", ")}`);
    return {
      activeOwnedRouteCount: activeDirect.length,
      activeDescendantRouteCount: activeDescendants.length,
      activeUnmanagedRouteCount: unmanaged.size,
      remainingOwnedLeaseCount: remainingOwnedLeases.length,
      diagnostics,
    };
  }

  private async performShutdown(request: WorkerShutdownRequest): Promise<WorkerShutdownReport> {
    const startedAt = this.now();
    await this.waitForSettlement(this.options.config.shutdown.workerDrainMs);

    this.shutdownStage = "term";
    for (const worker of this.workers.values()) this.requestSignal(worker, "SIGTERM");
    const currentDepth = this.options.bootstrap?.agentDepth ?? 0;
    const remainingLevels = this.options.config.limits.maxAgentDepth - currentDepth;
    const cascadeBudget =
      (this.options.config.shutdown.workerDrainMs + this.options.config.shutdown.workerTermGraceMs) *
      Math.max(1, remainingLevels);
    await this.waitForSettlement(cascadeBudget);

    this.shutdownStage = "kill";
    for (const worker of this.workers.values()) this.requestSignal(worker, "SIGKILL");
    await this.waitForSettlement(this.options.config.shutdown.workerKillGraceMs);
    this.shutdownStage = "audit";

    let audit: Awaited<ReturnType<AsyncWorkerCoordinator["auditShutdown"]>>;
    const diagnostics: string[] = [];
    diagnostics.push(...this.spawnCleanupFailures);
    try {
      audit = await this.auditShutdown();
      diagnostics.push(...audit.diagnostics);
    } catch (error) {
      diagnostics.push(`Registry shutdown audit failed: ${boundedDiagnostic(error)}`);
      audit = {
        activeOwnedRouteCount: 0,
        activeDescendantRouteCount: 0,
        activeUnmanagedRouteCount: 1,
        remainingOwnedLeaseCount: 0,
        diagnostics: [],
      };
    }

    const histories = [...this.workerHistory.values()];
    const outcomes = [...this.monitorOutcomes.values()];
    for (const history of histories) diagnostics.push(...history.signalFailures);
    for (const outcome of outcomes) {
      if (outcome.error) diagnostics.push(`Worker ${outcome.workerId}: ${outcome.error}`);
    }
    const monitorFailureCount = outcomes.filter(
      (outcome) => outcome.error !== undefined || !outcome.routeFinalized || !outcome.leaseReleased,
    ).length;
    const unsettledSpawnCount = this.spawnTransactions.size;
    const survivingHandleCount = this.workers.size;
    const failed =
      diagnostics.length > 0 ||
      monitorFailureCount > 0 ||
      audit.activeOwnedRouteCount > 0 ||
      audit.activeDescendantRouteCount > 0 ||
      audit.activeUnmanagedRouteCount > 0 ||
      audit.remainingOwnedLeaseCount > 0 ||
      unsettledSpawnCount > 0 ||
      survivingHandleCount > 0;
    let report: WorkerShutdownReport = {
      schemaVersion: 1,
      runId: this.options.registry.runId,
      sessionId: this.ownerSessionId,
      coordinatorId: this.coordinatorId,
      reason: request.reason,
      startedAt,
      endedAt: this.now(),
      status: failed ? "failed" : "complete",
      directWorkerCount: histories.length,
      naturalExitCount: histories.filter(
        (history) => history.terminationRequests.length === 0 && this.monitorOutcomes.has(history.workerId),
      ).length,
      sigtermRequestedCount: histories.filter((history) => history.terminationRequests.includes("SIGTERM")).length,
      sigkillRequestedCount: histories.filter((history) => history.terminationRequests.includes("SIGKILL")).length,
      monitorFailureCount,
      activeOwnedRouteCount: audit.activeOwnedRouteCount,
      activeDescendantRouteCount: audit.activeDescendantRouteCount,
      activeUnmanagedRouteCount: audit.activeUnmanagedRouteCount,
      remainingOwnedLeaseCount: audit.remainingOwnedLeaseCount,
      unsettledSpawnCount,
      survivingHandleCount,
      diagnostics: diagnostics.slice(0, MAX_REPORT_DIAGNOSTICS).map(boundedDiagnostic),
    };
    try {
      await this.options.registry.writeShutdownReport(report);
    } catch (error) {
      report = {
        ...report,
        status: "failed",
        diagnostics: [
          ...report.diagnostics,
          boundedDiagnostic(`Shutdown report persistence failed: ${boundedDiagnostic(error)}`),
        ].slice(0, MAX_REPORT_DIAGNOSTICS),
      };
    }
    return report;
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
