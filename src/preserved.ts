import { createHash, randomUUID } from "node:crypto";
import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getToolCalls, parseEndMarker, parsePreserveOutputMarker } from "./markers.js";
import {
  BEGIN_TOOL,
  END_TOOL,
  EXPAND_TOOL,
  EXTENSION_ID,
  LIST_PRESERVED_OUTPUTS_TOOL,
  PRESERVE_OUTPUT_TOOL,
  READ_PRESERVED_OUTPUT_TOOL,
  SCHEMA_VERSION,
  type PreservationDiagnostic,
  type PreservedOutputListItem,
  type PreservedOutputReadDetails,
  type PreservedOutputRecord,
  type PreserveToolOutputSelector,
} from "./types.js";

const TASK_COMPACTION_TOOLS = new Set<string>([
  BEGIN_TOOL,
  END_TOOL,
  EXPAND_TOOL,
  PRESERVE_OUTPUT_TOOL,
  LIST_PRESERVED_OUTPUTS_TOOL,
  READ_PRESERVED_OUTPUT_TOOL,
]);

export const isPreservableSourceTool = (toolName: string): boolean => !TASK_COMPACTION_TOOLS.has(toolName);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeForCanonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) normalized[key] = normalizeForCanonicalJson(value[key]);
  return normalized;
};

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(normalizeForCanonicalJson(value));
  if (result === undefined) throw new Error("Value cannot be represented as canonical JSON");
  return result;
}

export interface SourceFingerprint {
  sourceChars: number;
  sourceSha256: string;
}

export function fingerprintToolResult(message: ToolResultMessage): SourceFingerprint {
  const contentJson = canonicalJson(message.content);
  const hashInput = canonicalJson({
    content: message.content,
    isError: message.isError,
    toolName: message.toolName,
  });
  return {
    sourceChars: contentJson.length,
    sourceSha256: createHash("sha256").update(hashInput).digest("hex"),
  };
}

export function detectSourceReportedTruncation(message: ToolResultMessage): true | undefined {
  if (!["read", "bash", "grep", "find", "ls"].includes(message.toolName) || !isRecord(message.details)) {
    return undefined;
  }
  const truncation = message.details.truncation;
  if (isRecord(truncation) && truncation.truncated === true) return true;
  if (message.toolName === "grep") {
    if (message.details.linesTruncated === true) return true;
    if (typeof message.details.matchLimitReached === "number" && message.details.matchLimitReached > 0) return true;
  }
  if (message.toolName === "find" &&
    typeof message.details.resultLimitReached === "number" && message.details.resultLimitReached > 0) return true;
  if (message.toolName === "ls" &&
    typeof message.details.entryLimitReached === "number" && message.details.entryLimitReached > 0) return true;
  return undefined;
}

export interface ResolvedToolResult {
  entry: SessionEntry;
  entryIndex: number;
  callEntryId: string;
  callEntryIndex: number;
  message: ToolResultMessage;
}

export type SourceResolution =
  | { ok: true; source: ResolvedToolResult }
  | { ok: false; reason: string };

export interface SourceRange {
  minEntryIndex?: number | undefined;
  maxEntryIndex?: number | undefined;
  beforeEntryIndex?: number | undefined;
}

export function resolveCompletedToolResult(
  branch: SessionEntry[],
  sourceToolCallId: string,
  range: SourceRange = {},
): SourceResolution {
  const calls: Array<{ entryId: string; entryIndex: number; name: string }> = [];
  const results: Array<{ entry: SessionEntry; entryIndex: number; message: ToolResultMessage }> = [];

  for (let entryIndex = 0; entryIndex < branch.length; entryIndex++) {
    const entry = branch[entryIndex]!;
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const call of getToolCalls(entry.message)) {
        if (call.id === sourceToolCallId) calls.push({ entryId: entry.id, entryIndex, name: call.name });
      }
    } else if (entry.type === "message" && entry.message.role === "toolResult" &&
      entry.message.toolCallId === sourceToolCallId) {
      results.push({ entry, entryIndex, message: entry.message as ToolResultMessage });
    }
  }

  if (calls.length === 0) return { ok: false, reason: `tool call ${sourceToolCallId} is missing from the active branch` };
  if (calls.length > 1) return { ok: false, reason: `tool call ${sourceToolCallId} is ambiguous on the active branch` };
  if (results.length === 0) return { ok: false, reason: `tool call ${sourceToolCallId} has no completed result` };
  if (results.length > 1) return { ok: false, reason: `tool call ${sourceToolCallId} has multiple results` };

  const call = calls[0]!;
  const result = results[0]!;
  if (call.entryIndex >= result.entryIndex) return { ok: false, reason: `result for ${sourceToolCallId} precedes its tool call` };
  if (call.name !== result.message.toolName) return { ok: false, reason: `tool name mismatch for ${sourceToolCallId}` };
  if (range.beforeEntryIndex !== undefined && result.entryIndex >= range.beforeEntryIndex) {
    return { ok: false, reason: `result for ${sourceToolCallId} is not before the preservation call` };
  }
  if (range.minEntryIndex !== undefined &&
    (call.entryIndex < range.minEntryIndex || result.entryIndex < range.minEntryIndex)) {
    return { ok: false, reason: `tool call ${sourceToolCallId} is outside the allowed region` };
  }
  if (range.maxEntryIndex !== undefined &&
    (call.entryIndex > range.maxEntryIndex || result.entryIndex > range.maxEntryIndex)) {
    return { ok: false, reason: `tool call ${sourceToolCallId} is outside the allowed region` };
  }

  return {
    ok: true,
    source: {
      entry: result.entry,
      entryIndex: result.entryIndex,
      callEntryId: call.entryId,
      callEntryIndex: call.entryIndex,
      message: result.message,
    },
  };
}

export function resolvePrecedingToolResult(branch: SessionEntry[], preserveToolCallId: string): SourceResolution {
  const preserveCalls: Array<{ entryIndex: number; name: string }> = [];
  for (let entryIndex = 0; entryIndex < branch.length; entryIndex++) {
    const entry = branch[entryIndex]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const call of getToolCalls(entry.message)) {
      if (call.id === preserveToolCallId) preserveCalls.push({ entryIndex, name: call.name });
    }
  }
  if (preserveCalls.length !== 1 || preserveCalls[0]!.name !== PRESERVE_OUTPUT_TOOL) {
    return { ok: false, reason: `preserve_output call ${preserveToolCallId} is missing or ambiguous on the active branch` };
  }

  const preserveEntryIndex = preserveCalls[0]!.entryIndex;
  for (let entryIndex = preserveEntryIndex - 1; entryIndex >= 0; entryIndex--) {
    const entry = branch[entryIndex]!;
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const message = entry.message as ToolResultMessage;
    if (!isPreservableSourceTool(message.toolName)) {
      return { ok: false, reason: `the preceding result is from ineligible control tool ${message.toolName}` };
    }
    return resolveCompletedToolResult(branch, message.toolCallId, { beforeEntryIndex: preserveEntryIndex });
  }
  return { ok: false, reason: "no completed tool result precedes preserve_output" };
}

export interface CreatePreservedOutputOptions {
  preservationId?: string | undefined;
  label: string;
  reason?: string | undefined;
  sourceTaskId?: string | undefined;
  selectedBy: "preserve_output" | "end_task";
}

export function makePreservationId(): string {
  return `po_${randomUUID().split("-")[0]!}`;
}

export function createPreservedOutputRecord(
  source: ResolvedToolResult,
  options: CreatePreservedOutputOptions,
): PreservedOutputRecord {
  const fingerprint = fingerprintToolResult(source.message);
  const record: PreservedOutputRecord = {
    preservationId: options.preservationId ?? makePreservationId(),
    label: options.label,
    sourceEntryId: source.entry.id,
    sourceToolCallId: source.message.toolCallId,
    sourceToolName: source.message.toolName,
    sourceIsError: source.message.isError,
    sourceChars: fingerprint.sourceChars,
    sourceSha256: fingerprint.sourceSha256,
    selectedBy: options.selectedBy,
  };
  if (options.reason !== undefined) record.reason = options.reason;
  if (options.sourceTaskId !== undefined) record.sourceTaskId = options.sourceTaskId;
  const sourceReportedTruncation = detectSourceReportedTruncation(source.message);
  if (sourceReportedTruncation !== undefined) record.sourceReportedTruncation = sourceReportedTruncation;
  return record;
}

export interface PreservedOutputIndex {
  records: PreservedOutputRecord[];
  byId: Map<string, PreservedOutputRecord>;
  sources: Map<string, ResolvedToolResult>;
  diagnostics: PreservationDiagnostic[];
}

const copyPreservedOutputRecord = (value: PreservedOutputRecord): PreservedOutputRecord => {
  const record: PreservedOutputRecord = {
    preservationId: value.preservationId,
    label: value.label,
    sourceEntryId: value.sourceEntryId,
    sourceToolCallId: value.sourceToolCallId,
    sourceToolName: value.sourceToolName,
    sourceIsError: value.sourceIsError,
    sourceChars: value.sourceChars,
    sourceSha256: value.sourceSha256,
    selectedBy: value.selectedBy,
  };
  if (value.reason !== undefined) record.reason = value.reason;
  if (value.sourceTaskId !== undefined) record.sourceTaskId = value.sourceTaskId;
  if (value.sourceReportedTruncation !== undefined) {
    record.sourceReportedTruncation = value.sourceReportedTruncation;
  }
  return record;
};

const recordsEqual = (left: PreservedOutputRecord, right: PreservedOutputRecord): boolean =>
  canonicalJson(left) === canonicalJson(right);

const validateRecordSource = (
  branch: SessionEntry[],
  record: PreservedOutputRecord,
  creationEntryIndex: number,
): SourceResolution => {
  const resolution = resolveCompletedToolResult(branch, record.sourceToolCallId, { beforeEntryIndex: creationEntryIndex });
  if (!resolution.ok) return resolution;
  const source = resolution.source;
  if (source.entry.id !== record.sourceEntryId) return { ok: false, reason: "source entry ID does not match" };
  if (source.message.toolName !== record.sourceToolName) return { ok: false, reason: "source tool name does not match" };
  if (source.message.isError !== record.sourceIsError) return { ok: false, reason: "source error state does not match" };
  const fingerprint = fingerprintToolResult(source.message);
  if (fingerprint.sourceChars !== record.sourceChars) return { ok: false, reason: "source size does not match" };
  if (fingerprint.sourceSha256 !== record.sourceSha256) return { ok: false, reason: "source hash does not match" };
  if ((detectSourceReportedTruncation(source.message) === true) !== (record.sourceReportedTruncation === true)) {
    return { ok: false, reason: "source truncation metadata does not match" };
  }
  return resolution;
};

export function reconstructPreservedOutputs(branch: SessionEntry[]): PreservedOutputIndex {
  const candidates: Array<{
    record: PreservedOutputRecord;
    creationEntryId: string;
    creationEntryIndex: number;
  }> = [];

  for (let entryIndex = 0; entryIndex < branch.length; entryIndex++) {
    const entry = branch[entryIndex]!;
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const marker = parsePreserveOutputMarker(entry.message.details, entry.message.toolName);
    if (marker) {
      candidates.push({
        record: copyPreservedOutputRecord(marker),
        creationEntryId: entry.id,
        creationEntryIndex: entryIndex,
      });
    }
    const end = parseEndMarker(entry.message.details, entry.message.toolName);
    for (const record of end?.preservedOutputs ?? []) {
      candidates.push({
        record: copyPreservedOutputRecord(record),
        creationEntryId: entry.id,
        creationEntryIndex: entryIndex,
      });
    }
  }

  const diagnostics: PreservationDiagnostic[] = [];
  const selected = new Map<string, {
    record: PreservedOutputRecord;
    source: ResolvedToolResult;
    creationEntryId: string;
  }>();

  for (const candidate of candidates) {
    const resolution = validateRecordSource(branch, candidate.record, candidate.creationEntryIndex);
    if (!resolution.ok) {
      diagnostics.push({
        preservationId: candidate.record.preservationId,
        creationEntryId: candidate.creationEntryId,
        reason: resolution.reason,
      });
      continue;
    }
    const existing = selected.get(candidate.record.preservationId);
    if (!existing) {
      selected.set(candidate.record.preservationId, {
        record: candidate.record,
        source: resolution.source,
        creationEntryId: candidate.creationEntryId,
      });
      continue;
    }
    if (recordsEqual(existing.record, candidate.record)) continue;
    if (candidate.record.selectedBy === "preserve_output" && existing.record.selectedBy !== "preserve_output") {
      diagnostics.push({
        preservationId: candidate.record.preservationId,
        creationEntryId: existing.creationEntryId,
        reason: "conflicting duplicate preservation ID; explicit preserve_output metadata won",
      });
      selected.set(candidate.record.preservationId, {
        record: candidate.record,
        source: resolution.source,
        creationEntryId: candidate.creationEntryId,
      });
    } else {
      diagnostics.push({
        preservationId: candidate.record.preservationId,
        creationEntryId: candidate.creationEntryId,
        reason: "conflicting duplicate preservation ID ignored",
      });
    }
  }

  const ordered = [...selected.values()].sort((left, right) => left.source.entryIndex - right.source.entryIndex);
  return {
    records: ordered.map((item) => item.record),
    byId: new Map(ordered.map((item) => [item.record.preservationId, item.record])),
    sources: new Map(ordered.map((item) => [item.record.preservationId, item.source])),
    diagnostics,
  };
}

export function listPreservedOutputs(branch: SessionEntry[]): PreservedOutputListItem[] {
  return reconstructPreservedOutputs(branch).records.map((record) => {
    const item: PreservedOutputListItem = {
      preservation_id: record.preservationId,
      label: record.label,
      source_tool_call_id: record.sourceToolCallId,
      source_tool_name: record.sourceToolName,
      source_chars: record.sourceChars,
      source_sha256: record.sourceSha256,
      source_is_error: record.sourceIsError,
    };
    if (record.reason !== undefined) item.reason = record.reason;
    if (record.sourceTaskId !== undefined) item.source_task_id = record.sourceTaskId;
    if (record.sourceReportedTruncation !== undefined) {
      item.source_reported_truncation = record.sourceReportedTruncation;
    }
    return item;
  });
}

export type PreservedOutputRead =
  | { ok: true; content: Array<TextContent | ImageContent>; details: PreservedOutputReadDetails }
  | { ok: false; error: string };

const isSupportedContentBlock = (value: unknown): value is TextContent | ImageContent => {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") {
    return typeof value.text === "string" &&
      (value.textSignature === undefined || typeof value.textSignature === "string");
  }
  if (value.type === "image") return typeof value.data === "string" && typeof value.mimeType === "string";
  return false;
};

export interface TaskPreservationOptions {
  taskId: string;
  minEntryIndex: number;
  maxEntryIndex: number;
  selectors: PreserveToolOutputSelector[];
}

export type TaskPreservationResolution =
  | { ok: true; records: PreservedOutputRecord[] }
  | { ok: false; error: string };

/** Collect explicit markers in a task and resolve delayed selectors before end_task closes it. */
export function resolveTaskPreservations(
  branch: SessionEntry[],
  options: TaskPreservationOptions,
): TaskPreservationResolution {
  const selectorSources = new Set<string>();
  for (const selector of options.selectors) {
    if (selectorSources.has(selector.sourceToolCallId)) {
      return {
        ok: false,
        error: `Duplicate preserve_tool_outputs selector for ${selector.sourceToolCallId}`,
      };
    }
    selectorSources.add(selector.sourceToolCallId);
  }

  const index = reconstructPreservedOutputs(branch);
  const collected: Array<{ record: PreservedOutputRecord; sourceIndex: number }> = [];
  const explicitSources = new Set<string>();
  const explicitIds = new Set<string>();

  for (let entryIndex = options.minEntryIndex; entryIndex <= options.maxEntryIndex; entryIndex++) {
    const entry = branch[entryIndex];
    if (entry?.type !== "message" || entry.message.role !== "toolResult") continue;
    const marker = parsePreserveOutputMarker(entry.message.details, entry.message.toolName);
    if (!marker || explicitIds.has(marker.preservationId)) continue;
    const record = index.byId.get(marker.preservationId);
    const source = index.sources.get(marker.preservationId);
    if (!record || !source || record.selectedBy !== "preserve_output") continue;
    explicitIds.add(record.preservationId);
    explicitSources.add(record.sourceToolCallId);
    collected.push({ record, sourceIndex: source.entryIndex });
  }

  for (const selector of options.selectors) {
    if (explicitSources.has(selector.sourceToolCallId)) continue;
    const resolution = resolveCompletedToolResult(branch, selector.sourceToolCallId, {
      minEntryIndex: options.minEntryIndex,
      maxEntryIndex: options.maxEntryIndex,
    });
    if (!resolution.ok) {
      return { ok: false, error: `Cannot preserve ${selector.sourceToolCallId}: ${resolution.reason}` };
    }
    if (!isPreservableSourceTool(resolution.source.message.toolName)) {
      return {
        ok: false,
        error: `Cannot preserve ${selector.sourceToolCallId}: ${resolution.source.message.toolName} is a task-compaction control tool`,
      };
    }
    collected.push({
      record: createPreservedOutputRecord(resolution.source, {
        label: selector.label,
        reason: selector.reason,
        sourceTaskId: options.taskId,
        selectedBy: "end_task",
      }),
      sourceIndex: resolution.source.entryIndex,
    });
  }

  collected.sort((left, right) => left.sourceIndex - right.sourceIndex);
  return { ok: true, records: collected.map((item) => item.record) };
}

export function readPreservedOutput(branch: SessionEntry[], preservationId: string): PreservedOutputRead {
  const index = reconstructPreservedOutputs(branch);
  const record = index.byId.get(preservationId);
  const source = index.sources.get(preservationId);
  if (!record || !source) {
    const diagnostic = index.diagnostics.find((item) => item.preservationId === preservationId);
    return {
      ok: false,
      error: diagnostic
        ? `Preserved output ${preservationId} is invalid: ${diagnostic.reason}`
        : `Preserved output ${preservationId} was not found on the active branch`,
    };
  }
  const fingerprint = fingerprintToolResult(source.message);
  if (fingerprint.sourceSha256 !== record.sourceSha256 || fingerprint.sourceChars !== record.sourceChars) {
    return { ok: false, error: `Preserved output ${preservationId} failed source integrity verification` };
  }
  if (!source.message.content.every(isSupportedContentBlock)) {
    return { ok: false, error: `Preserved output ${preservationId} contains an unsupported content block` };
  }
  const details: PreservedOutputReadDetails = {
    extension: EXTENSION_ID,
    schemaVersion: SCHEMA_VERSION,
    event: "read-preserved-output",
    preservationId: record.preservationId,
    sourceEntryId: record.sourceEntryId,
    sourceToolCallId: record.sourceToolCallId,
    sourceToolName: record.sourceToolName,
    sourceChars: record.sourceChars,
    sourceSha256: record.sourceSha256,
    sourceIsError: record.sourceIsError,
  };
  if (record.sourceReportedTruncation !== undefined) {
    details.sourceReportedTruncation = record.sourceReportedTruncation;
  }
  return {
    ok: true,
    content: structuredClone(source.message.content) as Array<TextContent | ImageContent>,
    details,
  };
}
