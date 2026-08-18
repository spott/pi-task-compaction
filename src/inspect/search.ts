import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { canonicalJson, sha256 } from "../transcript/hash.js";
import type { MaterializedEntry, MaterializedTranscript, TranscriptArtifact } from "./artifact.js";

const CURSOR_VERSION = 1 as const;
export const DEFAULT_INSPECT_MAX_CHARS = 30_000;
export const MIN_INSPECT_MAX_CHARS = 1_000;
export const MAX_INSPECT_MAX_CHARS = 50_000;
const SEARCH_EXCERPT_CHARS = 320;

type BoundedInspectView = "list" | "search";

interface InspectCursorV1 {
  version: typeof CURSOR_VERSION;
  view: BoundedInspectView;
  taskId: string;
  beginEntryId: string;
  endEntryId: string;
  artifactSha256: string;
  query: string | null;
  resultIndex: number;
  requestFingerprint: string;
}

export interface InspectEntryMetadata {
  entry: string;
  line: number;
  type: string;
  chars: number;
  preview?: string;
}

export interface InspectSearchMatch extends InspectEntryMetadata {
  excerpt: string;
}

export interface BoundedInspectDetails {
  truncated: boolean;
  returnedChars: number;
  returnedRecords: number;
  totalRecords: number;
  totalMatches?: number;
  nextCursor?: string;
}

export interface BoundedInspectResult {
  text: string;
  details: BoundedInspectDetails;
}

interface CursorRequest {
  view: BoundedInspectView;
  query: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMaxChars(value: number | undefined): number {
  const maxChars = value ?? DEFAULT_INSPECT_MAX_CHARS;
  if (
    !Number.isSafeInteger(maxChars) ||
    maxChars < MIN_INSPECT_MAX_CHARS ||
    maxChars > MAX_INSPECT_MAX_CHARS
  ) {
    throw new Error(
      `max_chars must be an integer from ${MIN_INSPECT_MAX_CHARS.toLocaleString("en-US")} to ${MAX_INSPECT_MAX_CHARS.toLocaleString("en-US")}`,
    );
  }
  return maxChars;
}

function sanitizeLabel(value: string, maxChars = 160): string | undefined {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  const redacted = normalized
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/([?&](?:access_?token|api_?key|password|secret)=)[^&#\s]+/gi, "$1***");
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 1)}…` : redacted;
}

function assistantCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function sourceReportedTruncation(message: ToolResultMessage): boolean {
  const details = message.details;
  if (!isRecord(details)) return false;
  const direct = details.truncated;
  if (direct === true) return true;
  return isRecord(details.truncation) && details.truncation.truncated === true;
}

function safeCallPreview(call: ToolCall): string | undefined {
  if (call.name === "read" && typeof call.arguments.path === "string") {
    const path = sanitizeLabel(call.arguments.path, 120);
    return path ? `path=${JSON.stringify(path)}` : undefined;
  }
  if (call.name === "mcp") {
    const candidate =
      typeof call.arguments.tool === "string"
        ? call.arguments.tool
        : typeof call.arguments.path === "string"
          ? call.arguments.path
          : undefined;
    if (candidate && /^[A-Za-z0-9_.:/-]{1,80}$/.test(candidate)) {
      return `mcp=${JSON.stringify(candidate)}`;
    }
  }
  return undefined;
}

function entryMetadata(item: MaterializedEntry): InspectEntryMetadata {
  const entry = item.entry;
  const base = {
    entry: item.entryId,
    line: item.line,
    chars: item.serialized.length,
  };
  if (entry.type !== "message") {
    const preview =
      entry.type === "custom" || entry.type === "custom_message"
        ? sanitizeLabel(entry.customType, 120)
        : undefined;
    return { ...base, type: entry.type, ...(preview ? { preview } : {}) };
  }

  const message = entry.message;
  if (message.role === "assistant") {
    const calls = assistantCalls(message);
    const callSummary = calls.length
      ? `calls=${calls.map((call) => `${call.name}#${call.id}`).join(",")}`
      : undefined;
    const safeLabel = calls.length === 1 ? safeCallPreview(calls[0]!) : undefined;
    const preview = [callSummary, safeLabel].filter(Boolean).join(" ") || undefined;
    return { ...base, type: "message:assistant", ...(preview ? { preview } : {}) };
  }
  if (message.role === "toolResult") {
    const preview = [
      `${message.toolName}#${message.toolCallId}`,
      message.isError ? "error" : undefined,
      sourceReportedTruncation(message) ? "source-truncated" : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    return { ...base, type: "message:toolResult", preview };
  }
  return { ...base, type: `message:${message.role}` };
}

function renderMetadata(item: InspectEntryMetadata, matched = false): string {
  const prefix = matched ? "*" : "-";
  return `${prefix} [${item.line.toLocaleString("en-US")} ${JSON.stringify(item.entry)}] ${item.type} ${item.chars.toLocaleString("en-US")} chars${item.preview ? ` ${item.preview}` : ""}`;
}

function cursorFingerprint(
  taskId: string,
  artifact: TranscriptArtifact,
  request: CursorRequest,
  resultIndex: number,
): string {
  return sha256(
    canonicalJson({
      taskId,
      view: request.view,
      query: request.query,
      resultIndex,
      beginEntryId: artifact.beginEntryId,
      endEntryId: artifact.endEntryId,
      artifactSha256: artifact.sha256,
    }),
  );
}

function encodeCursor(
  taskId: string,
  artifact: TranscriptArtifact,
  resultIndex: number,
  request: CursorRequest,
): string {
  const payload: InspectCursorV1 = {
    version: CURSOR_VERSION,
    view: request.view,
    taskId,
    beginEntryId: artifact.beginEntryId,
    endEntryId: artifact.endEntryId,
    artifactSha256: artifact.sha256,
    query: request.query,
    resultIndex,
    requestFingerprint: cursorFingerprint(taskId, artifact, request, resultIndex),
  };
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

function decodeCursor(value: string): InspectCursorV1 {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical encoding");
    const payload: unknown = JSON.parse(decoded.toString("utf8"));
    const expectedKeys = [
      "artifactSha256",
      "beginEntryId",
      "endEntryId",
      "query",
      "requestFingerprint",
      "resultIndex",
      "taskId",
      "version",
      "view",
    ];
    if (
      !isRecord(payload) ||
      Object.keys(payload).sort().join("\0") !== expectedKeys.sort().join("\0") ||
      payload.version !== CURSOR_VERSION ||
      (payload.view !== "list" && payload.view !== "search") ||
      typeof payload.taskId !== "string" ||
      typeof payload.beginEntryId !== "string" ||
      typeof payload.endEntryId !== "string" ||
      typeof payload.artifactSha256 !== "string" ||
      typeof payload.requestFingerprint !== "string" ||
      !Number.isSafeInteger(payload.resultIndex) ||
      (payload.query !== null && typeof payload.query !== "string")
    ) {
      throw new Error("invalid payload");
    }
    return payload as unknown as InspectCursorV1;
  } catch (error) {
    throw new Error(`Invalid inspect_task cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateCursor(
  cursor: InspectCursorV1,
  taskId: string,
  artifact: TranscriptArtifact,
  request: CursorRequest,
): void {
  if (cursor.view !== request.view) {
    throw new Error(`inspect_task cursor belongs to view ${cursor.view}, not ${request.view}`);
  }
  if (cursor.taskId !== taskId) {
    throw new Error(`inspect_task cursor belongs to task ${cursor.taskId}, not ${taskId}`);
  }
  if (cursor.beginEntryId !== artifact.beginEntryId || cursor.endEntryId !== artifact.endEntryId) {
    throw new Error("inspect_task cursor task boundaries do not match the active branch");
  }
  if (cursor.artifactSha256 !== artifact.sha256) {
    throw new Error("inspect_task cursor artifact hash does not match the active task transcript");
  }
  if (cursor.query !== request.query) {
    throw new Error("inspect_task cursor query does not match the request");
  }
  if (
    cursor.requestFingerprint !==
    cursorFingerprint(taskId, artifact, request, cursor.resultIndex)
  ) {
    throw new Error("inspect_task cursor request fingerprint is invalid");
  }
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderList(
  taskId: string,
  transcript: MaterializedTranscript,
  records: readonly InspectEntryMetadata[],
  nextCursor?: string,
): string {
  const header = `<task-list id="${xmlAttribute(taskId)}" entries="${transcript.entries.length}" returned="${records.length}" artifact="${xmlAttribute(transcript.descriptor.path)}">`;
  const body = [header, ...records.map((item) => renderMetadata(item)), "</task-list>"].join("\n");
  return nextCursor
    ? `${body}\nContinue with inspect_task view=list and cursor: ${nextCursor}`
    : body;
}

function searchExcerpt(text: string, query: string): string {
  const normalized = text.toLocaleLowerCase("en-US");
  const index = normalized.indexOf(query.toLocaleLowerCase("en-US"));
  if (index < 0) return "";
  const start = Math.max(0, index - 110);
  const end = Math.min(text.length, index + query.length + 110);
  const excerpt = sanitizeLabel(text.slice(start, end), SEARCH_EXCERPT_CHARS) ?? "";
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

function searchMatches(
  transcript: MaterializedTranscript,
  query: string,
): InspectSearchMatch[] {
  const normalized = query.toLocaleLowerCase("en-US");
  return transcript.entries.flatMap((entry) => {
    if (!entry.searchText.toLocaleLowerCase("en-US").includes(normalized)) return [];
    return [{ ...entryMetadata(entry), excerpt: searchExcerpt(entry.searchText, query) }];
  });
}

function renderSearch(
  taskId: string,
  transcript: MaterializedTranscript,
  query: string,
  totalMatches: number,
  records: readonly InspectSearchMatch[],
  nextCursor?: string,
): string {
  const displayQuery = sanitizeLabel(query, 160) ?? "";
  const header = `<task-search id="${xmlAttribute(taskId)}" query="${xmlAttribute(displayQuery)}" matches="${totalMatches}" returned="${records.length}" artifact="${xmlAttribute(transcript.descriptor.path)}">`;
  const rendered = records.flatMap((item) => [renderMetadata(item, true), `  excerpt=${JSON.stringify(item.excerpt)}`]);
  const body = [header, ...rendered, "</task-search>"].join("\n");
  return nextCursor
    ? `${body}\nContinue with inspect_task view=search and cursor: ${nextCursor}`
    : body;
}

function selectBounded<T>(options: {
  taskId: string;
  transcript: MaterializedTranscript;
  items: readonly T[];
  start: number;
  maxChars: number;
  request: CursorRequest;
  render: (selected: readonly T[], nextCursor?: string) => string;
}): BoundedInspectResult {
  const selected: T[] = [];
  let index = options.start;
  while (index < options.items.length) {
    const candidate = [...selected, options.items[index]!];
    const nextIndex = index + 1;
    const nextCursor =
      nextIndex < options.items.length
        ? encodeCursor(options.taskId, options.transcript.descriptor, nextIndex, options.request)
        : undefined;
    if (options.render(candidate, nextCursor).length > options.maxChars) break;
    selected.push(options.items[index]!);
    index += 1;
  }
  if (selected.length === 0 && options.items.length > 0) {
    throw new Error(
      `max_chars ${options.maxChars.toLocaleString("en-US")} is too small for one complete ${options.request.view} record and continuation cursor`,
    );
  }
  const nextCursor =
    index < options.items.length
      ? encodeCursor(options.taskId, options.transcript.descriptor, index, options.request)
      : undefined;
  const text = options.render(selected, nextCursor);
  if (text.length > options.maxChars) {
    throw new Error(`Internal error: bounded inspect_task ${options.request.view} output exceeded max_chars`);
  }
  return {
    text,
    details: {
      truncated: options.start > 0 || index < options.items.length,
      returnedChars: text.length,
      returnedRecords: selected.length,
      totalRecords: options.items.length,
      ...(nextCursor ? { nextCursor } : {}),
    },
  };
}

export function listTaskTranscript(
  taskId: string,
  transcript: MaterializedTranscript,
  options: { cursor?: string; maxChars?: number } = {},
): BoundedInspectResult {
  const maxChars = validateMaxChars(options.maxChars);
  const request: CursorRequest = { view: "list", query: null };
  let start = 0;
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    validateCursor(cursor, taskId, transcript.descriptor, request);
    start = cursor.resultIndex;
    if (start < 0 || start >= transcript.entries.length) {
      throw new Error("inspect_task cursor result index is outside the task transcript");
    }
  }
  const items = transcript.entries.map((item) => entryMetadata(item));
  return selectBounded({
    taskId,
    transcript,
    items,
    start,
    maxChars,
    request,
    render: (records, nextCursor) => renderList(taskId, transcript, records, nextCursor),
  });
}

export function searchTaskTranscript(
  taskId: string,
  transcript: MaterializedTranscript,
  options: { query?: string; cursor?: string; maxChars?: number },
): BoundedInspectResult {
  const maxChars = validateMaxChars(options.maxChars);
  if (options.cursor && options.query !== undefined) {
    throw new Error("cursor is mutually exclusive with query for inspect_task view: search");
  }

  let query: string;
  let start = 0;
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    if (cursor.view !== "search" || cursor.query === null) {
      throw new Error(`inspect_task cursor belongs to view ${cursor.view}, not search`);
    }
    query = cursor.query;
    const request: CursorRequest = { view: "search", query };
    validateCursor(cursor, taskId, transcript.descriptor, request);
    start = cursor.resultIndex;
  } else {
    query = options.query ?? "";
    if (query.length === 0) throw new Error("query is required for inspect_task view: search");
  }

  const items = searchMatches(transcript, query);
  if (start < 0 || (items.length > 0 && start >= items.length) || (items.length === 0 && start !== 0)) {
    throw new Error("inspect_task cursor result index is outside the search results");
  }
  const request: CursorRequest = { view: "search", query };
  const result = selectBounded({
    taskId,
    transcript,
    items,
    start,
    maxChars,
    request,
    render: (records, nextCursor) =>
      renderSearch(taskId, transcript, query, items.length, records, nextCursor),
  });
  result.details.totalMatches = items.length;
  return result;
}
