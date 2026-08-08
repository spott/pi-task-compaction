import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { expandTaskTranscript } from "../src/expand.js";
import { reconstructTaskIndex } from "../src/reconstruct.js";
import { CANCEL_ENTRY, EXTENSION_ID, SCHEMA_VERSION } from "../src/types.js";
import { assistant, beginMarker, closedTaskMessages, entriesFor, toolResult } from "./fixtures.js";

describe("branch-aware reconstruction and recovery", () => {
  it("reconstructs state independently after a tree branch change", () => {
    const closedBranch = entriesFor(closedTaskMessages("closed"));
    const begin = beginMarker("open");
    const openBranch = entriesFor([
      assistant([{ id: begin.toolCallId, name: "begin_task" }]),
      toolResult(begin.toolCallId, "begin_task", begin),
    ]);

    expect(reconstructTaskIndex(closedBranch).tasks.get("closed")?.status).toBe("closed");
    expect(reconstructTaskIndex(closedBranch).open).toBeUndefined();
    expect(reconstructTaskIndex(openBranch).open?.taskId).toBe("open");
  });

  it("honors a branch-local cancellation entry", () => {
    const begin = beginMarker("abandoned");
    const branch = entriesFor([
      assistant([{ id: begin.toolCallId, name: "begin_task" }]),
      toolResult(begin.toolCallId, "begin_task", begin),
    ]);
    branch.push({
      type: "custom",
      id: "cancel",
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      customType: CANCEL_ENTRY,
      data: {
        extension: EXTENSION_ID,
        schemaVersion: SCHEMA_VERSION,
        event: "cancel",
        taskId: "abandoned",
      },
    } as SessionEntry);
    const index = reconstructTaskIndex(branch);
    expect(index.tasks.get("abandoned")?.status).toBe("cancelled");
    expect(index.open).toBeUndefined();
  });

  it("serializes and hard-caps the original task transcript", () => {
    const branch = entriesFor(closedTaskMessages("recover"));
    const task = reconstructTaskIndex(branch).tasks.get("recover")!;
    const expanded = expandTaskTranscript(branch, task, {
      maxChars: 1200,
      includeEntryIds: true,
      includeToolOutput: true,
      sessionFile: "/tmp/session.jsonl",
    });
    expect(expanded.truncated).toBe(true);
    expect(expanded.text.length).toBeLessThanOrEqual(1200);
    expect(expanded.text).toContain("Expansion truncated");
    expect(expanded.text).toContain("/tmp/session.jsonl");
  });

  it("can omit tool output during recovery", () => {
    const branch = entriesFor(closedTaskMessages("recover"));
    const task = reconstructTaskIndex(branch).tasks.get("recover")!;
    const expanded = expandTaskTranscript(branch, task, {
      maxChars: 10000,
      includeEntryIds: false,
      includeToolOutput: false,
    });
    expect(expanded.text).toContain("[Tool result read omitted]");
    expect(expanded.text).not.toContain("x".repeat(100));
  });
});
