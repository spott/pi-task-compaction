import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Config } from "./config.js";
import { LocalTaskInspector } from "./inspect/inspect.js";
import type { TaskSummary } from "./model/summary.js";
import type { RunRegistry } from "./store/run-registry.js";
import type { WorkerBootstrap } from "./workers/bootstrap.js";
import { WorkerTaskRouter } from "./workers/coordinator.js";
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
  worker?: {
    bootstrap: WorkerBootstrap;
    registry: RunRegistry;
    router: WorkerTaskRouter;
  };
  reconstruct(ctx: ExtensionContext): void;
  ensureLoaded(ctx: ExtensionContext): void;
  startWorker(ctx: ExtensionContext): Promise<void>;
}

export interface RegisterTaskFrameworkOptions {
  registerSessionStart?: boolean;
  worker?: {
    bootstrap: WorkerBootstrap;
    registry: RunRegistry;
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

function formatTasks(runtime: LocalTaskRuntime): string {
  const items = runtime.list();
  if (items.length === 0) return "No tasks on the active branch.";
  return items
    .map((item) => {
      const indent = "  ".repeat(Math.max(0, item.semanticDepth - 1));
      const active = runtime.snapshot.activeStack.includes(item.id) ? " *" : "";
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

export function registerTaskFramework(
  pi: ExtensionAPI,
  config: Config,
  options: RegisterTaskFrameworkOptions = {},
): TaskFrameworkServices | undefined {
  if (!config.features.tasks) return undefined;

  const store = new PiTaskEventStore(pi);
  const runtime = new LocalTaskRuntime(config, randomUUID());
  const preservation = new PreservationService(runtime);
  const interactions = new InteractionService(runtime);
  const planner = new LocalProjectionPlanner();
  const projection: ProjectionDiagnostics = { rejectionCounts: new Map() };
  const inspector = new LocalTaskInspector(runtime, { projection });
  const worker = options.worker
    ? {
        ...options.worker,
        router: new WorkerTaskRouter(options.worker.registry, options.worker.bootstrap.sessionId, options.worker.bootstrap),
      }
    : undefined;
  let loadedSessionId: string | undefined;
  let workerStarted = false;

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
    if (!worker || workerStarted) return;
    ensureLoaded(ctx);
    const bootstrap = worker.bootstrap;
    if (
      ctx.sessionManager.getSessionId() !== bootstrap.sessionId ||
      ctx.sessionManager.getSessionFile() !== bootstrap.sessionFile
    ) {
      throw new Error(`Worker process did not adopt pre-created session ${bootstrap.sessionId}`);
    }
    runtime.adoptAssignedRoot(bootstrap.taskId, appendFrom(ctx));
    await worker.registry.updateWorker(bootstrap.workerId, {
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
  if (worker) {
    pi.on("session_shutdown", async (_event, ctx) => {
      ensureLoaded(ctx);
      const assigned = runtime.snapshot.tasks.get(worker.bootstrap.taskId);
      if (assigned?.status === "open") {
        runtime.failOpenTasks(
          "Worker process shut down without completing its assigned root task",
          ctx.sessionManager.getSessionId(),
          () => ctx.sessionManager.getLeafId(),
          appendFrom(ctx),
        );
      }
      const terminal = runtime.snapshot.tasks.get(worker.bootstrap.taskId);
      await worker.registry.updateWorker(worker.bootstrap.workerId, {
        status: terminal?.status === "completed" ? "completed" : terminal?.status === "cancelled" ? "cancelled" : "failed",
        exitCode: terminal?.status === "completed" ? 0 : 1,
        exitedAt: Date.now(),
        ...(terminal?.status === "completed"
          ? {}
          : { diagnostics: terminal?.status === "failed" ? "Worker-owned task stream records failure" : "Worker exited without successful task completion" }),
      });
      await worker.registry.releaseLease(worker.bootstrap.workerId);
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
      const result = preservation.read(params.output_id, ctx.sessionManager);
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
      const result = await inspector.inspect(params, ctx.sessionManager);
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
      const tasks = runtime.list(query);
      return textResult(JSON.stringify({ tasks, active_stack: runtime.snapshot.activeStack }, null, 2), {
        tasks,
        active_stack: [...runtime.snapshot.activeStack],
        reconstruction_issues: [...runtime.snapshot.issues],
      });
    },
  });

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
      const output = status === "" || status === "all"
        ? formatTasks(runtime)
        : runtime
            .list({ status })
            .map((item) => `- [${item.status}] ${item.id} ${item.task}`)
            .join("\n") || `No ${status} tasks.`;
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
    ...(worker ? { worker } : {}),
    reconstruct,
    ensureLoaded,
    startWorker,
  };
}

export { stripUnretainedSummaries };
