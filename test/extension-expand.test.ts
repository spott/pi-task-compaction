import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import taskCompaction from "../extensions/task-compaction.js";
import { parseExpansionDetails } from "../src/markers.js";
import { reconstructTaskIndex } from "../src/reconstruct.js";
import { EXPAND_TOOL } from "../src/types.js";
import { closedTaskMessages, entriesFor, toolResult } from "./fixtures.js";

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

const contextFor = (branch: ReturnType<typeof entriesFor>, sessionId: string) => ({
  hasUI: false,
  sessionManager: {
    getBranch: () => branch,
    getLeafId: () => branch.at(-1)?.id,
    getSessionFile: () => undefined,
    getSessionId: () => sessionId,
  },
});

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("expand_task extension integration", () => {
  it("registers strict view-based arguments, model guidance, and actionable migration errors", () => {
    const tool = registeredTools().get(EXPAND_TOOL);
    expect(tool).toBeDefined();
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.promptGuidelines.join("\n")).toContain("view: list or view: search");
    expect(tool.promptGuidelines.join("\n")).toContain("do not copy them into the repository");

    expect(() => tool.prepareArguments({
      task_id: "old",
      include_entry_ids: true,
      include_tool_output: false,
      tool_names: ["read"],
    })).toThrow("no longer returns an inline transcript");
    expect(() => tool.prepareArguments({ task_id: "missing-view", max_chars: 1_000 }))
      .toThrow("now requires view");
    expect(tool.prepareArguments({ task_id: "new", view: "list", max_chars: 1_000 }))
      .toEqual({ task_id: "new", view: "list", max_chars: 1_000 });
  });

  it("executes, parses, and renders transcript, list, search, and entry views", async () => {
    const branch = entriesFor(closedTaskMessages("integration"));
    const tool = registeredTools().get(EXPAND_TOOL);
    const context = contextFor(branch, `expand-integration-${process.pid}-${Date.now()}`);
    const execute = (params: Record<string, unknown>) =>
      tool.execute("expand-call", params, undefined, undefined, context);

    let artifactDirectory: string | undefined;
    try {
      const transcript = await execute({ task_id: "integration", view: "transcript" });
      artifactDirectory = dirname(transcript.details.artifact.path);
      expect(transcript.details.artifact.path.startsWith(process.cwd())).toBe(false);
      expect(transcript.content[0].text).toContain(transcript.details.artifact.path);
      expect(transcript.content[0].text).not.toContain("x".repeat(100));
      expect(parseExpansionDetails(transcript.details, EXPAND_TOOL)).toEqual(transcript.details);

      const list = await execute({ task_id: "integration", view: "list", max_chars: 1_000 });
      expect(list.content[0].text.length).toBeLessThanOrEqual(1_000);
      expect(list.content[0].text).toContain('path="src/read.ts"');
      expect(list.content[0].text).not.toContain("x".repeat(100));
      expect(parseExpansionDetails(list.details, EXPAND_TOOL)).toEqual(list.details);

      const search = await execute({
        task_id: "integration",
        view: "search",
        query: "src/read.ts",
        context_entries: 0,
        max_chars: 1_000,
      });
      expect(search.content[0].text.length).toBeLessThanOrEqual(1_000);
      expect(search.details.totalMatches).toBeGreaterThan(0);
      expect(search.content[0].text).toContain("src/read.ts");
      expect(parseExpansionDetails(search.details, EXPAND_TOOL)).toEqual(search.details);

      const entry = await execute({ task_id: "integration", view: "entry", entry_id: branch[3]!.id });
      expect(entry.details.locator).toMatchObject({
        path: transcript.details.artifact.path,
        entryId: branch[3]!.id,
        line: 4,
      });
      expect(parseExpansionDetails(entry.details, EXPAND_TOOL)).toEqual(entry.details);

      for (const result of [transcript, list, search, entry]) {
        expect(result.details.artifact).toEqual(transcript.details.artifact);
        const rendered = tool.renderResult(result, { expanded: false }, plainTheme, {}).render(200).join("\n");
        expect(rendered).toMatch(/Materialized|Listed|Found|Located/);
      }

      const withExpansionResults = [...branch];
      for (const [index, result] of [transcript, list, search, entry].entries()) {
        withExpansionResults.push({
          type: "message",
          id: `expansion-result-${index}`,
          parentId: withExpansionResults.at(-1)!.id,
          timestamp: new Date().toISOString(),
          message: toolResult(`expand-call-${index}`, EXPAND_TOOL, result.details),
        });
      }
      expect(reconstructTaskIndex(withExpansionResults).tasks.get("integration")?.expansionCount).toBe(4);
    } finally {
      if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
    }
  });

  it("rejects fields that do not apply to the selected view", async () => {
    const branch = entriesFor(closedTaskMessages("validation"));
    const tool = registeredTools().get(EXPAND_TOOL);
    const context = contextFor(branch, `expand-validation-${process.pid}-${Date.now()}`);
    const execute = (params: Record<string, unknown>) =>
      tool.execute("expand-call", params, undefined, undefined, context);

    await expect(execute({ task_id: "validation", view: "transcript", max_chars: 1_000 }))
      .rejects.toThrow("valid only for expand_task views: list and search");
    await expect(execute({ task_id: "validation", view: "entry" }))
      .rejects.toThrow("entry_id is required");
    await expect(execute({ task_id: "validation", view: "entry", entry_id: branch[3]!.id, max_chars: 1_000 }))
      .rejects.toThrow("valid only for expand_task views: list and search");
    await expect(execute({ task_id: "validation", view: "list", query: "needle" }))
      .rejects.toThrow("valid only for expand_task view: search");
    await expect(execute({ task_id: "validation", view: "search" }))
      .rejects.toThrow("query is required");
    await expect(execute({ task_id: "validation", view: "search", query: "needle", cursor: "opaque" }))
      .rejects.toThrow("mutually exclusive");
  });
});
