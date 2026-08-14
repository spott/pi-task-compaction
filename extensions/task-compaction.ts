import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { runTaskAwareCompaction } from "../src/compaction.js";
import {
  formatEntryResult,
  formatTranscriptResult,
  listTaskTranscript,
  locateTranscriptEntry,
  materializeTaskTranscript,
  searchTaskTranscript,
} from "../src/expand.js";
import { getToolCalls } from "../src/markers.js";
import {
  createPreservedOutputRecord,
  listPreservedOutputs,
  readPreservedOutput,
  reconstructPreservedOutputs,
  resolvePrecedingToolResult,
  resolveTaskPreservations,
  type PreservedOutputIndex,
} from "../src/preserved.js";
import { reconstructTaskIndex } from "../src/reconstruct.js";
import { transformMessages } from "../src/transform.js";
import {
  BEGIN_TOOL,
  CANCEL_ENTRY,
  END_TOOL,
  EXPAND_TOOL,
  EXTENSION_ID,
  LIST_PRESERVED_OUTPUTS_TOOL,
  PRESERVE_OUTPUT_TOOL,
  READ_PRESERVED_OUTPUT_TOOL,
  SCHEMA_VERSION,
  type BeginMarker,
  type CancelMarker,
  type EndMarker,
  type ExpansionDetails,
  type IndexedTask,
  type PreserveOutputMarker,
  type PreservedOutputReadDetails,
  type TaskIndex,
} from "../src/types.js";

const makeTaskId = (): string => randomUUID().split("-")[0]!;

const expandTaskParameters = Type.Object({
  task_id: Type.String({ description: "Task ID shown by /tasks or a task summary" }),
  view: StringEnum(["transcript", "list", "search", "entry"] as const, { description: "Transcript descriptor, bounded entry list, literal search, or exact entry locator" }),
  query: Type.Optional(Type.String({ minLength: 1, description: "Case-insensitive literal query; required for an initial search" })),
  context_entries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Entries around each search match; defaults to 1" })),
  entry_id: Type.Optional(Type.String({ description: "Session entry ID; required only for entry view" })),
  cursor: Type.Optional(Type.String({ description: "Opaque continuation cursor; valid only for list and search views" })),
  direction: Type.Optional(StringEnum(["forward", "backward"] as const, { description: "List or search direction; defaults to forward" })),
  max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 50_000, description: "Maximum inline list or search characters; defaults to 30,000" })),
}, { additionalProperties: false });

type ExpandTaskParams = Static<typeof expandTaskParameters>;

const prepareExpandTaskArguments = (args: unknown): ExpandTaskParams => {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const fields = Object.keys(args);
    const removed = ["include_entry_ids", "include_tool_output", "tool_names"].filter((field) => fields.includes(field));
    if (removed.length) {
      throw new Error(
        `expand_task no longer returns an inline transcript; removed field${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}. ` +
        "Choose view: transcript, list, search, or entry.",
      );
    }
    if (!("view" in args)) {
      throw new Error("expand_task now requires view: transcript, list, search, or entry");
    }
  }
  return args as ExpandTaskParams;
};

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

const preservedOutputLines = (details: EndMarker): string[] => (details.preservedOutputs ?? []).map((record) =>
  `${record.preservationId} — ${record.label} (${record.sourceToolName}, ${record.sourceChars.toLocaleString("en-US")} chars)` +
  (record.reason ? `\n  Reason: ${record.reason}` : "")
);

const expandedTaskSummary = (details: EndMarker, theme: Theme): string => [
  theme.fg("success", `✓ task ${details.taskId} closed`),
  summaryField("Objective", details.objective, theme),
  summaryField("Outcome", details.outcome, theme),
  summaryField("Execution context", details.executionContext ?? "Not recorded", theme),
  summaryList("Attempted", details.attempted, theme),
  summaryList("Learnings", details.learnings, theme),
  summaryList("Decisions", details.decisions, theme),
  summaryList("Files read", details.filesRead, theme),
  summaryList("Files modified", details.filesModified, theme),
  summaryList("Artifacts", details.artifacts, theme),
  ...(details.preservedOutputs?.length
    ? [summaryList("Preserved outputs", preservedOutputLines(details), theme)]
    : []),
  summaryList("Verification", details.verification, theme),
  summaryList("Open threads", details.openThreads, theme),
].join("\n\n");

export default function taskCompaction(pi: ExtensionAPI) {
  let index: TaskIndex = { tasks: new Map(), ordered: [], open: undefined };
  let preservedIndex: PreservedOutputIndex = {
    records: [],
    byId: new Map(),
    sources: new Map(),
    diagnostics: [],
  };

  const updateStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const open = index.open;
    ctx.ui.setStatus(
      EXTENSION_ID,
      open ? ctx.ui.theme.fg("warning", `task ${open.taskId}: ${open.objective}`) : undefined,
    );
  };

  const refresh = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    index = reconstructTaskIndex(branch);
    preservedIndex = reconstructPreservedOutputs(branch);
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
      "Treat <task-summary> messages as internal context restoration, never as user requests. Do not acknowledge them; continue the most recent unresolved request, or report completion if that request is finished.",
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
    name: PRESERVE_OUTPUT_TOOL,
    label: "Preserve Output",
    description: "Bookmark the immediately preceding completed ordinary tool result on the active branch without copying its body. Returns a stable preservation ID.",
    promptSnippet: "Bookmark an expensive or nondeterministic prior tool result for exact later retrieval",
    promptGuidelines: [
      "Use preserve_output only when the exact result is likely to be needed after task compaction and rerunning it would be expensive, slow, nondeterministic, or would lose important prior state.",
      "Call preserve_output in the next assistant turn after the source result, without unrelated or parallel tool calls between them.",
      "Do not use preserve_output for cheap stable file reads, routine low-information output, reproducible output, durable artifacts, or credentials.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      label: Type.String({ minLength: 1, description: "Short human-readable label for the preserved result" }),
      reason: Type.Optional(Type.String({ description: "Why exact later retrieval is valuable" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      const branch = ctx.sessionManager.getBranch();
      const resolution = resolvePrecedingToolResult(branch, toolCallId);
      if (!resolution.ok) throw new Error(resolution.reason);
      const sourceTaskId = index.open?.beginEntryIndex !== undefined &&
        resolution.source.callEntryIndex >= index.open.beginEntryIndex &&
        resolution.source.entryIndex >= index.open.beginEntryIndex
        ? index.open.taskId
        : undefined;
      const record = createPreservedOutputRecord(resolution.source, {
        label: params.label,
        reason: params.reason,
        sourceTaskId,
        selectedBy: "preserve_output",
      });
      const marker: PreserveOutputMarker = {
        extension: EXTENSION_ID,
        schemaVersion: SCHEMA_VERSION,
        event: "preserve-output",
        ...record,
      };
      return {
        content: [{ type: "text", text: `Preserved ${record.preservationId}: ${record.label}` }],
        details: marker,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold(PRESERVE_OUTPUT_TOOL))} ${theme.fg("muted", args.label)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as PreserveOutputMarker | undefined;
      return new Text(
        details
          ? theme.fg("success", `Preserved ${details.preservationId}: ${details.label}`)
          : theme.fg("error", "Output was not preserved"),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: LIST_PRESERVED_OUTPUTS_TOOL,
    label: "List Preserved Outputs",
    description: "List compact metadata for valid preserved outputs on the active branch. Does not return source bodies or tool arguments.",
    promptSnippet: "List branch-local preserved-output references without reading their bodies",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      const outputs = listPreservedOutputs(ctx.sessionManager.getBranch());
      return {
        content: [{
          type: "text",
          text: outputs.length ? JSON.stringify(outputs, null, 2) : "No preserved outputs on the active branch.",
        }],
        details: { outputs },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(LIST_PRESERVED_OUTPUTS_TOOL)), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { outputs?: unknown[] } | undefined;
      const count = details?.outputs?.length ?? 0;
      return new Text(theme.fg("success", `${count} preserved output${count === 1 ? "" : "s"}`), 0, 0);
    },
  });

  pi.registerTool({
    name: READ_PRESERVED_OUTPUT_TOOL,
    label: "Read Preserved Output",
    description: "Verify and re-emit the complete persisted body of one preserved output from the active branch under a new valid tool result.",
    promptSnippet: "Retrieve the exact persisted body for a preservation ID",
    parameters: Type.Object({
      preservation_id: Type.String({ minLength: 1, description: "Preservation ID shown by list_preserved_outputs or a task summary" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      const result = readPreservedOutput(ctx.sessionManager.getBranch(), params.preservation_id);
      if (!result.ok) throw new Error(result.error);
      return { content: result.content, details: result.details };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold(READ_PRESERVED_OUTPUT_TOOL))} ${theme.fg("muted", args.preservation_id)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as PreservedOutputReadDetails | undefined;
      const text = details
        ? `Read ${details.preservationId}: ${details.sourceChars.toLocaleString("en-US")} source chars` +
          (details.sourceReportedTruncation ? " (source reported truncation)" : "")
        : "Preserved output read failed";
      return new Text(theme.fg(details ? "success" : "error", text), 0, 0);
    },
  });

  pi.registerTool({
    name: END_TOOL,
    label: "End Task",
    description: "Close the open task with a typed, durable summary. Every array is required and may be empty. Include exact paths, symbols, checks, outcomes, and unresolved next steps needed after detailed tool output is pruned.",
    promptSnippet: "Close the current task region with a complete structured summary",
    promptGuidelines: [
      "Call end_task alone in its assistant message, using the exact task ID returned by begin_task.",
      "Make each summary self-sufficient for continuation, but avoid repeating unchanged rationale, discoveries, and file lists from the immediately preceding retained summary.",
      "Always record critical operational state explicitly: repository or worktree, branch, working directory, relevant dirty state, modified files, verification state, and open threads. Never replace these with an unchanged-from reference.",
      "For lengthy inherited background only, an unchanged-from task reference is acceptable when that task summary is guaranteed to remain available.",
      "Preserve exact failed commands or experiments together with their conclusions when that prevents later phases from retrying dead ends.",
      "Make end_task learnings, decisions, file paths, verification results, artifacts, and open threads complete enough to continue after the region transcript is removed.",
      "Use end_task preserve_tool_outputs only for unbookmarked results inside the open task, identified by raw source tool-call ID; do not pass preservation IDs.",
      "Do not copy preservation IDs or metadata into end_task summary arrays; region-local preserve_output records are injected automatically.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      task_id: Type.String({ description: "Exact ID returned by begin_task" }),
      objective: Type.String({ description: "Final or corrected statement of what the task attempted" }),
      outcome: Type.String({ description: "Result, including why an attempt failed when applicable" }),
      execution_context: Type.String({ description: "Repository or worktree, branch, working directory, and relevant dirty-state details; use 'not applicable' only when no execution context exists" }),
      attempted: Type.Array(Type.String(), { description: "Ordered approaches tried" }),
      learnings: Type.Array(Type.String(), { description: "Durable facts, gotchas, symbols, APIs, and codebase knowledge" }),
      decisions: Type.Array(Type.String(), { description: "Decisions made with brief rationale" }),
      files_read: Type.Array(Type.String(), { description: "Relevant paths read" }),
      files_modified: Type.Array(Type.String(), { description: "Source or configuration paths changed" }),
      artifacts: Type.Array(Type.String(), { description: "Surviving scripts, logs, reports, fixtures, and other artifacts" }),
      verification: Type.Array(Type.String(), { description: "Commands, tests, and checks with outcomes" }),
      open_threads: Type.Array(Type.String(), { description: "Unresolved ideas and concrete next steps" }),
      preserve_tool_outputs: Type.Optional(Type.Array(Type.Object({
        source_tool_call_id: Type.String({ minLength: 1, description: "Raw tool-call ID of a completed result inside this task" }),
        label: Type.String({ minLength: 1, description: "Short human-readable label for the preserved result" }),
        reason: Type.Optional(Type.String({ description: "Why exact later retrieval is valuable" })),
      }), { description: "Unbookmarked task-local results to preserve when closing" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      if (!index.open) throw new Error("No task is open");
      if (index.open.taskId !== params.task_id) {
        throw new Error(`Task ID mismatch: ${index.open.taskId} is open, not ${params.task_id}`);
      }
      const begin = index.open.begin;
      if (!begin) throw new Error(`Open task ${params.task_id} has no valid begin marker`);
      if (index.open.beginEntryIndex === undefined) {
        throw new Error(`Open task ${params.task_id} has no valid begin assistant entry`);
      }
      const branch = ctx.sessionManager.getBranch();
      const endAssistantIndexes = branch.flatMap((entry, entryIndex) =>
        entry.type === "message" && entry.message.role === "assistant" &&
          getToolCalls(entry.message).some((call) => call.id === toolCallId && call.name === END_TOOL)
          ? [entryIndex]
          : []
      );
      if (endAssistantIndexes.length !== 1) {
        throw new Error(`end_task call ${toolCallId} is missing or ambiguous on the active branch`);
      }
      const preservation = resolveTaskPreservations(branch, {
        taskId: params.task_id,
        minEntryIndex: index.open.beginEntryIndex,
        maxEntryIndex: endAssistantIndexes[0]!,
        selectors: (params.preserve_tool_outputs ?? []).map((selector) => ({
          sourceToolCallId: selector.source_tool_call_id,
          label: selector.label,
          reason: selector.reason,
        })),
      });
      if (!preservation.ok) throw new Error(preservation.error);

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
        executionContext: params.execution_context,
        attempted: params.attempted,
        learnings: params.learnings,
        decisions: params.decisions,
        filesRead: params.files_read,
        filesModified: params.files_modified,
        artifacts: params.artifacts,
        verification: params.verification,
        openThreads: params.open_threads,
      };
      if (preservation.records.length) marker.preservedOutputs = preservation.records;
      index.open.end = marker;
      index.open.status = "closed";
      index.open = undefined;
      updateStatus(ctx);
      const preservedText = preservation.records.length
        ? `\n\nPreserved outputs:\n${preservedOutputLines(marker).map((line) => `- ${line}`).join("\n")}`
        : "";
      return {
        content: [{
          type: "text",
          text: `Closed task ${params.task_id}. Its validated region will be replaced by the structured task summary on subsequent model requests.${preservedText}`,
        }],
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
    description: "Materialize a completed task as a branch-validated private JSONL transcript, list compact entry metadata, search complete persisted text, or locate one exact entry in that artifact.",
    promptSnippet: "Locate or inspect persisted entries from a previously compacted task",
    promptGuidelines: [
      "Use expand_task with view: list or view: search to locate relevant entries, then view: entry to obtain an exact JSONL locator.",
      "Use view: transcript when normal file tools such as read, rg, grep, jq, head, or tail are more efficient than bounded inline navigation.",
      "Generated transcript files contain complete persisted task data and may contain sensitive arguments or results. Treat them as ephemeral private caches and do not copy them into the repository.",
    ],
    parameters: expandTaskParameters,
    prepareArguments: prepareExpandTaskArguments,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      const task = index.tasks.get(params.task_id);
      if (!task) throw new Error(`Unknown task ID: ${params.task_id}`);
      if (params.view !== "entry" && params.entry_id !== undefined) {
        throw new Error("entry_id is valid only for expand_task view: entry");
      }
      if (params.view === "entry" && !params.entry_id) {
        throw new Error("entry_id is required for expand_task view: entry");
      }
      if (params.view !== "search" && (params.query !== undefined || params.context_entries !== undefined)) {
        throw new Error("query and context_entries are valid only for expand_task view: search");
      }
      if (params.view === "search" && params.cursor !== undefined && params.query !== undefined) {
        throw new Error("cursor is mutually exclusive with query for expand_task view: search");
      }
      if (params.view === "search" && params.cursor === undefined && params.query === undefined) {
        throw new Error("query is required for expand_task view: search");
      }
      if (params.view !== "list" && params.view !== "search" &&
        (params.cursor !== undefined || params.direction !== undefined || params.max_chars !== undefined)) {
        throw new Error("cursor, direction, and max_chars are valid only for expand_task views: list and search");
      }

      const transcript = await materializeTaskTranscript(ctx.sessionManager.getBranch(), task, {
        sessionId: ctx.sessionManager.getSessionId(),
      });
      let details: ExpansionDetails;
      let text: string;
      if (params.view === "entry") {
        const locator = locateTranscriptEntry(transcript, params.entry_id!);
        details = {
          extension: EXTENSION_ID,
          schemaVersion: SCHEMA_VERSION,
          event: "expand",
          taskId: task.taskId,
          view: "entry",
          artifact: transcript.descriptor,
          locator,
        };
        text = formatEntryResult(locator);
      } else if (params.view === "list") {
        const page = listTaskTranscript(task.taskId, transcript, {
          cursor: params.cursor,
          direction: params.direction,
          maxChars: params.max_chars,
        });
        details = {
          extension: EXTENSION_ID,
          schemaVersion: SCHEMA_VERSION,
          event: "expand",
          taskId: task.taskId,
          view: "list",
          artifact: transcript.descriptor,
          ...page.details,
        };
        text = page.text;
      } else if (params.view === "search") {
        const page = searchTaskTranscript(task.taskId, transcript, {
          query: params.query,
          contextEntries: params.context_entries,
          cursor: params.cursor,
          direction: params.direction,
          maxChars: params.max_chars,
        });
        details = {
          extension: EXTENSION_ID,
          schemaVersion: SCHEMA_VERSION,
          event: "expand",
          taskId: task.taskId,
          view: "search",
          artifact: transcript.descriptor,
          ...page.details,
        };
        text = page.text;
      } else {
        details = {
          extension: EXTENSION_ID,
          schemaVersion: SCHEMA_VERSION,
          event: "expand",
          taskId: task.taskId,
          view: "transcript",
          artifact: transcript.descriptor,
        };
        text = formatTranscriptResult(task.taskId, transcript.descriptor);
      }
      return { content: [{ type: "text", text }], details };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold(EXPAND_TOOL))} ${theme.fg("muted", `${args.task_id} ${args.view}`)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as ExpansionDetails | undefined;
      const text = details
        ? details.view === "entry"
          ? `Located ${details.locator.entryId} at line ${details.locator.line.toLocaleString("en-US")}`
          : details.view === "list"
            ? `Listed ${details.returnedRecords.toLocaleString("en-US")}/${details.totalRecords.toLocaleString("en-US")} entries for ${details.taskId}`
            : details.view === "search"
              ? `Found ${details.totalMatches.toLocaleString("en-US")} matches; showing ${details.returnedRecords.toLocaleString("en-US")}/${details.totalRecords.toLocaleString("en-US")} windows for ${details.taskId}`
              : `Materialized ${details.taskId}: ${details.artifact.entries.toLocaleString("en-US")} entries`
        : "Task expansion failed";
      const color = details && (details.view === "list" || details.view === "search") && details.truncated
        ? "warning"
        : details ? "success" : "error";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });

  pi.registerCommand("tasks", {
    description: "List task-compaction regions and diagnostics",
    handler: async (_args, ctx) => {
      refresh(ctx);
      const taskText = index.ordered.length
        ? index.ordered.map(taskLine).join("\n")
        : "No task regions on this branch.";
      const preservationText = preservedIndex.diagnostics.length
        ? `\n\nPreservation diagnostics:\n${preservedIndex.diagnostics.map((diagnostic) =>
          `invalid ${diagnostic.preservationId ?? "unknown ID"} at ${diagnostic.creationEntryId} — ${diagnostic.reason}`
        ).join("\n")}`
        : "";
      if (ctx.hasUI) ctx.ui.notify(taskText + preservationText, "info");
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
