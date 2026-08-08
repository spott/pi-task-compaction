import {
  BEGIN_TOOL,
  END_TOOL,
  EXPAND_TOOL,
  EXTENSION_ID,
  SCHEMA_VERSION,
  type BeginMarker,
  type CancelMarker,
  type EndMarker,
  type ExpansionDetails,
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
