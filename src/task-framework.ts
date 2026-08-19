import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Config } from "./config.js";
import { LocalTaskInspector, type InspectTaskRequest, type InspectTaskResult } from "./inspect/inspect.js";
import type { TaskId, TaskListItem } from "./model/task.js";
import type { TaskSummary } from "./model/summary.js";
import type { RunRegistry } from "./store/run-registry.js";
import type { WorkerBootstrap } from "./workers/bootstrap.js";
import {
  AsyncWorkerCoordinator,
  WorkerTaskRouter,
  spawnExecutionContext,
} from "./workers/coordinator.js";
import type { WorkerProcessLauncher } from "./workers/process.js";
import { readWorkerTaskSource } from "./workers/source.js";
import { LocalProjectionPlanner, type ProjectionPlan } from "./projection/planner.js";
import { resolveAndPersistTaskAnchors } from "./store/anchor-resolutions.js";
import { resolveAndPersistInteractionAnchors } from "./store/interaction-resolutions.js";
import { InteractionService } from "./store/interactions.js";
import { PreservationService } from "./store/preservation.js";
import { PiTaskEventStore } from "./store/task-events.js";
import {
  LocalTaskRuntime,
  type ListTasksQuery,
  type TaskBoundaryContext,
  type TaskRuntimeState,
} from "./store/task-runtime.js";

const BeginTaskParams = Type.Object(
  {
    task: Type.String({ minLength: 1, description: "Concise description of the task" }),
  },
  { additionalProperties: false },
);

const PreserveOutputParams = Type.Object(
  {
    tool_call_id: Type.String({ minLength: 1 }),
    pin: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ReadPreservedOutputParams = Type.Object(
  {
    output_id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const RespondToUserParams = Type.Object({}, { additionalProperties: false });

const EndTaskParams = Type.Object(
  {
    task_id: Type.String({ minLength: 1 }),
    objective: Type.String(),
    outcome: Type.String(),
    attempted: Type.Array(Type.String()),
    learnings: Type.Array(Type.String()),
    decisions: Type.Array(Type.String()),
    files_read: Type.Array(Type.String()),
    files_modified: Type.Array(Type.String()),
    verification: Type.Array(Type.String()),
    open_threads: Type.Array(Type.String()),
    preserve_outputs: Type.Optional(Type.Array(PreserveOutputParams)),
  },
  { additionalProperties: false },
);

const ListTasksParams = Type.Object(
  {
    root_task_id: Type.Optional(Type.String()),
    status: Type.Optional(
      StringEnum(["open", "completed", "cancelled", "failed", "all"] as const),
    ),
  },
  { additionalProperties: false },
);

const InspectTaskParams = Type.Object(
  {
    task_id: Type.String({ minLength: 1 }),
    view: Type.Optional(
      StringEnum(["summary", "list", "search", "entry", "transcript"] as const),
    ),
    query: Type.Optional(Type.String()),
    entry: Type.Optional(Type.String({ minLength: 1 })),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 50_000 })),
  },
  { additionalProperties: false },
);

const SpawnTaskParams = Type.Object(
  {
    task: Type.String({ minLength: 1 }),
    required_context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    available_context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

const PollTaskParams = Type.Object(
  { task_id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const JoinTasksParams = Type.Object(
  {
    task_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    wait: Type.Optional(StringEnum(["all", "any"] as const)),
  },
  { additionalProperties: false },
);

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface ProjectionDiagnostics {
  lastPlan?: ProjectionPlan;
  rejectionCounts: Map<string, number>;
}

export interface TaskFrameworkServices {
  runtime: LocalTaskRuntime;
  config: Config;
  preservation: PreservationService;
  interactions: InteractionService;
  projection: ProjectionDiagnostics;
  inspector: LocalTaskInspector;
  agents?: {
    bootstrap?: WorkerBootstrap;
    registry: RunRegistry;
    router: WorkerTaskRouter;
    coordinator: AsyncWorkerCoordinator;
  };
  reconstruct(ctx: ExtensionContext): void;
  ensureLoaded(ctx: ExtensionContext): void;
  startWorker(ctx: ExtensionContext): Promise<void>;
}

export interface RegisterTaskFrameworkOptions {
  registerSessionStart?: boolean;
  agents?: {
    registry: RunRegistry;
    localSessionId: string;
    bootstrap?: WorkerBootstrap;
    launcher?: WorkerProcessLauncher;
    extensionPath?: string;
  };
}

function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function findAssistantEntryId(
  sessionManager: ReadonlySessionManager,
  toolCallId: string,
): string | null {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    if (
      entry.message.content.some(
        (block) => block.type === "toolCall" && block.id === toolCallId,
      )
    ) {
      return entry.id;
    }
  }
  return null;
}

function boundaryContext(
  ctx: ExtensionContext,
  toolCallId: string,
  toolName: "begin_task" | "end_task",
): TaskBoundaryContext {
  const assistantEntryId = findAssistantEntryId(ctx.sessionManager, toolCallId);
  if (assistantEntryId === null) {
    throw new Error(`${toolName} cannot find its persisted assistant/tool-call entry`);
  }
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    assistantEntryId,
    toolCallId,
  };
}

function stripUnretainedSummaries(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type !== "toolCall" || block.name !== "end_task") return block;
        changed = true;
        const taskId = block.arguments.task_id;
        return {
          ...block,
          arguments: {
            ...(typeof taskId === "string" ? { task_id: taskId } : {}),
            summary_retained: false,
          },
        };
      });
      return changed ? { ...message, content } : message;
    }
    if (message.role === "toolResult" && message.toolName === "end_task") {
      return { ...message, details: undefined };
    }
    return message;
  });
}

function formatTasks(items: readonly TaskListItem[], activeStack: readonly TaskId[]): string {
  if (items.length === 0) return "No tasks on the visible task tree.";
  return items
    .map((item) => {
      const indent = "  ".repeat(Math.max(0, item.semanticDepth - 1));
      const active = activeStack.includes(item.id) ? " *" : "";
      return `${indent}- [${item.status}] ${item.id} ${item.task}${active}`;
    })
    .join("\n");
}

function updateStatus(runtime: LocalTaskRuntime, ctx: ExtensionContext): void {
  const stack = runtime.activeTasks();
  if (stack.length === 0) {
    ctx.ui.setStatus("task-framework", undefined);
    return;
  }
  ctx.ui.setStatus(
    "task-framework",
    `tasks ${stack.length}: ${stack.map((task) => task.task).join(" › ")}`,
  );
}

function stateAgentDepth(state: TaskRuntimeState): number {
  for (const task of state.tasks.values()) {
    if (task.localDepth === 0 && task.execution.kind === "worker") return task.execution.agentDepth;
  }
  return 0;
}

function statusMatches(item: TaskListItem, status: ListTasksQuery["status"]): boolean {
  if (status === undefined || status === "all") return true;
  if (status === "open") return item.status === "open" || item.status === "starting" || item.status === "running";
  if (status === "failed") return item.status === "failed" || item.status === "derived_failed";
  return item.status === status;
}

async function listVisibleTasks(
  runtime: LocalTaskRuntime,
  router: WorkerTaskRouter | undefined,
  localSessionId: string,
  query: ListTasksQuery = {},
): Promise<TaskListItem[]> {
  const items = new Map<TaskId, TaskListItem>(runtime.list().map((item) => [item.id, item]));
  if (router) {
    for (const resolved of await router.list()) {
      const task = resolved.task;
      if (task.transcript.sessionId === localSessionId || items.has(task.id)) continue;
      const children = task.children.map((taskId) => ({
        taskId,
        task: resolved.state.childDescriptions.get(taskId) ?? "(unresolved task)",
      }));
      const pinnedOutputCount = task.preservedOutputs.reduce(
        (count, outputId) => count + (resolved.state.outputs.get(outputId)?.pin ? 1 : 0),
        0,
      );
      items.set(task.id, {
        id: task.id,
        parentId: task.parentId,
        task: task.task,
        status: resolved.resolvedStatus,
        localDepth: task.localDepth,
        semanticDepth: 1,
        agentDepth:
          task.execution.kind === "worker" ? task.execution.agentDepth : stateAgentDepth(resolved.state),
        children,
        preservedOutputCount: task.preservedOutputs.length,
        pinnedOutputCount,
        execution: task.execution,
      });
    }
  }

  const semanticDepth = (item: TaskListItem): number => {
    let depth = 1;
    let parentId = item.parentId;
    const seen = new Set<TaskId>([item.id]);
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = items.get(parentId)?.parentId ?? null;
    }
    return depth;
  };
  for (const [id, item] of items) items.set(id, { ...item, semanticDepth: semanticDepth(item) });

  let selected = [...items.values()];
  if (query.root_task_id !== undefined) {
    const root = items.get(query.root_task_id);
    if (!root) throw new Error(`Unknown or invisible root task: ${query.root_task_id}`);
    const ids = new Set<TaskId>();
    const visit = (taskId: TaskId): void => {
      if (ids.has(taskId)) return;
      ids.add(taskId);
      for (const child of items.get(taskId)?.children ?? []) visit(child.taskId);
    };
    visit(root.id);
    selected = selected.filter((item) => ids.has(item.id));
  }
  return selected.filter((item) => statusMatches(item, query.status));
}

export function registerTaskFramework(
  pi: ExtensionAPI,
  config: Config,
  options: RegisterTaskFrameworkOptions = {},
): TaskFrameworkServices | undefined {
  if (!config.features.tasks) return undefined;

  const store = new PiTaskEventStore(pi);
  const runtime = new LocalTaskRuntime(
    config,
    randomUUID(),
    randomUUID,
    Date.now,
    options.agents?.bootstrap?.agentDepth ?? 0,
  );
  const preservation = new PreservationService(runtime);
  const interactions = new InteractionService(runtime);
  const planner = new LocalProjectionPlanner();
  const projection: ProjectionDiagnostics = { rejectionCounts: new Map() };
  const inspector = new LocalTaskInspector(runtime, { projection });
  const agents = options.agents
    ? (() => {
        const router = new WorkerTaskRouter(
          options.agents.registry,
          options.agents.localSessionId,
          options.agents.bootstrap,
        );
        const coordinator = new AsyncWorkerCoordinator({
          config,
          registry: options.agents.registry,
          runtime,
          router,
          ...(options.agents.bootstrap ? { bootstrap: options.agents.bootstrap } : {}),
          ...(options.agents.launcher ? { launcher: options.agents.launcher } : {}),
          ...(options.agents.extensionPath ? { extensionPath: options.agents.extensionPath } : {}),
        });
        return { ...options.agents, router, coordinator };
      })()
    : undefined;
  let loadedSessionId: string | undefined;
  let workerStarted = false;

  const inspectTask = async (
    request: InspectTaskRequest,
    ctx: ExtensionContext,
  ): Promise<InspectTaskResult> => {
    if (runtime.snapshot.tasks.has(request.task_id)) return inspector.inspect(request, ctx.sessionManager);
    const resolved = await agents?.router.resolveVisibleTask(request.task_id);
    if (!resolved) throw new Error(`Unknown or invisible task: ${request.task_id}`);
    const source = readWorkerTaskSource(resolved.source.sessionFile, resolved.task.id);
    const remoteRuntime = new LocalTaskRuntime(
      config,
      randomUUID(),
      randomUUID,
      Date.now,
      stateAgentDepth(resolved.state),
    );
    remoteRuntime.reconstructEntries(source.manager.getBranch());
    const result = await new LocalTaskInspector(remoteRuntime).inspect(request, source.manager);
    if ((request.view ?? "summary") === "summary") {
      result.details = { ...result.details, status: resolved.resolvedStatus };
      result.text = JSON.stringify(result.details, null, 2);
    }
    return result;
  };

  const readPreservedOutput = async (
    outputId: string,
    ctx: ExtensionContext,
  ) => {
    if (runtime.snapshot.outputs.has(outputId)) return preservation.read(outputId, ctx.sessionManager);
    const resolved = await agents?.router.resolveOutput(outputId);
    if (!resolved) throw new Error(`Preserved output not found on the visible task tree: ${outputId}`);
    const source = readWorkerTaskSource(resolved.task.source.sessionFile, resolved.task.task.id);
    const remoteRuntime = new LocalTaskRuntime(
      config,
      randomUUID(),
      randomUUID,
      Date.now,
      stateAgentDepth(resolved.task.state),
    );
    remoteRuntime.reconstructEntries(source.manager.getBranch());
    return new PreservationService(remoteRuntime).read(outputId, source.manager);
  };

  const reconstruct = (ctx: ExtensionContext): void => {
    runtime.reconstructFrom(store, ctx.sessionManager);
    loadedSessionId = ctx.sessionManager.getSessionId();
    updateStatus(runtime, ctx);
  };
  const ensureLoaded = (ctx: ExtensionContext): void => {
    if (loadedSessionId !== ctx.sessionManager.getSessionId()) reconstruct(ctx);
  };
  const appendFrom = (ctx: ExtensionContext) => (event: Parameters<typeof store.append>[0]) =>
    store.append(event, ctx);
  const startWorker = async (ctx: ExtensionContext): Promise<void> => {
    if (!agents?.bootstrap || workerStarted) return;
    ensureLoaded(ctx);
    const bootstrap = agents.bootstrap;
    if (
      ctx.sessionManager.getSessionId() !== bootstrap.sessionId ||
      ctx.sessionManager.getSessionFile() !== bootstrap.sessionFile
    ) {
      throw new Error(`Worker process did not adopt pre-created session ${bootstrap.sessionId}`);
    }
    runtime.adoptAssignedRoot(bootstrap.taskId, appendFrom(ctx));
    await agents.registry.updateWorker(bootstrap.workerId, {
      status: "running",
      pid: process.pid,
      startedAt: Date.now(),
    });
    workerStarted = true;
    updateStatus(runtime, ctx);
  };

  if (options.registerSessionStart !== false) {
    pi.on("session_start", async (_event, ctx) => {
      reconstruct(ctx);
      await startWorker(ctx);
    });
  }
  if (agents?.bootstrap) {
    pi.on("session_shutdown", async (_event, ctx) => {
      ensureLoaded(ctx);
      const bootstrap = agents.bootstrap!;
      const assigned = runtime.snapshot.tasks.get(bootstrap.taskId);
      if (assigned?.status === "open") {
        runtime.failOpenTasks(
          "Worker process shut down without completing its assigned root task",
          ctx.sessionManager.getSessionId(),
          () => ctx.sessionManager.getLeafId(),
          appendFrom(ctx),
        );
      }
      const terminal = runtime.snapshot.tasks.get(bootstrap.taskId);
      await agents.registry.updateWorker(bootstrap.workerId, {
        status: terminal?.status === "completed" ? "completed" : terminal?.status === "cancelled" ? "cancelled" : "failed",
        exitCode: terminal?.status === "completed" ? 0 : 1,
        exitedAt: Date.now(),
        ...(terminal?.status === "completed"
          ? {}
          : { diagnostics: terminal?.status === "failed" ? "Worker-owned task stream records failure" : "Worker exited without successful task completion" }),
      });
      await agents.registry.releaseLease(bootstrap.workerId);
    });
  }
  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));
  pi.on("turn_end", (_event, ctx) => {
    ensureLoaded(ctx);
    resolveAndPersistTaskAnchors(runtime.snapshot, pi, ctx);
    resolveAndPersistInteractionAnchors(runtime.snapshot, pi, ctx);
  });

  if (!config.features.summaries || config.features.compaction) {
    pi.on("context", (event, ctx) => {
      ensureLoaded(ctx);
      let messages = event.messages;
      if (!config.features.summaries) messages = stripUnretainedSummaries(messages);
      if (config.features.compaction) {
        const plan = planner.plan({
          messages,
          sessionId: ctx.sessionManager.getSessionId(),
          branchEntries: ctx.sessionManager.getBranch(),
          contextEntries: ctx.sessionManager.buildContextEntries(),
          state: runtime.snapshot,
        });
        projection.lastPlan = plan;
        for (const rejection of plan.rejections) {
          for (const reason of rejection.reasons) {
            const key = `${rejection.taskId}: ${reason}`;
            projection.rejectionCounts.set(key, (projection.rejectionCounts.get(key) ?? 0) + 1);
          }
        }
        messages = plan.messages;
      }
      return { messages };
    });
  }

  if (config.features.compaction) {
    // M11 replaces this retaining hook with task-aware global compaction.
    pi.on("session_before_compact", () => undefined);
  }

  pi.registerTool({
    name: "begin_task",
    label: "Begin Task",
    description:
      "Start a semantic task. Nested calls create children; max_task_depth is enforced per process.",
    promptSnippet: "Start a hierarchical semantic task",
    promptGuidelines: [
      "Use begin_task for bounded work whose detailed transcript can later be replaced by a durable summary.",
      "Close a child task before closing its parent.",
    ],
    parameters: BeginTaskParams,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      ensureLoaded(ctx);
      const result = runtime.begin(
        params.task,
        boundaryContext(ctx, toolCallId, "begin_task"),
        appendFrom(ctx),
      );
      updateStatus(runtime, ctx);
      return textResult(
        `Opened task ${result.task_id}${
          result.parent_task_id ? ` as child of ${result.parent_task_id}` : " as a root task"
        } at local depth ${result.depth}.`,
        result,
      );
    },
  });

  pi.registerTool({
    name: "preserve_output",
    label: "Preserve Output",
    description:
      "Preserve any completed ordinary tool result from the active task. Set pin=true only when its original protocol material must remain directly in context through task closure.",
    promptSnippet: "Preserve an important completed tool result by tool-call ID",
    promptGuidelines: [
      "Preserve only outputs that will matter after task compaction; pin sparse immutable references that must remain verbatim in provider context.",
    ],
    parameters: PreserveOutputParams,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      ensureLoaded(ctx);
      const result = preservation.preserve(params, toolCallId, ctx.sessionManager, appendFrom(ctx));
      return textResult(
        `${result.already_preserved ? "Reused" : "Preserved"} output ${result.output_id} from ${result.tool_name} call ${result.tool_call_id}${
          result.pin ? ` with a ${result.closure_entry_count}-entry pinned protocol closure` : ""
        }.`,
        result,
      );
    },
  });

  pi.registerTool({
    name: "read_preserved_output",
    label: "Read Preserved Output",
    description: "Integrity-check and re-emit the exact persisted text/image content of a preserved output.",
    promptSnippet: "Recover an exact preserved tool result by output ID",
    parameters: ReadPreservedOutputParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureLoaded(ctx);
      const result = await readPreservedOutput(params.output_id, ctx);
      return {
        content: result.content,
        details: {
          output_id: result.output.id,
          task_id: result.output.taskId,
          tool_call_id: result.output.source.toolCallId,
          tool_name: result.output.source.toolName,
          pin: result.output.pin,
        },
      };
    },
  });

  pi.registerTool({
    name: "respond_to_user",
    label: "Respond to User",
    description:
      "Mark this assistant message as a verbatim response to the one currently unanswered user message in the active task. This must be the only tool call in the assistant message; the task remains active. API v2 leaves multi-message binding unsettled, so accumulated messages are rejected.",
    promptSnippet: "Protect a user interaction verbatim while keeping the task active",
    promptGuidelines: [
      "When answering one user interruption during an active task, call respond_to_user as the only tool in that assistant message if the exchange should survive task compaction verbatim; do not accumulate multiple unanswered messages before marking.",
      "Unmarked user messages remain unanswered task input and are replayed after task closure only when projection removes their original occurrence.",
    ],
    parameters: RespondToUserParams,
    executionMode: "sequential",
    async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
      ensureLoaded(ctx);
      const result = interactions.protect(toolCallId, ctx.sessionManager, appendFrom(ctx));
      return textResult(
        `Protected ${result.protected_user_message_count} user message(s) as interaction ${result.interaction_id}. The active task remains open.`,
        result,
      );
    },
  });

  pi.registerTool({
    name: "end_task",
    label: "End Task",
    description:
      "Close the active task with a structured summary. The task_id must identify the active stack top.",
    promptSnippet: "Close the active task and publish its structured result",
    promptGuidelines: config.features.summaries
      ? [
          "Use end_task as soon as a task milestone is complete; make its summary sufficient to continue after detailed history is removed.",
        ]
      : [
          "Use end_task to close completed work; this ablation authors the normal summary but does not retain it after the turn.",
        ],
    parameters: EndTaskParams,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      ensureLoaded(ctx);
      const activeTask = runtime.activeTask();
      if (!activeTask || activeTask.id !== params.task_id) {
        throw new Error(
          activeTask
            ? `end_task.task_id must be the active stack top (${activeTask.id})`
            : "end_task requires an active task",
        );
      }
      const preserved = preservation.preserveForEnd(
        params.task_id,
        params.preserve_outputs ?? [],
        toolCallId,
        ctx.sessionManager,
        appendFrom(ctx),
      );
      const summary: TaskSummary = {
        objective: params.objective,
        outcome: params.outcome,
        attempted: [...params.attempted],
        learnings: [...params.learnings],
        decisions: [...params.decisions],
        files_read: [...params.files_read],
        files_modified: [...params.files_modified],
        verification: [...params.verification],
        open_threads: [...params.open_threads],
      };
      const unansweredMessageCount = interactions.pendingBeforeMarker(
        params.task_id,
        toolCallId,
        ctx.sessionManager,
      ).length;
      const result = runtime.end(
        params.task_id,
        summary,
        config.features.summaries,
        boundaryContext(ctx, toolCallId, "end_task"),
        appendFrom(ctx),
        unansweredMessageCount,
      );
      updateStatus(runtime, ctx);
      return textResult(
        `Completed task ${result.task_id}. ${
          result.restored_parent_task_id
            ? `Restored parent ${result.restored_parent_task_id}.`
            : "No local parent is active."
        }${preserved.length > 0 ? ` Preserved ${preserved.length} selected output(s).` : ""}`,
        { ...result, preserved_outputs: preserved },
      );
    },
  });

  pi.registerTool({
    name: "inspect_task",
    label: "Inspect Task",
    description:
      "Inspect one semantic task without restoring its entire historical body. Defaults to a compact summary; bounded list/search views lead to exact entry locators or a private complete transcript artifact.",
    promptSnippet: "Inspect durable task metadata or selected persisted task history",
    promptGuidelines: [
      "Use summary first. Use bounded list or search to locate relevant entry IDs, then entry for an exact JSONL locator.",
      "Use transcript only when jq/bash tooling genuinely needs the complete artifact. Transcript artifacts are private ephemeral caches and may contain sensitive content; do not copy them into the repository.",
    ],
    parameters: InspectTaskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureLoaded(ctx);
      const result = await inspectTask(params, ctx);
      return textResult(result.text, result.details);
    },
  });

  pi.registerTool({
    name: "list_tasks",
    label: "List Tasks",
    description: "List compact semantic task-tree metadata on the active session branch.",
    promptSnippet: "Discover task IDs and compact task-tree state",
    parameters: ListTasksParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureLoaded(ctx);
      const query: ListTasksQuery = {
        ...(params.root_task_id === undefined ? {} : { root_task_id: params.root_task_id }),
        ...(params.status === undefined ? {} : { status: params.status }),
      };
      const tasks = await listVisibleTasks(
        runtime,
        agents?.router,
        ctx.sessionManager.getSessionId(),
        query,
      );
      return textResult(JSON.stringify({ tasks, active_stack: runtime.snapshot.activeStack }, null, 2), {
        tasks,
        active_stack: [...runtime.snapshot.activeStack],
        reconstruction_issues: [...runtime.snapshot.issues],
      });
    },
  });

  if (config.features.agents) {
    pi.registerTool({
      name: "spawn_task",
      label: "Spawn Task",
      description:
        "Start an independent semantic task in another Pi process and return immediately. The shared working tree is not isolated; spawn only work that is safe to run concurrently.",
      promptSnippet: "Spawn an asynchronous worker task",
      promptGuidelines: [
        "Use spawn_task for genuinely independent work, with or without an active local task. Continue useful parent work while the worker runs.",
        "Workers share the current working tree. Avoid concurrent conflicting edits; use required_context only for completed retained summaries and available_context for optional task references.",
      ],
      parameters: SpawnTaskParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        ensureLoaded(ctx);
        if (!agents) throw new Error("Agent coordinator was not initialized for this session");
        const result = await agents.coordinator.spawn(
          {
            task: params.task,
            requiredContext: [...(params.required_context ?? [])],
            availableContext: [...(params.available_context ?? [])],
          },
          spawnExecutionContext(ctx, appendFrom(ctx)),
        );
        const details = { task_id: result.taskId, status: result.status };
        return textResult(`Spawned task ${result.taskId}; worker status is starting.`, details);
      },
    });

    pi.registerTool({
      name: "poll_task",
      label: "Poll Task",
      description: "Check one spawned worker task's compact lifecycle status without returning transcript content.",
      promptSnippet: "Poll asynchronous worker status",
      promptGuidelines: ["Poll sparingly; use join_tasks when worker results are actually needed."],
      parameters: PollTaskParams,
      executionMode: "parallel",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        ensureLoaded(ctx);
        if (!agents) throw new Error("Agent coordinator was not initialized for this session");
        const result = await agents.coordinator.poll(params.task_id);
        const details = {
          task_id: result.task.id,
          task: result.task.task,
          status: result.lifecycleStatus,
          semantic_status: result.semanticStatus,
          resolved_status: result.resolvedStatus,
          evidence: result.evidence,
          ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        };
        return textResult(JSON.stringify(details, null, 2), details);
      },
    });

    pi.registerTool({
      name: "join_tasks",
      label: "Join Tasks",
      description:
        "Wait for all requested workers (default) or the first terminal worker. Completed results include authoritative durable task summaries; failures retain their evidence source.",
      promptSnippet: "Wait for asynchronous worker results",
      promptGuidelines: [
        "Join only when results are needed. wait=all does not cancel siblings after a failure; wait=any returns when the first requested task becomes terminal.",
      ],
      parameters: JoinTasksParams,
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        ensureLoaded(ctx);
        if (!agents) throw new Error("Agent coordinator was not initialized for this session");
        const result = await agents.coordinator.join([...params.task_ids], params.wait ?? "all", signal);
        return textResult(JSON.stringify(result, null, 2), result);
      },
    });
  }

  pi.registerCommand("tasks", {
    description: "Show semantic tasks on the active branch",
    handler: async (args, ctx) => {
      ensureLoaded(ctx);
      const status = args.trim();
      if (
        status !== "" &&
        status !== "open" &&
        status !== "completed" &&
        status !== "failed" &&
        status !== "cancelled" &&
        status !== "all"
      ) {
        ctx.ui.notify("Usage: /tasks [open|completed|failed|cancelled|all]", "error");
        return;
      }
      const items = await listVisibleTasks(
        runtime,
        agents?.router,
        ctx.sessionManager.getSessionId(),
        status === "" || status === "all" ? {} : { status },
      );
      const output = formatTasks(items, runtime.snapshot.activeStack);
      ctx.ui.notify(output, "info");
    },
  });

  return {
    runtime,
    config,
    preservation,
    interactions,
    projection,
    inspector,
    ...(agents ? { agents } : {}),
    reconstruct,
    ensureLoaded,
    startWorker,
  };
}

export { stripUnretainedSummaries };
