import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getToolCalls } from "./markers.js";
import { canonicalJson, detectSourceReportedTruncation } from "./preserved.js";
import type {
  EntryLocator,
  IndexedTask,
  ListExpansionDetails,
  SearchExpansionDetails,
  TranscriptArtifact,
} from "./types.js";

const ARTIFACT_FORMAT = "pi-session-entry-jsonl" as const;
const CACHE_DIRECTORY = "pi-task-compaction";
const CURSOR_VERSION = 1 as const;
const DEFAULT_MAX_CHARS = 30_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 50_000;
const DEFAULT_CONTEXT_ENTRIES = 1;
const MAX_CONTEXT_ENTRIES = 10;
const SEARCH_EXCERPT_CHARS = 280;

export type ExpansionDirection = "forward" | "backward";
type BoundedExpansionView = "list" | "search";

interface CursorRequest {
  view: BoundedExpansionView;
  query: string | null;
  contextEntries: number | null;
}

interface ExpansionCursorV1 extends CursorRequest {
  version: typeof CURSOR_VERSION;
  taskId: string;
  beginEntryId: string;
  endEntryId: string;
  artifactSha256: string;
  requestFingerprint: string;
  resultIndex: number;
  direction: ExpansionDirection;
}

interface BoundedTranscriptOptions {
  cursor?: string | undefined;
  direction?: ExpansionDirection | undefined;
  maxChars?: number | undefined;
}

export interface ListTranscriptOptions extends BoundedTranscriptOptions {}

export interface SearchTranscriptOptions extends BoundedTranscriptOptions {
  query?: string | undefined;
  contextEntries?: number | undefined;
}

export interface ListTranscriptResult {
  text: string;
  details: Omit<ListExpansionDetails, "extension" | "schemaVersion" | "event" | "taskId" | "artifact" | "view">;
}

export interface SearchTranscriptResult {
  text: string;
  details: Omit<SearchExpansionDetails, "extension" | "schemaVersion" | "event" | "taskId" | "artifact" | "view">;
}

export interface MaterializedEntry {
  entry: SessionEntry;
  entryId: string;
  branchIndex: number;
  line: number;
  byteOffset: number;
  byteLength: number;
  searchText: string;
}

export interface MaterializedTranscript {
  descriptor: TranscriptArtifact;
  entries: MaterializedEntry[];
}

export interface MaterializeTranscriptOptions {
  sessionId: string;
  cacheRoot?: string | undefined;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const safeFilenamePart = (value: string): string => {
  const sanitized = value.normalize("NFKC").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (sanitized || "task").slice(0, 48);
};

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Expansion cache path is not a private directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`Expansion cache path is not a private directory: ${path}`);
    }
  }
  await chmod(path, 0o700);
}

function validateTaskRange(branch: SessionEntry[], task: IndexedTask): { start: number; end: number } {
  const start = task.beginEntryIndex;
  const end = task.endEntryIndex;
  if (
    task.status !== "closed" ||
    start === undefined ||
    end === undefined ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= branch.length
  ) {
    throw new Error(`Task ${task.taskId} does not have recoverable raw boundaries on this branch`);
  }

  const beginEntry = branch[start]!;
  const endEntry = branch[end]!;
  if (
    (task.beginAssistantEntryId !== undefined && beginEntry.id !== task.beginAssistantEntryId) ||
    (task.endResultEntryId !== undefined && endEntry.id !== task.endResultEntryId)
  ) {
    throw new Error(`Task ${task.taskId} boundaries do not match the active branch`);
  }
  return { start, end };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function appendContentText(parts: string[], content: unknown): void {
  if (typeof content === "string") {
    parts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
  }
}

function buildSearchText(entry: SessionEntry): string {
  const parts: string[] = [];
  if (entry.type === "message") {
    const message = entry.message;
    parts.push(message.role);
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "thinking") parts.push(block.thinking);
        else if (block.type === "toolCall") {
          parts.push(block.name, block.id, canonicalJson(block.arguments));
        }
      }
      if (message.errorMessage) parts.push(message.errorMessage);
    } else if (message.role === "toolResult") {
      parts.push(message.toolName, message.toolCallId);
      appendContentText(parts, message.content);
      if (message.details !== undefined) parts.push(canonicalJson(message.details));
    } else if (message.role === "bashExecution") {
      parts.push(message.command, message.output);
      if (message.fullOutputPath) parts.push(message.fullOutputPath);
    } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
      parts.push(message.summary);
    } else {
      appendContentText(parts, "content" in message ? message.content : undefined);
      if ("customType" in message && typeof message.customType === "string") parts.push(message.customType);
      if ("details" in message && message.details !== undefined) parts.push(canonicalJson(message.details));
    }
  } else if (entry.type === "custom_message") {
    parts.push(entry.customType);
    appendContentText(parts, entry.content);
    if (entry.details !== undefined) parts.push(canonicalJson(entry.details));
  } else if (entry.type === "custom") {
    parts.push(entry.customType);
    if (entry.data !== undefined) parts.push(canonicalJson(entry.data));
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    parts.push(entry.summary);
    if (entry.details !== undefined) parts.push(canonicalJson(entry.details));
  } else if (entry.type === "model_change") {
    parts.push(entry.provider, entry.modelId);
  } else if (entry.type === "thinking_level_change") {
    parts.push(entry.thinkingLevel);
  } else if (entry.type === "label") {
    if (entry.label) parts.push(entry.label);
  } else if (entry.type === "session_info" && entry.name) {
    parts.push(entry.name);
  }
  return parts.join("\n");
}

async function existingArtifactIsValid(path: string, expected: Buffer, expectedSha256: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
    const bytes = await readFile(path);
    return sha256(bytes) === expectedSha256 && bytes.equals(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeArtifactAtomically(path: string, bytes: Buffer): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function materializeTaskTranscript(
  branch: SessionEntry[],
  task: IndexedTask,
  options: MaterializeTranscriptOptions,
): Promise<MaterializedTranscript> {
  const { start, end } = validateTaskRange(branch, task);
  const selected = branch.slice(start, end + 1);
  const serializedLines = selected.map((entry) => JSON.stringify(entry));
  const body = Buffer.from(`${serializedLines.join("\n")}\n`, "utf8");
  const bodySha256 = sha256(body);
  const beginEntryId = selected[0]!.id;
  const endEntryId = selected.at(-1)!.id;
  const provenanceSha256 = sha256(JSON.stringify({ beginEntryId, endEntryId, entries: selected.length }));

  const cacheRoot = options.cacheRoot ?? join(tmpdir(), CACHE_DIRECTORY);
  const sessionDirectory = join(cacheRoot, sha256(options.sessionId));
  await ensurePrivateDirectory(cacheRoot);
  await ensurePrivateDirectory(sessionDirectory);

  const filename = `${safeFilenamePart(task.taskId)}-${provenanceSha256.slice(0, 16)}-${bodySha256}.jsonl`;
  const path = join(sessionDirectory, filename);
  if (!await existingArtifactIsValid(path, body, bodySha256)) {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error(`Refusing to replace unsafe expansion artifact path: ${path}`);
    }
    await writeArtifactAtomically(path, body);
  } else {
    await chmod(path, 0o600);
  }

  const entries: MaterializedEntry[] = [];
  let byteOffset = 0;
  for (let index = 0; index < selected.length; index++) {
    const entry = selected[index]!;
    const byteLength = Buffer.byteLength(serializedLines[index]!, "utf8");
    entries.push({
      entry,
      entryId: entry.id,
      branchIndex: start + index,
      line: index + 1,
      byteOffset,
      byteLength,
      searchText: buildSearchText(entry),
    });
    byteOffset += byteLength + 1;
  }

  return {
    descriptor: {
      path,
      format: ARTIFACT_FORMAT,
      entries: entries.length,
      bytes: body.byteLength,
      sha256: bodySha256,
      beginEntryId,
      endEntryId,
    },
    entries,
  };
}

export function locateTranscriptEntry(
  transcript: MaterializedTranscript,
  entryId: string,
): EntryLocator {
  const match = transcript.entries.find((item) => item.entryId === entryId);
  if (!match) throw new Error(`Entry ${entryId} does not belong to this task on the active branch`);
  return {
    path: transcript.descriptor.path,
    format: ARTIFACT_FORMAT,
    entryId,
    line: match.line,
    entryBytes: match.byteLength,
    artifactSha256: transcript.descriptor.sha256,
  };
}

const inlineValue = (value: string): string => JSON.stringify(value);

const sanitizeLabel = (value: string, maxChars = 120): string | undefined => {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const redacted = normalized
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/([?&](?:access_?token|api_?key|password|secret)=)[^&#\s]+/gi, "$1***");
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 1)}…` : redacted;
};

function safeCallLabel(name: string, args: Record<string, unknown>): string | undefined {
  if (name === "read" && typeof args.path === "string") {
    const path = sanitizeLabel(args.path);
    return path ? `path=${inlineValue(path)}` : undefined;
  }
  if (name === "mcp") {
    const candidate = typeof args.tool === "string" ? args.tool : typeof args.path === "string" ? args.path : undefined;
    if (candidate && /^[A-Za-z0-9_.:/-]{1,80}$/.test(candidate)) return `mcp=${inlineValue(candidate)}`;
  }
  return undefined;
}

function formatListRecord(item: MaterializedEntry): string {
  const prefix = `[${item.line.toLocaleString("en-US")} ${inlineValue(item.entryId)}]`;
  const persistedChars = `${item.searchText.length.toLocaleString("en-US")} chars`;
  if (item.entry.type !== "message") return `${prefix} ${item.entry.type} ${persistedChars}`;

  const message = item.entry.message;
  if (message.role === "assistant") {
    const calls = getToolCalls(message);
    const callMetadata = calls.length
      ? ` calls=${calls.map((call) => `${inlineValue(call.name)}#${inlineValue(call.id)}`).join(",")}`
      : "";
    const label = calls.length === 1 ? safeCallLabel(calls[0]!.name, calls[0]!.arguments) : undefined;
    return `${prefix} assistant${callMetadata} ${persistedChars}${label ? ` ${label}` : ""}`;
  }
  if (message.role === "toolResult") {
    const truncation = detectSourceReportedTruncation(message as ToolResultMessage) ? " source-truncated" : "";
    const error = message.isError ? " error" : "";
    return `${prefix} toolResult ${inlineValue(message.toolName)} call=${inlineValue(message.toolCallId)} ${persistedChars}${error}${truncation}`;
  }
  return `${prefix} ${message.role} ${persistedChars}`;
}

const LIST_CURSOR_REQUEST: CursorRequest = { view: "list", query: null, contextEntries: null };

function cursorFingerprint(
  taskId: string,
  artifact: TranscriptArtifact,
  direction: ExpansionDirection,
  request: CursorRequest,
): string {
  return sha256(canonicalJson({
    artifactSha256: artifact.sha256,
    beginEntryId: artifact.beginEntryId,
    contextEntries: request.contextEntries,
    direction,
    endEntryId: artifact.endEntryId,
    query: request.query,
    taskId,
    view: request.view,
  }));
}

function encodeCursor(
  taskId: string,
  artifact: TranscriptArtifact,
  resultIndex: number,
  direction: ExpansionDirection,
  request: CursorRequest,
): string {
  const payload: ExpansionCursorV1 = {
    version: CURSOR_VERSION,
    taskId,
    beginEntryId: artifact.beginEntryId,
    endEntryId: artifact.endEntryId,
    artifactSha256: artifact.sha256,
    requestFingerprint: cursorFingerprint(taskId, artifact, direction, request),
    resultIndex,
    direction,
    ...request,
  };
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

function decodeCursor(value: string): ExpansionCursorV1 {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical encoding");
    const payload: unknown = JSON.parse(decoded.toString("utf8"));
    const expectedKeys = [
      "artifactSha256", "beginEntryId", "contextEntries", "direction", "endEntryId", "query", "requestFingerprint",
      "resultIndex", "taskId", "version", "view",
    ];
    if (!isRecord(payload) || Object.keys(payload).sort().join("\0") !== expectedKeys.sort().join("\0") ||
      payload.version !== CURSOR_VERSION || (payload.view !== "list" && payload.view !== "search") ||
      typeof payload.taskId !== "string" || typeof payload.beginEntryId !== "string" ||
      typeof payload.endEntryId !== "string" || typeof payload.artifactSha256 !== "string" ||
      typeof payload.requestFingerprint !== "string" ||
      (payload.direction !== "forward" && payload.direction !== "backward") ||
      typeof payload.resultIndex !== "number" || !Number.isSafeInteger(payload.resultIndex) ||
      (payload.query !== null && typeof payload.query !== "string") ||
      (payload.contextEntries !== null &&
        (typeof payload.contextEntries !== "number" || !Number.isSafeInteger(payload.contextEntries)))) {
      throw new Error("invalid payload");
    }
    return payload as unknown as ExpansionCursorV1;
  } catch (error) {
    throw new Error(`Invalid expand_task cursor: ${(error as Error).message}`);
  }
}

function resolveListPosition(
  taskId: string,
  transcript: MaterializedTranscript,
  options: ListTranscriptOptions,
): { direction: ExpansionDirection; resultIndex: number } {
  const defaultDirection = options.direction ?? "forward";
  if (!options.cursor) {
    return {
      direction: defaultDirection,
      resultIndex: defaultDirection === "forward" ? 0 : transcript.entries.length - 1,
    };
  }

  const cursor = decodeCursor(options.cursor);
  const artifact = transcript.descriptor;
  if (cursor.view !== "list" || cursor.query !== null || cursor.contextEntries !== null) {
    throw new Error(`expand_task cursor belongs to view ${cursor.view}, not list`);
  }
  if (cursor.taskId !== taskId) throw new Error(`expand_task cursor belongs to task ${cursor.taskId}, not ${taskId}`);
  if (cursor.beginEntryId !== artifact.beginEntryId || cursor.endEntryId !== artifact.endEntryId) {
    throw new Error("expand_task cursor task boundaries do not match the active branch");
  }
  if (cursor.artifactSha256 !== artifact.sha256) {
    throw new Error("expand_task cursor artifact hash does not match the active task transcript");
  }
  if (options.direction !== undefined && options.direction !== cursor.direction) {
    throw new Error(`expand_task cursor direction is ${cursor.direction}, not ${options.direction}`);
  }
  if (cursor.requestFingerprint !== cursorFingerprint(taskId, artifact, cursor.direction, LIST_CURSOR_REQUEST)) {
    throw new Error("expand_task cursor request fingerprint is invalid");
  }
  if (cursor.resultIndex < 0 || cursor.resultIndex >= transcript.entries.length) {
    throw new Error("expand_task cursor result index is outside the task transcript");
  }
  return { direction: cursor.direction, resultIndex: cursor.resultIndex };
}

const xmlAttribute = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

function renderListText(
  taskId: string,
  transcript: MaterializedTranscript,
  records: string[],
  nextCursor?: string,
): string {
  const artifact = transcript.descriptor;
  const header = `<task-list id="${xmlAttribute(taskId)}" entries="${artifact.entries}" returned="${records.length}" path="${xmlAttribute(artifact.path)}">`;
  const body = [header, ...records, "</task-list>"].join("\n");
  return nextCursor ? `${body}\nContinue with expand_task view=list and cursor: ${nextCursor}` : body;
}

export function listTaskTranscript(
  taskId: string,
  transcript: MaterializedTranscript,
  options: ListTranscriptOptions = {},
): ListTranscriptResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_MAX_CHARS || maxChars > MAX_MAX_CHARS) {
    throw new Error(`max_chars must be an integer from ${MIN_MAX_CHARS.toLocaleString("en-US")} to ${MAX_MAX_CHARS.toLocaleString("en-US")}`);
  }
  const { direction, resultIndex } = resolveListPosition(taskId, transcript, options);
  const step = direction === "forward" ? 1 : -1;
  const selectedIndices: number[] = [];
  let scanIndex = resultIndex;

  while (scanIndex >= 0 && scanIndex < transcript.entries.length) {
    const candidateIndices = [...selectedIndices, scanIndex];
    const ordered = [...candidateIndices].sort((left, right) => left - right);
    const continuationIndex = scanIndex + step;
    const nextCursor = continuationIndex >= 0 && continuationIndex < transcript.entries.length
      ? encodeCursor(taskId, transcript.descriptor, continuationIndex, direction, LIST_CURSOR_REQUEST)
      : undefined;
    const candidateText = renderListText(
      taskId,
      transcript,
      ordered.map((index) => formatListRecord(transcript.entries[index]!)),
      nextCursor,
    );
    if (candidateText.length > maxChars) break;
    selectedIndices.push(scanIndex);
    scanIndex += step;
  }

  if (selectedIndices.length === 0) {
    throw new Error(`max_chars ${maxChars.toLocaleString("en-US")} is too small for one complete list record and continuation cursor`);
  }

  const orderedIndices = [...selectedIndices].sort((left, right) => left - right);
  const low = orderedIndices[0]!;
  const high = orderedIndices.at(-1)!;
  const nextIndex = direction === "forward" ? high + 1 : low - 1;
  const previousIndex = direction === "forward" ? low - 1 : high + 1;
  const nextCursor = nextIndex >= 0 && nextIndex < transcript.entries.length
    ? encodeCursor(taskId, transcript.descriptor, nextIndex, direction, LIST_CURSOR_REQUEST)
    : undefined;
  const reverseDirection: ExpansionDirection = direction === "forward" ? "backward" : "forward";
  const previousCursor = previousIndex >= 0 && previousIndex < transcript.entries.length
    ? encodeCursor(taskId, transcript.descriptor, previousIndex, reverseDirection, LIST_CURSOR_REQUEST)
    : undefined;
  const text = renderListText(
    taskId,
    transcript,
    orderedIndices.map((index) => formatListRecord(transcript.entries[index]!)),
    nextCursor,
  );
  if (text.length > maxChars) throw new Error("Internal error: bounded expand_task list output exceeded max_chars");

  const truncated = selectedIndices.length < transcript.entries.length;
  return {
    text,
    details: {
      truncated,
      ...(truncated ? { truncationReason: "max_chars" as const } : {}),
      returnedChars: text.length,
      returnedRecords: selectedIndices.length,
      totalRecords: transcript.entries.length,
      ...(nextCursor ? { nextCursor } : {}),
      ...(previousCursor ? { previousCursor } : {}),
    },
  };
}

interface SearchWindow {
  start: number;
  end: number;
  matches: number[];
}

function validateMaxChars(value: number | undefined): number {
  const maxChars = value ?? DEFAULT_MAX_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_MAX_CHARS || maxChars > MAX_MAX_CHARS) {
    throw new Error(`max_chars must be an integer from ${MIN_MAX_CHARS.toLocaleString("en-US")} to ${MAX_MAX_CHARS.toLocaleString("en-US")}`);
  }
  return maxChars;
}

function searchWindows(transcript: MaterializedTranscript, query: string, contextEntries: number): SearchWindow[] {
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  const matches = transcript.entries.flatMap((entry, index) =>
    entry.searchText.toLocaleLowerCase("en-US").includes(normalizedQuery) ? [index] : []
  );
  const windows: SearchWindow[] = [];
  for (const match of matches) {
    const candidate: SearchWindow = {
      start: Math.max(0, match - contextEntries),
      end: Math.min(transcript.entries.length - 1, match + contextEntries),
      matches: [match],
    };
    const previous = windows.at(-1);
    if (previous && candidate.start <= previous.end) {
      previous.end = Math.max(previous.end, candidate.end);
      previous.matches.push(match);
    } else {
      windows.push(candidate);
    }
  }
  return windows;
}

function searchExcerpt(text: string, query: string): string {
  const index = text.toLocaleLowerCase("en-US").indexOf(query.toLocaleLowerCase("en-US"));
  if (index < 0) return "";
  const start = Math.max(0, index - 100);
  const end = Math.min(text.length, index + query.length + 100);
  const excerpt = sanitizeLabel(text.slice(start, end), SEARCH_EXCERPT_CHARS) ?? "";
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

function formatSearchWindow(
  transcript: MaterializedTranscript,
  window: SearchWindow,
  query: string,
): string {
  const matches = new Set(window.matches);
  const entries: string[] = [];
  for (let index = window.start; index <= window.end; index++) {
    const item = transcript.entries[index]!;
    const matched = matches.has(index);
    entries.push(`${matched ? "*" : " "} ${formatListRecord(item)}`);
    if (matched) entries.push(`  ... ${inlineValue(searchExcerpt(item.searchText, query))} ...`);
  }
  return `<result lines="${window.start + 1}-${window.end + 1}" matches="${window.matches.length}">\n${entries.join("\n")}\n</result>`;
}

function renderSearchText(
  taskId: string,
  transcript: MaterializedTranscript,
  query: string,
  totalMatches: number,
  records: string[],
  nextCursor?: string,
): string {
  const displayQuery = sanitizeLabel(query, 160) ?? "";
  const artifact = transcript.descriptor;
  const header = `<task-search id="${xmlAttribute(taskId)}" query="${xmlAttribute(displayQuery)}" matches="${totalMatches}" returned="${records.length}" path="${xmlAttribute(artifact.path)}">`;
  const body = [header, ...records, "</task-search>"].join("\n\n");
  return nextCursor ? `${body}\nContinue with expand_task view=search and cursor: ${nextCursor}` : body;
}

function resolveSearchPosition(
  taskId: string,
  transcript: MaterializedTranscript,
  options: SearchTranscriptOptions,
): { direction: ExpansionDirection; resultIndex: number; query: string; contextEntries: number } {
  const artifact = transcript.descriptor;
  if (!options.cursor) {
    if (options.query === undefined || options.query.length === 0) {
      throw new Error("query is required for expand_task view: search");
    }
    const contextEntries = options.contextEntries ?? DEFAULT_CONTEXT_ENTRIES;
    if (!Number.isSafeInteger(contextEntries) || contextEntries < 0 || contextEntries > MAX_CONTEXT_ENTRIES) {
      throw new Error(`context_entries must be an integer from 0 to ${MAX_CONTEXT_ENTRIES}`);
    }
    const direction = options.direction ?? "forward";
    const windows = searchWindows(transcript, options.query, contextEntries);
    return {
      direction,
      resultIndex: direction === "forward" ? 0 : windows.length - 1,
      query: options.query,
      contextEntries,
    };
  }

  if (options.query !== undefined) throw new Error("cursor is mutually exclusive with query for expand_task view: search");
  const cursor = decodeCursor(options.cursor);
  if (cursor.view !== "search" || cursor.query === null || cursor.contextEntries === null) {
    throw new Error(`expand_task cursor belongs to view ${cursor.view}, not search`);
  }
  if (cursor.taskId !== taskId) throw new Error(`expand_task cursor belongs to task ${cursor.taskId}, not ${taskId}`);
  if (cursor.beginEntryId !== artifact.beginEntryId || cursor.endEntryId !== artifact.endEntryId) {
    throw new Error("expand_task cursor task boundaries do not match the active branch");
  }
  if (cursor.artifactSha256 !== artifact.sha256) {
    throw new Error("expand_task cursor artifact hash does not match the active task transcript");
  }
  if (options.direction !== undefined && options.direction !== cursor.direction) {
    throw new Error(`expand_task cursor direction is ${cursor.direction}, not ${options.direction}`);
  }
  if (options.contextEntries !== undefined && options.contextEntries !== cursor.contextEntries) {
    throw new Error(`expand_task cursor context_entries is ${cursor.contextEntries}, not ${options.contextEntries}`);
  }
  if (cursor.contextEntries < 0 || cursor.contextEntries > MAX_CONTEXT_ENTRIES) {
    throw new Error("expand_task cursor context_entries is invalid");
  }
  const request: CursorRequest = {
    view: "search",
    query: cursor.query,
    contextEntries: cursor.contextEntries,
  };
  if (cursor.requestFingerprint !== cursorFingerprint(taskId, artifact, cursor.direction, request)) {
    throw new Error("expand_task cursor request fingerprint is invalid");
  }
  const windows = searchWindows(transcript, cursor.query, cursor.contextEntries);
  if (cursor.resultIndex < 0 || cursor.resultIndex >= windows.length) {
    throw new Error("expand_task cursor result index is outside the search results");
  }
  return {
    direction: cursor.direction,
    resultIndex: cursor.resultIndex,
    query: cursor.query,
    contextEntries: cursor.contextEntries,
  };
}

export function searchTaskTranscript(
  taskId: string,
  transcript: MaterializedTranscript,
  options: SearchTranscriptOptions,
): SearchTranscriptResult {
  const maxChars = validateMaxChars(options.maxChars);
  const resolved = resolveSearchPosition(taskId, transcript, options);
  const windows = searchWindows(transcript, resolved.query, resolved.contextEntries);
  const totalMatches = windows.reduce((sum, window) => sum + window.matches.length, 0);
  const request: CursorRequest = {
    view: "search",
    query: resolved.query,
    contextEntries: resolved.contextEntries,
  };

  if (windows.length === 0) {
    const text = renderSearchText(taskId, transcript, resolved.query, 0, []);
    if (text.length > maxChars) throw new Error(`max_chars ${maxChars.toLocaleString("en-US")} is too small for the search response`);
    return {
      text,
      details: {
        truncated: false,
        returnedChars: text.length,
        returnedRecords: 0,
        totalRecords: 0,
        totalMatches: 0,
      },
    };
  }

  const step = resolved.direction === "forward" ? 1 : -1;
  const selectedIndices: number[] = [];
  let scanIndex = resolved.resultIndex;
  while (scanIndex >= 0 && scanIndex < windows.length) {
    const candidateIndices = [...selectedIndices, scanIndex];
    const ordered = [...candidateIndices].sort((left, right) => left - right);
    const continuationIndex = scanIndex + step;
    const nextCursor = continuationIndex >= 0 && continuationIndex < windows.length
      ? encodeCursor(taskId, transcript.descriptor, continuationIndex, resolved.direction, request)
      : undefined;
    const candidateText = renderSearchText(
      taskId,
      transcript,
      resolved.query,
      totalMatches,
      ordered.map((index) => formatSearchWindow(transcript, windows[index]!, resolved.query)),
      nextCursor,
    );
    if (candidateText.length > maxChars) break;
    selectedIndices.push(scanIndex);
    scanIndex += step;
  }
  if (selectedIndices.length === 0) {
    throw new Error(`max_chars ${maxChars.toLocaleString("en-US")} is too small for one complete search result window and continuation cursor`);
  }

  const orderedIndices = [...selectedIndices].sort((left, right) => left - right);
  const low = orderedIndices[0]!;
  const high = orderedIndices.at(-1)!;
  const nextIndex = resolved.direction === "forward" ? high + 1 : low - 1;
  const previousIndex = resolved.direction === "forward" ? low - 1 : high + 1;
  const nextCursor = nextIndex >= 0 && nextIndex < windows.length
    ? encodeCursor(taskId, transcript.descriptor, nextIndex, resolved.direction, request)
    : undefined;
  const reverseDirection: ExpansionDirection = resolved.direction === "forward" ? "backward" : "forward";
  const previousCursor = previousIndex >= 0 && previousIndex < windows.length
    ? encodeCursor(taskId, transcript.descriptor, previousIndex, reverseDirection, request)
    : undefined;
  const text = renderSearchText(
    taskId,
    transcript,
    resolved.query,
    totalMatches,
    orderedIndices.map((index) => formatSearchWindow(transcript, windows[index]!, resolved.query)),
    nextCursor,
  );
  if (text.length > maxChars) throw new Error("Internal error: bounded expand_task search output exceeded max_chars");

  const truncated = selectedIndices.length < windows.length;
  return {
    text,
    details: {
      truncated,
      ...(truncated ? { truncationReason: "max_chars" as const } : {}),
      returnedChars: text.length,
      returnedRecords: selectedIndices.length,
      totalRecords: windows.length,
      totalMatches,
      ...(nextCursor ? { nextCursor } : {}),
      ...(previousCursor ? { previousCursor } : {}),
    },
  };
}

export function formatTranscriptResult(taskId: string, artifact: TranscriptArtifact): string {
  return `Task ${taskId} transcript: ${artifact.path}\n${artifact.entries.toLocaleString("en-US")} entries, ${artifact.bytes.toLocaleString("en-US")} bytes, sha256 ${artifact.sha256}`;
}

export function formatEntryResult(locator: EntryLocator): string {
  return `Entry ${locator.entryId} is line ${locator.line.toLocaleString("en-US")} of ${locator.path}`;
}
