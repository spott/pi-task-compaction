import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseEndMarker, parsePreserveOutputMarker } from "../src/markers.js";
import {
  canonicalJson,
  createPreservedOutputRecord,
  detectSourceReportedTruncation,
  fingerprintToolResult,
  listPreservedOutputs,
  readPreservedOutput,
  reconstructPreservedOutputs,
  resolvePrecedingToolResult,
  resolveTaskPreservations,
} from "../src/preserved.js";
import { formatTaskSummary } from "../src/transform.js";
import {
  EXTENSION_ID,
  PRESERVE_OUTPUT_TOOL,
  SCHEMA_VERSION,
  type PreserveOutputMarker,
} from "../src/types.js";
import { assistant, endMarker, entriesFor, toolResult } from "./fixtures.js";

const preservedBranch = (options: {
  sourceToolName?: string;
  sourceText?: string;
  sourceDetails?: unknown;
  sourceIsError?: boolean;
} = {}) => {
  const sourceToolName = options.sourceToolName ?? "mcp_fetch";
  const branch = entriesFor([
    assistant([{ id: "source-call", name: sourceToolName, arguments: { secretArgument: "not-listed" } }]),
    toolResult("source-call", sourceToolName, options.sourceDetails, options.sourceText ?? "expensive output"),
    assistant([{ id: "preserve-call", name: PRESERVE_OUTPUT_TOOL, arguments: { label: "snapshot" } }]),
    toolResult("preserve-call", PRESERVE_OUTPUT_TOOL),
  ]);
  const sourceMessage = branch[1]!.type === "message" ? branch[1]!.message as ToolResultMessage : undefined;
  if (!sourceMessage) throw new Error("missing fixture source");
  sourceMessage.isError = options.sourceIsError ?? false;
  const resolution = resolvePrecedingToolResult(branch, "preserve-call");
  if (!resolution.ok) throw new Error(resolution.reason);
  const record = createPreservedOutputRecord(resolution.source, {
    preservationId: "po_1234abcd",
    label: "snapshot",
    reason: "nondeterministic",
    sourceTaskId: "task1",
    selectedBy: "preserve_output",
  });
  const marker: PreserveOutputMarker = {
    extension: EXTENSION_ID,
    schemaVersion: SCHEMA_VERSION,
    event: "preserve-output",
    ...record,
  };
  const markerEntry = branch[3]!;
  if (markerEntry.type !== "message" || markerEntry.message.role !== "toolResult") throw new Error("bad fixture");
  markerEntry.message.details = marker;
  return { branch, marker, sourceMessage };
};

describe("preserved output core", () => {
  it("uses deterministic canonical JSON for source hashes and sizes", () => {
    expect(canonicalJson({ z: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"z":1}');
    const first = toolResult("call", "fetch", undefined, "body") as ToolResultMessage;
    const second = { ...first, content: [{ text: "body", type: "text" }] } as ToolResultMessage;
    expect(fingerprintToolResult(first)).toEqual(fingerprintToolResult(second));
    expect(fingerprintToolResult(first).sourceChars).toBe(canonicalJson(first.content).length);
  });

  it("selects the latest preceding completed ordinary result", () => {
    const { branch } = preservedBranch();
    const resolution = resolvePrecedingToolResult(branch, "preserve-call");
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.source.entry.id).toBe("e001");
      expect(resolution.source.message.toolCallId).toBe("source-call");
    }
  });

  it("rejects missing results and task-compaction control results", () => {
    const missing = entriesFor([
      assistant([{ id: "unfinished", name: "fetch" }]),
      assistant([{ id: "preserve", name: PRESERVE_OUTPUT_TOOL }]),
    ]);
    expect(resolvePrecedingToolResult(missing, "preserve")).toEqual({
      ok: false,
      reason: "no completed tool result precedes preserve_output",
    });

    const control = entriesFor([
      assistant([{ id: "list", name: "list_preserved_outputs" }]),
      toolResult("list", "list_preserved_outputs"),
      assistant([{ id: "preserve", name: PRESERVE_OUTPUT_TOOL }]),
    ]);
    expect(resolvePrecedingToolResult(control, "preserve")).toEqual({
      ok: false,
      reason: "the preceding result is from ineligible control tool list_preserved_outputs",
    });
  });

  it("records provenance and known truncation without duplicating the body", () => {
    const { marker, sourceMessage } = preservedBranch({
      sourceToolName: "grep",
      sourceText: "large body",
      sourceDetails: { matchLimitReached: 100 },
    });
    expect(marker).toMatchObject({
      sourceEntryId: "e001",
      sourceToolCallId: "source-call",
      sourceToolName: "grep",
      sourceReportedTruncation: true,
      sourceChars: canonicalJson(sourceMessage.content).length,
    });
    expect(marker.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson(marker)).not.toContain("large body");
    expect(detectSourceReportedTruncation({
      ...sourceMessage,
      toolName: "custom",
      details: { truncation: { truncated: true } },
    })).toBeUndefined();
  });

  it("strictly parses preserve markers and additive end-marker records", () => {
    const { marker } = preservedBranch();
    expect(parsePreserveOutputMarker(marker, PRESERVE_OUTPUT_TOOL)).toEqual(marker);
    expect(parsePreserveOutputMarker({ ...marker, sourceSha256: "bad" }, PRESERVE_OUTPUT_TOOL)).toBeUndefined();
    expect(parsePreserveOutputMarker(marker, "other")).toBeUndefined();

    const oldEnd = endMarker();
    expect(parseEndMarker(oldEnd, "end_task")).toEqual(oldEnd);
    expect(parseEndMarker({ ...oldEnd, preservedOutputs: [marker] }, "end_task")?.preservedOutputs).toEqual([marker]);
    expect(parseEndMarker({ ...oldEnd, preservedOutputs: [{ ...marker, sourceChars: -1 }] }, "end_task")).toBeUndefined();
  });

  it("reconstructs in source order and deduplicates end-marker snapshots", () => {
    const { branch, marker } = preservedBranch();
    const end = { ...endMarker(), preservedOutputs: [marker] };
    const endEntries = entriesFor([
      assistant([{ id: end.endToolCallId, name: "end_task" }]),
      toolResult(end.endToolCallId, "end_task", end),
    ]);
    for (const entry of endEntries) {
      entry.id = `tail-${entry.id}`;
      entry.parentId = branch.at(-1)?.id ?? null;
      branch.push(entry);
    }

    const index = reconstructPreservedOutputs(branch);
    const { extension: _extension, schemaVersion: _schemaVersion, event: _event, ...record } = marker;
    expect(index.records).toEqual([record]);
    expect(index.records[0]).not.toHaveProperty("extension");
    expect(index.records[0]).not.toHaveProperty("schemaVersion");
    expect(index.records[0]).not.toHaveProperty("event");
    expect(index.diagnostics).toEqual([]);
    expect(listPreservedOutputs(branch)).toEqual([{
      preservation_id: "po_1234abcd",
      label: "snapshot",
      reason: "nondeterministic",
      source_task_id: "task1",
      source_tool_call_id: "source-call",
      source_tool_name: "mcp_fetch",
      source_chars: marker.sourceChars,
      source_sha256: marker.sourceSha256,
      source_is_error: false,
    }]);
    expect(JSON.stringify(listPreservedOutputs(branch))).not.toContain("secretArgument");
    expect(JSON.stringify(listPreservedOutputs(branch))).not.toContain("expensive output");
  });

  it("re-emits text and image blocks while retaining original error metadata", () => {
    const { branch, marker, sourceMessage } = preservedBranch({ sourceIsError: true });
    sourceMessage.content = [
      { type: "text", text: "diagnostic" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ];
    const fingerprint = fingerprintToolResult(sourceMessage);
    marker.sourceChars = fingerprint.sourceChars;
    marker.sourceSha256 = fingerprint.sourceSha256;
    marker.sourceIsError = true;

    const result = readPreservedOutput(branch, marker.preservationId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toEqual(sourceMessage.content);
      expect(result.content).not.toBe(sourceMessage.content);
      expect(result.details.sourceIsError).toBe(true);
      expect(result.details.sourceSha256).toBe(marker.sourceSha256);
    }
  });

  it("collects region-local explicit markers and delayed selectors in source order", () => {
    const branch = entriesFor([
      assistant([{ id: "source-call", name: "mcp_fetch" }]),
      toolResult("source-call", "mcp_fetch", undefined, "explicit body"),
      assistant([{ id: "preserve-call", name: PRESERVE_OUTPUT_TOOL }]),
      toolResult("preserve-call", PRESERVE_OUTPUT_TOOL),
      assistant([{ id: "delayed-call", name: "bash" }]),
      toolResult("delayed-call", "bash", undefined, "delayed body"),
      assistant([{ id: "end-call", name: "end_task" }]),
    ]);
    const explicitSource = resolvePrecedingToolResult(branch, "preserve-call");
    if (!explicitSource.ok) throw new Error(explicitSource.reason);
    const explicit: PreserveOutputMarker = {
      extension: EXTENSION_ID,
      schemaVersion: SCHEMA_VERSION,
      event: "preserve-output",
      ...createPreservedOutputRecord(explicitSource.source, {
        preservationId: "po_explicit",
        label: "explicit label",
        reason: "explicit reason",
        sourceTaskId: "task1",
        selectedBy: "preserve_output",
      }),
    };
    const preserveEntry = branch[3]!;
    if (preserveEntry.type !== "message" || preserveEntry.message.role !== "toolResult") throw new Error("bad fixture");
    preserveEntry.message.details = explicit;

    const resolution = resolveTaskPreservations(branch, {
      taskId: "task1",
      minEntryIndex: 0,
      maxEntryIndex: 6,
      selectors: [
        { sourceToolCallId: "source-call", label: "ignored delayed label" },
        { sourceToolCallId: "delayed-call", label: "delayed label", reason: "slow" },
      ],
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.records).toHaveLength(2);
      expect(resolution.records[0]).toMatchObject({
        preservationId: explicit.preservationId,
        label: explicit.label,
        reason: explicit.reason,
        selectedBy: "preserve_output",
      });
      expect(resolution.records[0]).not.toHaveProperty("event");
      expect(resolution.records[1]).toMatchObject({
        label: "delayed label",
        reason: "slow",
        sourceTaskId: "task1",
        sourceToolCallId: "delayed-call",
        selectedBy: "end_task",
      });
    }
  });

  it("rejects duplicate and out-of-region delayed selectors", () => {
    const branch = entriesFor([
      assistant([{ id: "outside", name: "bash" }]),
      toolResult("outside", "bash"),
      assistant([{ id: "inside", name: "bash" }]),
      toolResult("inside", "bash"),
      assistant([{ id: "future", name: "bash" }]),
      toolResult("future", "bash"),
    ]);
    expect(resolveTaskPreservations(branch, {
      taskId: "task1",
      minEntryIndex: 2,
      maxEntryIndex: 3,
      selectors: [
        { sourceToolCallId: "inside", label: "one" },
        { sourceToolCallId: "inside", label: "two" },
      ],
    })).toEqual({ ok: false, error: "Duplicate preserve_tool_outputs selector for inside" });
    expect(resolveTaskPreservations(branch, {
      taskId: "task1",
      minEntryIndex: 2,
      maxEntryIndex: 3,
      selectors: [{ sourceToolCallId: "outside", label: "outside" }],
    })).toEqual({ ok: false, error: "Cannot preserve outside: tool call outside is outside the allowed region" });
    expect(resolveTaskPreservations(branch, {
      taskId: "task1",
      minEntryIndex: 2,
      maxEntryIndex: 3,
      selectors: [{ sourceToolCallId: "future", label: "future" }],
    })).toEqual({ ok: false, error: "Cannot preserve future: tool call future is outside the allowed region" });
    expect(resolveTaskPreservations(branch, {
      taskId: "task1",
      minEntryIndex: 2,
      maxEntryIndex: 4,
      selectors: [{ sourceToolCallId: "missing", label: "missing" }],
    })).toEqual({ ok: false, error: "Cannot preserve missing: tool call missing is missing from the active branch" });

    const incomplete = entriesFor([assistant([{ id: "unfinished", name: "bash" }])]);
    expect(resolveTaskPreservations(incomplete, {
      taskId: "task1",
      minEntryIndex: 0,
      maxEntryIndex: 0,
      selectors: [{ sourceToolCallId: "unfinished", label: "unfinished" }],
    })).toEqual({ ok: false, error: "Cannot preserve unfinished: tool call unfinished has no completed result" });
  });

  it("remains readable after a global compaction entry", () => {
    const { branch, marker } = preservedBranch();
    branch.push({
      type: "compaction",
      id: "compacted",
      parentId: branch.at(-1)!.id,
      timestamp: new Date().toISOString(),
      summary: "older context",
      firstKeptEntryId: branch.at(-1)!.id,
      tokensBefore: 50_000,
    } as SessionEntry);

    expect(listPreservedOutputs(branch).map((item) => item.preservation_id)).toEqual([marker.preservationId]);
    expect(readPreservedOutput(branch, marker.preservationId).ok).toBe(true);
  });

  it("renders preservation references in summaries without rendering bodies or hashes", () => {
    const { marker } = preservedBranch({ sourceText: "secret preserved body" });
    const summary = formatTaskSummary({ ...endMarker(), preservedOutputs: [marker] });
    expect(summary).toContain("Preserved outputs:");
    expect(summary).toContain("- po_1234abcd — snapshot (mcp_fetch");
    expect(summary).toContain("Reason: nondeterministic");
    expect(summary).not.toContain("secret preserved body");
    expect(summary).not.toContain(marker.sourceSha256);
  });

  it("fails explicitly for changed, missing, and unsupported sources", () => {
    const changed = preservedBranch();
    changed.sourceMessage.content = [{ type: "text", text: "expensive outpuX" }];
    expect(readPreservedOutput(changed.branch, changed.marker.preservationId)).toEqual({
      ok: false,
      error: "Preserved output po_1234abcd is invalid: source hash does not match",
    });

    const forkedBeforeMarker = changed.branch.slice(0, 2);
    expect(listPreservedOutputs(forkedBeforeMarker)).toEqual([]);
    expect(readPreservedOutput(forkedBeforeMarker, "po_1234abcd")).toEqual({
      ok: false,
      error: "Preserved output po_1234abcd was not found on the active branch",
    });

    const unsupported = preservedBranch();
    unsupported.sourceMessage.content = [{ type: "audio", data: "abc" }] as never;
    const fingerprint = fingerprintToolResult(unsupported.sourceMessage);
    unsupported.marker.sourceChars = fingerprint.sourceChars;
    unsupported.marker.sourceSha256 = fingerprint.sourceSha256;
    expect(readPreservedOutput(unsupported.branch, unsupported.marker.preservationId)).toEqual({
      ok: false,
      error: "Preserved output po_1234abcd contains an unsupported content block",
    });
  });
});
