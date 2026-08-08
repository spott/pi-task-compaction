import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectCompaction } from "../src/compaction.js";
import { assistant, beginMarker, closedTaskMessages, entriesFor, toolResult, user } from "./fixtures.js";

const eventFor = (branchEntries: SessionEntry[], firstKeptEntryId: string): SessionBeforeCompactEvent => ({
  type: "session_before_compact",
  preparation: {
    firstKeptEntryId,
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 50000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  },
  branchEntries,
  reason: "threshold",
  willRetry: false,
  signal: new AbortController().signal,
});

describe("task-aware global compaction projection", () => {
  it("moves a kept boundary inside a closed task backward to its begin assistant", () => {
    const entries = entriesFor([user(), ...closedTaskMessages(), user("recent")]);
    const projection = projectCompaction(eventFor(entries, entries[3]!.id))!;
    expect(projection.boundaryChanged).toBe(true);
    expect(projection.firstKeptEntryId).toBe(entries[1]!.id);
    expect(projection.isSplitTurn).toBe(true);
  });

  it("also protects the begin marker of an open task", () => {
    const begin = beginMarker("open");
    const entries = entriesFor([
      user(),
      assistant([{ id: begin.toolCallId, name: "begin_task" }]),
      toolResult(begin.toolCallId, "begin_task", begin),
      assistant([{ id: "read-open", name: "read" }]),
      toolResult("read-open", "read"),
    ]);
    const projection = projectCompaction(eventFor(entries, entries[3]!.id))!;
    expect(projection.boundaryChanged).toBe(true);
    expect(projection.firstKeptEntryId).toBe(entries[1]!.id);
  });

  it("summarizes an older completed task through its projected task summary", () => {
    const entries = entriesFor([user(), ...closedTaskMessages(), user("recent")]);
    const projection = projectCompaction(eventFor(entries, entries[7]!.id))!;
    expect(projection.boundaryChanged).toBe(false);
    expect(projection.projectedTaskIds).toEqual(["task1"]);
    expect(projection.messagesToSummarize.some((message) => message.role === "custom")).toBe(true);
    expect(JSON.stringify(projection.messagesToSummarize)).not.toContain("x".repeat(100));
    expect(projection.fileOps.read.has("src/read.ts")).toBe(true);
  });

  it("does not move boundaries for invalid regions with a user interruption", () => {
    const task = closedTaskMessages();
    const messages = [user(), ...task.slice(0, 2), user("interrupt"), ...task.slice(2), user("recent")];
    const entries = entriesFor(messages);
    const projection = projectCompaction(eventFor(entries, entries[4]!.id))!;
    expect(projection.boundaryChanged).toBe(false);
    expect(projection.firstKeptEntryId).toBe(entries[4]!.id);
  });
});
