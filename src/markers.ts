import {
  BEGIN_TOOL,
  END_TOOL,
  EXPAND_TOOL,
  EXTENSION_ID,
  PRESERVE_OUTPUT_TOOL,
  SCHEMA_VERSION,
  type BeginMarker,
  type CancelMarker,
  type EndMarker,
  type ExpansionDetails,
  type PreservedOutputRecord,
  type PreserveOutputMarker,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const hasEnvelope = (value: Record<string, unknown>, event: string): boolean =>
  value.extension === EXTENSION_ID && value.schemaVersion === SCHEMA_VERSION && value.event === event;

export function parseBeginMarker(details: unknown, toolName?: string): BeginMarker | undefined {
  if (toolName !== undefined && toolName !== BEGIN_TOOL) return undefined;
  if (!isRecord(details) || !hasEnvelope(details, "begin")) return undefined;
  if (
    typeof details.taskId !== "string" ||
    typeof details.objective !== "string" ||
    typeof details.toolCallId !== "string"
  ) return undefined;
  if (details.expectedScope !== undefined && typeof details.expectedScope !== "string") return undefined;
  if (details.assistantEntryId !== undefined && typeof details.assistantEntryId !== "string") return undefined;
  return details as unknown as BeginMarker;
}

export function parsePreservedOutputRecord(value: unknown): PreservedOutputRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.preservationId !== "string" || !/^po_[A-Za-z0-9_-]+$/.test(value.preservationId) ||
    typeof value.label !== "string" || value.label.length === 0 ||
    typeof value.sourceEntryId !== "string" || value.sourceEntryId.length === 0 ||
    typeof value.sourceToolCallId !== "string" || value.sourceToolCallId.length === 0 ||
    typeof value.sourceToolName !== "string" || value.sourceToolName.length === 0 ||
    typeof value.sourceIsError !== "boolean" ||
    typeof value.sourceChars !== "number" || !Number.isSafeInteger(value.sourceChars) || value.sourceChars < 0 ||
    typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
    (value.selectedBy !== "preserve_output" && value.selectedBy !== "end_task")
  ) return undefined;
  if (value.reason !== undefined && typeof value.reason !== "string") return undefined;
  if (value.sourceTaskId !== undefined && typeof value.sourceTaskId !== "string") return undefined;
  if (value.sourceReportedTruncation !== undefined && typeof value.sourceReportedTruncation !== "boolean") {
    return undefined;
  }
  return value as unknown as PreservedOutputRecord;
}

export function parsePreserveOutputMarker(details: unknown, toolName?: string): PreserveOutputMarker | undefined {
  if (toolName !== undefined && toolName !== PRESERVE_OUTPUT_TOOL) return undefined;
  if (!isRecord(details) || !hasEnvelope(details, "preserve-output")) return undefined;
  if (!parsePreservedOutputRecord(details)) return undefined;
  return details as unknown as PreserveOutputMarker;
}

export function parseEndMarker(details: unknown, toolName?: string): EndMarker | undefined {
  if (toolName !== undefined && toolName !== END_TOOL) return undefined;
  if (!isRecord(details) || !hasEnvelope(details, "end")) return undefined;
  const strings = [
    details.taskId,
    details.objective,
    details.outcome,
    details.beginToolCallId,
    details.endToolCallId,
  ];
  if (!strings.every((item) => typeof item === "string")) return undefined;
  if (details.executionContext !== undefined && typeof details.executionContext !== "string") return undefined;
  const arrays = [
    details.attempted,
    details.learnings,
    details.decisions,
    details.filesRead,
    details.filesModified,
    details.artifacts,
    details.verification,
    details.openThreads,
  ];
  if (!arrays.every(hasStringArray)) return undefined;
  if (details.assistantEntryId !== undefined && typeof details.assistantEntryId !== "string") return undefined;
  if (
    details.preservedOutputs !== undefined &&
    (!Array.isArray(details.preservedOutputs) || !details.preservedOutputs.every((item) => parsePreservedOutputRecord(item)))
  ) return undefined;
  return details as unknown as EndMarker;
}

export function parseCancelMarker(data: unknown): CancelMarker | undefined {
  if (!isRecord(data) || !hasEnvelope(data, "cancel") || typeof data.taskId !== "string") return undefined;
  if (data.reason !== undefined && typeof data.reason !== "string") return undefined;
  return data as unknown as CancelMarker;
}

export function parseExpansionDetails(details: unknown, toolName?: string): ExpansionDetails | undefined {
  if (toolName !== undefined && toolName !== EXPAND_TOOL) return undefined;
  if (!isRecord(details) || !hasEnvelope(details, "expand")) return undefined;
  if (typeof details.taskId !== "string" || typeof details.truncated !== "boolean" || typeof details.returnedChars !== "number") {
    return undefined;
  }
  return details as unknown as ExpansionDetails;
}

export function isFutureTaskMarker(details: unknown): boolean {
  return isRecord(details) && details.extension === EXTENSION_ID &&
    typeof details.schemaVersion === "number" && details.schemaVersion !== SCHEMA_VERSION;
}

export function getToolCalls(message: unknown): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") {
      continue;
    }
    calls.push({
      id: block.id,
      name: block.name,
      arguments: isRecord(block.arguments) ? block.arguments : {},
    });
  }
  return calls;
}
