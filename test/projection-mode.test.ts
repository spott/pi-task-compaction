import { describe, expect, it } from "vitest";
import taskCompaction from "../extensions/task-compaction.js";
import { TASK_PROJECTION_ENABLED, TASK_PROJECTION_MODE } from "../src/projection-mode.js";
import { transformMessages } from "../src/transform.js";
import { closedTaskMessages } from "./fixtures.js";

interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

const registerShadowExtension = () => {
  const handlers = new Map<string, unknown[]>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Set<string>();
  const pi = {
    on(event: string, handler: unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    registerCommand(name: string) { commands.add(name); },
    appendEntry() {},
  };
  taskCompaction(pi as never);
  return { handlers, tools, commands };
};

const MAIN_TOOL_METADATA = {
  begin_task: {
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
  },
  preserve_output: {
    description: "Bookmark the immediately preceding completed ordinary tool result on the active branch without copying its body. Returns a stable preservation ID.",
    promptSnippet: "Bookmark an expensive or nondeterministic prior tool result for exact later retrieval",
    promptGuidelines: [
      "Use preserve_output only when the exact result is likely to be needed after task compaction and rerunning it would be expensive, slow, nondeterministic, or would lose important prior state.",
      "Call preserve_output in the next assistant turn after the source result, without unrelated or parallel tool calls between them.",
      "Do not use preserve_output for cheap stable file reads, routine low-information output, reproducible output, durable artifacts, or credentials.",
    ],
  },
  list_preserved_outputs: {
    description: "List compact metadata for valid preserved outputs on the active branch. Does not return source bodies or tool arguments.",
    promptSnippet: "List branch-local preserved-output references without reading their bodies",
    promptGuidelines: [],
  },
  read_preserved_output: {
    description: "Verify and re-emit the complete persisted body of one preserved output from the active branch under a new valid tool result.",
    promptSnippet: "Retrieve the exact persisted body for a preservation ID",
    promptGuidelines: [],
  },
  end_task: {
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
  },
  expand_task: {
    description: "Materialize a completed task as a branch-validated private JSONL transcript, list compact entry metadata, search complete persisted text, or locate one exact entry in that artifact.",
    promptSnippet: "Locate or inspect persisted entries from a previously compacted task",
    promptGuidelines: [
      "Use expand_task with view: list or view: search to locate relevant entries, then view: entry to obtain an exact JSONL locator.",
      "Use view: transcript when normal file tools such as read, rg, grep, jq, head, or tail are more efficient than bounded inline navigation.",
      "Generated transcript files contain complete persisted task data and may contain sensitive arguments or results. Treat them as ephemeral private caches and do not copy them into the repository.",
    ],
  },
} as const;

describe("projection-disabled extension entrypoint", () => {
  it("fixes the branch in disabled shadow mode and registers only non-projecting events", () => {
    const { handlers, tools, commands } = registerShadowExtension();

    expect(TASK_PROJECTION_ENABLED).toBe(false);
    expect(TASK_PROJECTION_MODE).toBe("disabled-shadow");
    expect([...handlers.keys()].sort()).toEqual([
      "input",
      "session_compact",
      "session_start",
      "session_tree",
    ]);
    expect(handlers.has("context")).toBe(false);
    expect(handlers.has("session_before_compact")).toBe(false);
    expect([...tools.keys()].sort()).toEqual([
      "begin_task",
      "end_task",
      "expand_task",
      "list_preserved_outputs",
      "preserve_output",
      "read_preserved_output",
    ]);
    expect([...commands].sort()).toEqual(["cancel-task", "tasks"]);
  });

  it("keeps the exact main-branch model-facing tool metadata", () => {
    const { tools } = registerShadowExtension();
    const metadata = Object.fromEntries([...tools].map(([name, tool]) => [name, {
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines ?? [],
    }]));

    expect(metadata).toEqual(MAIN_TOOL_METADATA);
  });

  it("leaves valid closed-task messages without an entrypoint callback that can project them", () => {
    const messages = closedTaskMessages("shadow-raw-context");
    const fullProjection = transformMessages(messages);
    const { handlers } = registerShadowExtension();

    expect(fullProjection.diagnostics).toContainEqual(expect.objectContaining({
      taskId: "shadow-raw-context",
      accepted: true,
    }));
    expect(fullProjection.messages).not.toEqual(messages);
    expect(handlers.get("context")).toBeUndefined();
  });
});
