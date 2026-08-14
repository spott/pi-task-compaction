import { describe, expect, it } from "vitest";
import taskCompaction from "../extensions/task-compaction.js";
import {
  END_TOOL,
  LIST_PRESERVED_OUTPUTS_TOOL,
  PRESERVE_OUTPUT_TOOL,
  READ_PRESERVED_OUTPUT_TOOL,
  type EndMarker,
} from "../src/types.js";
import { assistant, beginMarker, entriesFor, toolResult } from "./fixtures.js";

const registeredTools = () => {
  const tools = new Map<string, any>();
  const pi = {
    on() {},
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry() {},
  };
  taskCompaction(pi as never);
  return tools;
};

const contextFor = (branch: ReturnType<typeof entriesFor>) => ({
  hasUI: false,
  sessionManager: {
    getBranch: () => branch,
    getLeafId: () => branch.at(-1)?.id,
    getSessionFile: () => undefined,
  },
});

describe("preserved output extension integration", () => {
  it("registers all three preservation tools", () => {
    const tools = registeredTools();
    expect(tools.has(PRESERVE_OUTPUT_TOOL)).toBe(true);
    expect(tools.has(LIST_PRESERVED_OUTPUTS_TOOL)).toBe(true);
    expect(tools.has(READ_PRESERVED_OUTPUT_TOOL)).toBe(true);
  });

  it("preserves, lists, and reads an immediate source without leaking its body into metadata", async () => {
    const branch = entriesFor([
      assistant([{ id: "source-call", name: "mcp_fetch", arguments: { token: "source-argument" } }]),
      toolResult("source-call", "mcp_fetch", undefined, "exact remote body"),
      assistant([{ id: "preserve-call", name: PRESERVE_OUTPUT_TOOL, arguments: { label: "remote snapshot" } }]),
    ]);
    const tools = registeredTools();
    const preserveResult = await tools.get(PRESERVE_OUTPUT_TOOL).execute(
      "preserve-call",
      { label: "remote snapshot", reason: "nondeterministic" },
      undefined,
      undefined,
      contextFor(branch),
    );
    const marker = preserveResult.details;
    branch.push({
      type: "message",
      id: "preserve-result",
      parentId: branch.at(-1)!.id,
      timestamp: new Date().toISOString(),
      message: toolResult("preserve-call", PRESERVE_OUTPUT_TOOL, marker),
    });

    const listResult = await tools.get(LIST_PRESERVED_OUTPUTS_TOOL).execute(
      "list-call",
      {},
      undefined,
      undefined,
      contextFor(branch),
    );
    expect(listResult.content[0].text).toContain("remote snapshot");
    expect(listResult.content[0].text).not.toContain("exact remote body");
    expect(listResult.content[0].text).not.toContain("source-argument");

    const readResult = await tools.get(READ_PRESERVED_OUTPUT_TOOL).execute(
      "read-call",
      { preservation_id: marker.preservationId },
      undefined,
      undefined,
      contextFor(branch),
    );
    expect(readResult.content).toEqual([{ type: "text", text: "exact remote body" }]);
    expect(readResult.details).toMatchObject({
      preservationId: marker.preservationId,
      sourceToolCallId: "source-call",
      sourceIsError: false,
    });
  });

  it("resolves delayed selectors and injects records into the end marker and result", async () => {
    const begin = beginMarker();
    const branch = entriesFor([
      assistant([{ id: begin.toolCallId, name: "begin_task", arguments: { objective: begin.objective } }]),
      toolResult(begin.toolCallId, "begin_task", begin),
      assistant([{ id: "expensive-call", name: "mcp_fetch" }]),
      toolResult("expensive-call", "mcp_fetch", undefined, "nondeterministic body"),
      assistant([{ id: "end-task1", name: END_TOOL, arguments: { task_id: "task1" } }]),
    ]);
    const endTool = registeredTools().get(END_TOOL);
    const result = await endTool.execute("end-task1", {
      task_id: "task1",
      objective: "Explore task1",
      outcome: "Found the answer",
      execution_context: "repo /tmp/project; branch main; cwd /tmp/project; clean worktree",
      attempted: [],
      learnings: [],
      decisions: [],
      files_read: [],
      files_modified: [],
      artifacts: [],
      verification: [],
      open_threads: [],
      preserve_tool_outputs: [{
        source_tool_call_id: "expensive-call",
        label: "live snapshot",
        reason: "nondeterministic",
      }],
    }, undefined, undefined, contextFor(branch));

    const marker = result.details as EndMarker;
    expect(marker.preservedOutputs).toHaveLength(1);
    expect(marker.preservedOutputs?.[0]).toMatchObject({
      label: "live snapshot",
      reason: "nondeterministic",
      sourceTaskId: "task1",
      sourceToolCallId: "expensive-call",
      sourceToolName: "mcp_fetch",
      selectedBy: "end_task",
    });
    expect(result.content[0].text).toContain("Preserved outputs:");
    expect(result.content[0].text).toContain("live snapshot");
    expect(result.content[0].text).not.toContain("nondeterministic body");
  });
});
