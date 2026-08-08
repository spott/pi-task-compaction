import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BEGIN_TOOL, END_TOOL, EXTENSION_ID, SCHEMA_VERSION, type BeginMarker, type EndMarker, type RegionDiagnostic, type TransformResult } from "./types.js";
import { getToolCalls, isFutureTaskMarker, parseBeginMarker, parseEndMarker } from "./markers.js";

interface Candidate {
  taskId: string;
  begin: BeginMarker;
  end: EndMarker;
  beginAssistant: number;
  beginResult: number;
  endAssistant: number;
  endResult: number;
}

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const list = (items: string[]): string => items.length === 0
  ? "- None"
  : items.map((item) => `- ${escapeXml(item)}`).join("\n");

export function formatTaskSummary(marker: EndMarker): string {
  return [
    `<task-summary id="${escapeXml(marker.taskId)}">`,
    `Objective: ${escapeXml(marker.objective)}`,
    `Outcome: ${escapeXml(marker.outcome)}`,
    "",
    "Attempted:",
    list(marker.attempted),
    "",
    "Learnings:",
    list(marker.learnings),
    "",
    "Decisions:",
    list(marker.decisions),
    "",
    "Files read:",
    list(marker.filesRead),
    "",
    "Files modified:",
    list(marker.filesModified),
    "",
    "Artifacts:",
    list(marker.artifacts),
    "",
    "Verification:",
    list(marker.verification),
    "",
    "Open threads:",
    list(marker.openThreads),
    "</task-summary>",
    "",
    "This is historical context from completed work, not a new user request.",
  ].join("\n");
}

function findAssistantForCall(messages: AgentMessage[], callId: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (getToolCalls(messages[index]).some((call) => call.id === callId)) indexes.push(index);
  }
  return indexes;
}

function reject(taskId: string, reason: string): RegionDiagnostic {
  return { taskId, accepted: false, reason };
}

function validateCandidate(messages: AgentMessage[], candidate: Candidate): string | undefined {
  const { begin, end, beginAssistant, beginResult, endAssistant, endResult } = candidate;
  if (begin.toolCallId !== end.beginToolCallId) return "end marker does not reference the begin call";
  if (!(beginAssistant < beginResult && beginResult < endAssistant && endAssistant < endResult)) {
    return "boundary messages are missing or out of order";
  }

  const beginCalls = getToolCalls(messages[beginAssistant]);
  if (beginCalls.length !== 1 || beginCalls[0]?.id !== begin.toolCallId || beginCalls[0]?.name !== BEGIN_TOOL) {
    return "begin_task boundary is not an isolated tool call";
  }
  const beginResultMessage = messages[beginResult];
  if (beginResultMessage?.role !== "toolResult" || beginResultMessage.toolCallId !== begin.toolCallId || beginResultMessage.toolName !== BEGIN_TOOL) {
    return "begin_task result does not match its boundary call";
  }
  const endCalls = getToolCalls(messages[endAssistant]);
  if (endCalls.length !== 1 || endCalls[0]?.id !== end.endToolCallId || endCalls[0]?.name !== END_TOOL) {
    return "end_task boundary is not an isolated tool call";
  }
  if (endCalls[0].arguments.task_id !== candidate.taskId) return "end_task call has a mismatched task ID";
  const endResultMessage = messages[endResult];
  if (endResultMessage?.role !== "toolResult" || endResultMessage.toolCallId !== end.endToolCallId || endResultMessage.toolName !== END_TOOL) {
    return "end_task result does not match its boundary call";
  }

  for (let index = beginAssistant; index <= endResult; index++) {
    const message = messages[index];
    if (!message) return "boundary range contains a missing message";
    const role = message.role;
    if (role !== "assistant" && role !== "toolResult") {
      return `user-like ${String(role)} message occurs inside the task`;
    }
    if (role === "toolResult") {
      const nestedBegin = parseBeginMarker(message.details, message.toolName);
      const nestedEnd = parseEndMarker(message.details, message.toolName);
      if ((nestedBegin && nestedBegin.taskId !== candidate.taskId) || (nestedEnd && nestedEnd.taskId !== candidate.taskId)) {
        return "task regions overlap or nest";
      }
      if (isFutureTaskMarker(message.details)) return "unknown future task marker occurs inside the task";
    }
  }

  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (let index = beginAssistant; index <= endResult; index++) {
    const message = messages[index];
    for (const call of getToolCalls(message)) calls.set(call.id, (calls.get(call.id) ?? 0) + 1);
    if (message?.role === "toolResult") {
      results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
    }
  }
  if (calls.size !== results.size) return "tool calls and results do not form complete protocol units";
  for (const [callId, count] of calls) {
    if (count !== 1 || results.get(callId) !== 1) {
      return `tool protocol is ambiguous for call ${callId}`;
    }
  }
  return undefined;
}

function makeSummaryMessage(marker: EndMarker, timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: EXTENSION_ID,
    content: formatTaskSummary(marker),
    display: false,
    details: { extension: EXTENSION_ID, schemaVersion: SCHEMA_VERSION, taskId: marker.taskId },
    timestamp,
  } as AgentMessage;
}

/**
 * Replace only complete, protocol-valid task regions. This function never mutates
 * its input and returns the original messages for every rejected region.
 */
export function transformMessages(messages: AgentMessage[]): TransformResult {
  const begins = new Map<string, Array<{ marker: BeginMarker; index: number }>>();
  const ends = new Map<string, Array<{ marker: EndMarker; index: number }>>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "toolResult") continue;
    const begin = parseBeginMarker(message.details, message.toolName);
    if (begin) begins.set(begin.taskId, [...(begins.get(begin.taskId) ?? []), { marker: begin, index }]);
    const end = parseEndMarker(message.details, message.toolName);
    if (end) ends.set(end.taskId, [...(ends.get(end.taskId) ?? []), { marker: end, index }]);
  }

  const diagnostics: RegionDiagnostic[] = [];
  const candidates: Candidate[] = [];
  const taskIds = new Set([...begins.keys(), ...ends.keys()]);

  for (const taskId of taskIds) {
    const taskBegins = begins.get(taskId) ?? [];
    const taskEnds = ends.get(taskId) ?? [];
    if (taskBegins.length !== 1) {
      diagnostics.push(reject(taskId, taskBegins.length === 0 ? "end marker has no begin marker" : "duplicate begin markers"));
      continue;
    }
    if (taskEnds.length !== 1) {
      diagnostics.push(reject(taskId, taskEnds.length === 0 ? "task is still open" : "duplicate end markers"));
      continue;
    }
    const begin = taskBegins[0]!;
    const end = taskEnds[0]!;
    const beginAssistants = findAssistantForCall(messages, begin.marker.toolCallId);
    const endAssistants = findAssistantForCall(messages, end.marker.endToolCallId);
    if (beginAssistants.length !== 1 || endAssistants.length !== 1) {
      diagnostics.push(reject(taskId, "boundary call ID is missing or ambiguous"));
      continue;
    }
    const candidate: Candidate = {
      taskId,
      begin: begin.marker,
      end: end.marker,
      beginAssistant: beginAssistants[0]!,
      beginResult: begin.index,
      endAssistant: endAssistants[0]!,
      endResult: end.index,
    };
    const reason = validateCandidate(messages, candidate);
    if (reason) diagnostics.push(reject(taskId, reason));
    else candidates.push(candidate);
  }

  candidates.sort((a, b) => a.beginAssistant - b.beginAssistant);
  const accepted: Candidate[] = [];
  let priorEnd = -1;
  for (const candidate of candidates) {
    if (candidate.beginAssistant <= priorEnd) {
      diagnostics.push(reject(candidate.taskId, "task regions overlap or nest"));
      continue;
    }
    accepted.push(candidate);
    priorEnd = candidate.endResult;
  }

  const transformed = [...messages];
  for (const candidate of [...accepted].sort((a, b) => b.beginAssistant - a.beginAssistant)) {
    const summary = formatTaskSummary(candidate.end);
    const rawChars = JSON.stringify(messages.slice(candidate.beginAssistant, candidate.endResult + 1)).length;
    transformed.splice(
      candidate.beginAssistant,
      candidate.endResult - candidate.beginAssistant + 1,
      makeSummaryMessage(candidate.end, messages[candidate.endResult]?.timestamp ?? Date.now()),
    );
    diagnostics.push({
      taskId: candidate.taskId,
      accepted: true,
      start: candidate.beginAssistant,
      end: candidate.endResult,
      rawChars,
      summaryChars: summary.length,
    });
  }

  diagnostics.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  return { messages: transformed, diagnostics };
}
