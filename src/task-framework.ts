import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Config } from "./config.js";
import type { TaskSummary } from "./model/summary.js";
import { RetainingProjectionPlanner } from "./projection/planner.js";
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

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface TaskFrameworkServices {
  runtime: LocalTaskRuntime;
  config: Config;
  reconstruct(ctx: ExtensionContext): void;
  ensureLoaded(ctx: ExtensionContext): void;
}

export interface RegisterTaskFrameworkOptions {
  registerSessionStart?: boolean;
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
  const planner = new RetainingProjectionPlanner();
  let loadedSessionId: string | undefined;

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

  if (options.registerSessionStart !== false) {
    pi.on("session_start", (_event, ctx) => reconstruct(ctx));
  }
  pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

  if (!config.features.summaries || config.features.compaction) {
    pi.on("context", (event) => {
      let messages = event.messages;
      if (!config.features.summaries) messages = stripUnretainedSummaries(messages);
      if (config.features.compaction) messages = planner.plan(messages, []).messages;
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
      if ((params.preserve_outputs?.length ?? 0) > 0) {
        throw new Error("end_task.preserve_outputs requires the preservation milestone");
      }
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
      const result = runtime.end(
        params.task_id,
        summary,
        config.features.summaries,
        boundaryContext(ctx, toolCallId, "end_task"),
        appendFrom(ctx),
      );
      updateStatus(runtime, ctx);
      return textResult(
        `Completed task ${result.task_id}. ${
          result.restored_parent_task_id
            ? `Restored parent ${result.restored_parent_task_id}.`
            : "No local parent is active."
        }`,
        result,
      );
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

  return { runtime, config, reconstruct, ensureLoaded };
}

export { stripUnretainedSummaries };
