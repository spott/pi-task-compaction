import { randomUUID } from "node:crypto";
import { keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runTaskAwareCompaction } from "../src/compaction.js";
import { expandTaskTranscript } from "../src/expand.js";
import { reconstructTaskIndex } from "../src/reconstruct.js";
import { transformMessages } from "../src/transform.js";
import {
  BEGIN_TOOL,
  CANCEL_ENTRY,
  END_TOOL,
  EXPAND_TOOL,
  EXTENSION_ID,
  SCHEMA_VERSION,
  type BeginMarker,
  type CancelMarker,
  type EndMarker,
  type ExpansionDetails,
  type IndexedTask,
  type TaskIndex,
} from "../src/types.js";

const makeTaskId = (): string => randomUUID().split("-")[0]!;

const formatRatio = (task: IndexedTask): string => {
  if (!task.rawChars || !task.summaryChars) return "n/a";
  return `${(task.rawChars / task.summaryChars).toFixed(1)}:1`;
};

const taskLine = (task: IndexedTask): string => {
  const baseDetails = task.status === "closed"
    ? `compression ${formatRatio(task)}`
    : task.rejectionReason ?? "";
  const details = [baseDetails, task.expansionCount ? `expanded ${task.expansionCount}×` : ""].filter(Boolean).join(", ");
  return `${task.status.padEnd(9)} ${task.taskId}  ${task.objective}${details ? ` — ${details}` : ""}`;
};

const compactText = (value: string, maxChars = 160): string => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
};

const summaryField = (label: string, value: string, theme: Theme): string =>
  `${theme.fg("accent", label)}\n${theme.fg("toolOutput", value || "(none)")}`;

const summaryList = (label: string, values: string[], theme: Theme): string => {
  const body = values.length
    ? values.map((value) => `• ${value.replace(/\n/g, "\n  ")}`).join("\n")
    : "(none)";
  return `${theme.fg("accent", label)}\n${theme.fg(values.length ? "toolOutput" : "dim", body)}`;
};

const expandedTaskSummary = (details: EndMarker, theme: Theme): string => [
  theme.fg("success", `✓ task ${details.taskId} closed`),
  summaryField("Objective", details.objective, theme),
  summaryField("Outcome", details.outcome, theme),
  summaryList("Attempted", details.attempted, theme),
  summaryList("Learnings", details.learnings, theme),
  summaryList("Decisions", details.decisions, theme),
  summaryList("Files read", details.filesRead, theme),
  summaryList("Files modified", details.filesModified, theme),
  summaryList("Artifacts", details.artifacts, theme),
  summaryList("Verification", details.verification, theme),
  summaryList("Open threads", details.openThreads, theme),
].join("\n\n");

export default function taskCompaction(pi: ExtensionAPI) {
  let index: TaskIndex = { tasks: new Map(), ordered: [], open: undefined };

  const updateStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const open = index.open;
    ctx.ui.setStatus(
      EXTENSION_ID,
      open ? ctx.ui.theme.fg("warning", `task ${open.taskId}: ${open.objective}`) : undefined,
    );
  };

  const refresh = (ctx: ExtensionContext) => {
    index = reconstructTaskIndex(ctx.sessionManager.getBranch());
    updateStatus(ctx);
  };

  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  pi.on("session_compact", (_event, ctx) => refresh(ctx));

  pi.on("context", (event, ctx) => {
    refresh(ctx);
    const result = transformMessages(event.messages);
    return { messages: result.messages };
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" && index.open && ctx.hasUI) {
      ctx.ui.notify(
        `Task ${index.open.taskId} is open. A user interruption makes its region ineligible for pruning; let the agent finish it or run /cancel-task.`,
        "warning",
      );
    }
    return { action: "continue" };
  });

  pi.on("session_before_compact", async (event, ctx) => runTaskAwareCompaction(event, ctx));

  pi.registerTool({
    name: BEGIN_TOOL,
    label: "Begin Task",
    description: "Open one bounded, tool-heavy phase of work whose details can later be replaced by a durable summary. Returns the task ID required by end_task.",
    promptSnippet: "Open a bounded task region before substantial disposable exploration",
    promptGuidelines: [
      "Use begin_task for one bounded, tool-heavy phase of work whose detailed transcript can later be discarded.",
      "A single user request or project may contain multiple sequential task regions. Do not treat the entire request as one task merely because it has one overall objective.",
      "Scope each region around one durable milestone, such as codebase exploration and an implementation plan, one coherent implementation slice, diagnosis of a specific failure, one experiment or benchmark, or final integration and verification.",
      "Treat roughly 4k–8k disposable tokens as a target region size, not only as a minimum for using begin_task. If a phase is likely to grow substantially beyond that, divide it at the next coherent milestone.",
      "Close the current region before changing work phases—for example, when moving from exploration to implementation, implementation to debugging, or debugging to final verification. Do not keep a region open solely because the overall user request is unfinished.",
      "Prefer multiple meaningful sequential regions over one project-wide region. Do not fragment closely related edits and checks into tiny regions.",
      "Do not use begin_task for a single read, command, tiny edit, or user-facing discussion.",
      "Call begin_task alone in its assistant message, then perform that phase without waiting for user input.",
      "Call end_task alone as soon as the phase reaches its milestone. Make its summary sufficient to continue after the detailed transcript is removed.",
      "After end_task completes, if another substantial phase remains, open a new task with begin_task alone and continue without waiting for the user. If only small follow-up work remains, complete it without opening another region.",
      "User-facing discussion should occur only after the current task region has been closed.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      objective: Type.String({ description: "Concise objective for the bounded investigation or experiment" }),
      expected_scope: Type.Optional(Type.String({ description: "What work and tool activity is expected to belong to this region" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      if (index.open) throw new Error(`Task ${index.open.taskId} is already open; close or cancel it first`);
      const taskId = makeTaskId();
      const marker: BeginMarker = {
        extension: EXTENSION_ID,
        schemaVersion: SCHEMA_VERSION,
        event: "begin",
        taskId,
        objective: params.objective,
        expectedScope: params.expected_scope,
        toolCallId,
        assistantEntryId: ctx.sessionManager.getLeafId() ?? undefined,
      };
      const task: IndexedTask = { taskId, objective: params.objective, status: "open", begin: marker };
      index.tasks.set(taskId, task);
      index.ordered.push(task);
      index.open = task;
      updateStatus(ctx);
      return {
        content: [{ type: "text", text: `Opened task ${taskId}: ${params.objective}. Perform the bounded work now, then call end_task alone with a complete durable summary.` }],
        details: marker,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold(BEGIN_TOOL))} ${theme.fg("muted", args.objective)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as BeginMarker | undefined;
      return new Text(details ? theme.fg("warning", `○ task ${details.taskId} open`) : theme.fg("error", "Task was not opened"), 0, 0);
    },
  });

  pi.registerTool({
    name: END_TOOL,
    label: "End Task",
    description: "Close the open task with a typed, durable summary. Every array is required and may be empty. Include exact paths, symbols, checks, outcomes, and unresolved next steps needed after detailed tool output is pruned.",
    promptSnippet: "Close the current task region with a complete structured summary",
    promptGuidelines: [
      "Call end_task alone in its assistant message, using the exact task ID returned by begin_task.",
      "Make end_task learnings, decisions, file paths, verification results, artifacts, and open threads complete enough to continue after the region transcript is removed.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      task_id: Type.String({ description: "Exact ID returned by begin_task" }),
      objective: Type.String({ description: "Final or corrected statement of what the task attempted" }),
      outcome: Type.String({ description: "Result, including why an attempt failed when applicable" }),
      attempted: Type.Array(Type.String(), { description: "Ordered approaches tried" }),
      learnings: Type.Array(Type.String(), { description: "Durable facts, gotchas, symbols, APIs, and codebase knowledge" }),
      decisions: Type.Array(Type.String(), { description: "Decisions made with brief rationale" }),
      files_read: Type.Array(Type.String(), { description: "Relevant paths read" }),
      files_modified: Type.Array(Type.String(), { description: "Source or configuration paths changed" }),
      artifacts: Type.Array(Type.String(), { description: "Surviving scripts, logs, reports, fixtures, and other artifacts" }),
      verification: Type.Array(Type.String(), { description: "Commands, tests, and checks with outcomes" }),
      open_threads: Type.Array(Type.String(), { description: "Unresolved ideas and concrete next steps" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      if (!index.open) throw new Error("No task is open");
      if (index.open.taskId !== params.task_id) {
        throw new Error(`Task ID mismatch: ${index.open.taskId} is open, not ${params.task_id}`);
      }
      const begin = index.open.begin;
      if (!begin) throw new Error(`Open task ${params.task_id} has no valid begin marker`);
      const marker: EndMarker = {
        extension: EXTENSION_ID,
        schemaVersion: SCHEMA_VERSION,
        event: "end",
        taskId: params.task_id,
        beginToolCallId: begin.toolCallId,
        endToolCallId: toolCallId,
        assistantEntryId: ctx.sessionManager.getLeafId() ?? undefined,
        objective: params.objective,
        outcome: params.outcome,
        attempted: params.attempted,
        learnings: params.learnings,
        decisions: params.decisions,
        filesRead: params.files_read,
        filesModified: params.files_modified,
        artifacts: params.artifacts,
        verification: params.verification,
        openThreads: params.open_threads,
      };
      index.open.end = marker;
      index.open.status = "closed";
      index.open = undefined;
      updateStatus(ctx);
      return {
        content: [{ type: "text", text: `Closed task ${params.task_id}. Its validated region will be replaced by the structured task summary on subsequent model requests.` }],
        details: marker,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold(END_TOOL))} ${theme.fg("muted", args.task_id)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as EndMarker | undefined;
      if (!details) return new Text(theme.fg("error", "Task was not closed"), 0, 0);
      if (expanded) return new Text(expandedTaskSummary(details, theme), 0, 0);

      const outcome = compactText(details.outcome) || "no outcome supplied";
      const text = `${theme.fg("success", `✓ task ${details.taskId} closed`)} ${theme.fg("muted", `— ${outcome}`)}` +
        ` (${keyHint("app.tools.expand", "to view summary")})`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: EXPAND_TOOL,
    label: "Expand Task",
    description: "Recover a bounded plain-text serialization of a task's original transcript from the current session branch. Output is capped and tool results are already serialization-truncated.",
    promptSnippet: "Recover details from a previously compacted task region",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID shown by /tasks or a task summary" }),
      max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, description: "Hard output budget; default 30000" })),
      include_entry_ids: Type.Optional(Type.Boolean({ description: "Include session entry IDs for diagnostics" })),
      include_tool_output: Type.Optional(Type.Boolean({ description: "Include serialized tool output; default true" })),
      tool_names: Type.Optional(Type.Array(Type.String(), { description: "If set, include tool results only for these tool names" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      const task = index.tasks.get(params.task_id);
      if (!task) throw new Error(`Unknown task ID: ${params.task_id}`);
      const expanded = expandTaskTranscript(ctx.sessionManager.getBranch(), task, {
        maxChars: params.max_chars ?? 30000,
        includeEntryIds: params.include_entry_ids ?? false,
        includeToolOutput: params.include_tool_output ?? true,
        toolNames: params.tool_names,
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
      const details: ExpansionDetails = {
        extension: EXTENSION_ID,
        schemaVersion: SCHEMA_VERSION,
        event: "expand",
        taskId: task.taskId,
        truncated: expanded.truncated,
        returnedChars: expanded.returnedChars,
      };
      return { content: [{ type: "text", text: expanded.text }], details };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold(EXPAND_TOOL))} ${theme.fg("muted", args.task_id)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as ExpansionDetails | undefined;
      const text = details
        ? `Expanded ${details.taskId}: ${details.returnedChars.toLocaleString()} chars${details.truncated ? " (truncated)" : ""}`
        : "Task expansion failed";
      return new Text(theme.fg(details?.truncated ? "warning" : "success", text), 0, 0);
    },
  });

  pi.registerCommand("tasks", {
    description: "List task-compaction regions and diagnostics",
    handler: async (_args, ctx) => {
      refresh(ctx);
      const text = index.ordered.length ? index.ordered.map(taskLine).join("\n") : "No task regions on this branch.";
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("cancel-task", {
    description: "Mark the open task abandoned and leave its transcript unpruned",
    handler: async (args, ctx) => {
      refresh(ctx);
      if (!index.open) {
        if (ctx.hasUI) ctx.ui.notify("No task is open.", "warning");
        return;
      }
      const requested = args.trim().split(/\s+/, 1)[0];
      if (requested && requested !== index.open.taskId) {
        if (ctx.hasUI) ctx.ui.notify(`Task ${index.open.taskId} is open, not ${requested}.`, "error");
        return;
      }
      const marker: CancelMarker = {
        extension: EXTENSION_ID,
        schemaVersion: SCHEMA_VERSION,
        event: "cancel",
        taskId: index.open.taskId,
        reason: args.trim().slice(requested?.length ?? 0).trim() || undefined,
      };
      pi.appendEntry(CANCEL_ENTRY, marker);
      const taskId = index.open.taskId;
      index.open.status = "cancelled";
      index.open.cancel = marker;
      index.open = undefined;
      updateStatus(ctx);
      if (ctx.hasUI) ctx.ui.notify(`Cancelled task ${taskId}; its raw transcript will remain in context.`, "info");
    },
  });
}
