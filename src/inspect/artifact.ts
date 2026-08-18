import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Task } from "../model/task.js";
import { SessionProtocolResolver } from "../transcript/protocol.js";

export const TRANSCRIPT_ARTIFACT_FORMAT = "pi-session-entry-jsonl" as const;
const DEFAULT_CACHE_DIRECTORY = "pi-task-framework-inspect";

export interface TranscriptArtifact {
  path: string;
  format: typeof TRANSCRIPT_ARTIFACT_FORMAT;
  taskId: string;
  sessionId: string;
  entries: number;
  bytes: number;
  sha256: string;
  beginEntryId: string;
  endEntryId: string;
  complete: boolean;
}

export interface MaterializedEntry {
  entry: SessionEntry;
  entryId: string;
  branchIndex: number;
  line: number;
  byteOffset: number;
  byteLength: number;
  serialized: string;
  searchText: string;
}

export interface MaterializedTranscript {
  descriptor: TranscriptArtifact;
  entries: MaterializedEntry[];
}

export interface MaterializeTranscriptOptions {
  cacheRoot?: string;
}

export interface EntryLocator {
  path: string;
  format: typeof TRANSCRIPT_ARTIFACT_FORMAT;
  entryId: string;
  line: number;
  byteOffset: number;
  entryBytes: number;
  entrySha256: string;
  artifactSha256: string;
}

export interface TranscriptArtifactWriter {
  materialize(
    task: Task,
    sessionId: string,
    branch: readonly SessionEntry[],
  ): Promise<MaterializedTranscript>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFilenamePart(value: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (sanitized || "task").slice(0, 64);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Task inspection cache path is not a private directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`Task inspection cache path is not a private directory: ${path}`);
    }
  }
  await chmod(path, 0o700);
}

async function existingArtifactIsValid(
  path: string,
  expected: Buffer,
  expectedSha256: string,
): Promise<boolean> {
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

function appendContentText(parts: string[], content: unknown): void {
  if (typeof content === "string") {
    parts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push(candidate.text);
    } else if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
      parts.push(candidate.thinking);
    }
  }
}

/** Complete decoded text used for literal search; never returned wholesale by list/search. */
export function buildEntrySearchText(entry: SessionEntry): string {
  const parts: string[] = [];
  if (entry.type === "message") {
    const message = entry.message;
    parts.push(message.role);
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "thinking") parts.push(block.thinking);
        else if (block.type === "toolCall") {
          parts.push(block.name, block.id, JSON.stringify(block.arguments));
        }
      }
      if (message.errorMessage) parts.push(message.errorMessage);
    } else if (message.role === "toolResult") {
      parts.push(message.toolName, message.toolCallId);
      appendContentText(parts, message.content);
      if (message.details !== undefined) parts.push(JSON.stringify(message.details));
    } else if (message.role === "bashExecution") {
      parts.push(message.command, message.output);
      if (message.fullOutputPath) parts.push(message.fullOutputPath);
    } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
      parts.push(message.summary);
    } else {
      appendContentText(parts, "content" in message ? message.content : undefined);
      if ("customType" in message && typeof message.customType === "string") {
        parts.push(message.customType);
      }
      if ("details" in message && message.details !== undefined) {
        parts.push(JSON.stringify(message.details));
      }
    }
  } else if (entry.type === "custom_message") {
    parts.push(entry.customType);
    appendContentText(parts, entry.content);
    if (entry.details !== undefined) parts.push(JSON.stringify(entry.details));
  } else if (entry.type === "custom") {
    parts.push(entry.customType);
    if (entry.data !== undefined) parts.push(JSON.stringify(entry.data));
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    parts.push(entry.summary);
    if (entry.details !== undefined) parts.push(JSON.stringify(entry.details));
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

export class PrivateTranscriptArtifactWriter implements TranscriptArtifactWriter {
  constructor(private readonly options: MaterializeTranscriptOptions = {}) {}

  async materialize(
    task: Task,
    sessionId: string,
    branch: readonly SessionEntry[],
  ): Promise<MaterializedTranscript> {
    if (task.transcript.sessionId !== sessionId || task.execution.sessionId !== sessionId) {
      throw new Error(`Task ${task.id} is owned by session ${task.transcript.sessionId}, not ${sessionId}`);
    }
    if (task.status !== "open" && !task.transcript.endAnchor) {
      throw new Error(`Terminal task ${task.id} has no transcript end anchor`);
    }

    const resolver = new SessionProtocolResolver(sessionId, branch);
    const range = resolver.resolveRange({
      start: task.transcript.beginAnchor,
      end: task.transcript.endAnchor ?? { sessionId, entryId: null, boundary: "after" },
    });
    if (range.entries.length === 0) {
      throw new Error(`Task ${task.id} has an empty transcript range on the active branch`);
    }

    const serializedLines = range.entries.map((entry) => JSON.stringify(entry));
    const body = Buffer.from(`${serializedLines.join("\n")}\n`, "utf8");
    const bodySha256 = sha256(body);
    const beginEntryId = range.entries[0]!.id;
    const endEntryId = range.entries.at(-1)!.id;
    const provenanceSha256 = sha256(
      JSON.stringify({
        taskId: task.id,
        sessionId,
        beginEntryId,
        endEntryId,
        entries: range.entries.length,
        complete: task.status !== "open",
      }),
    );

    const cacheRoot = this.options.cacheRoot ?? join(tmpdir(), DEFAULT_CACHE_DIRECTORY);
    const sessionDirectory = join(cacheRoot, sha256(sessionId));
    await ensurePrivateDirectory(cacheRoot);
    await ensurePrivateDirectory(sessionDirectory);

    const filename = `${safeFilenamePart(task.id)}-${provenanceSha256.slice(0, 16)}-${bodySha256}.jsonl`;
    const path = join(sessionDirectory, filename);
    if (!(await existingArtifactIsValid(path, body, bodySha256))) {
      const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new Error(`Refusing to replace unsafe task transcript artifact path: ${path}`);
      }
      await writeArtifactAtomically(path, body);
    } else {
      await chmod(path, 0o600);
    }

    const entries: MaterializedEntry[] = [];
    let byteOffset = 0;
    for (let index = 0; index < range.entries.length; index += 1) {
      const entry = range.entries[index]!;
      const serialized = serializedLines[index]!;
      const byteLength = Buffer.byteLength(serialized, "utf8");
      entries.push({
        entry,
        entryId: entry.id,
        branchIndex: range.start + index,
        line: index + 1,
        byteOffset,
        byteLength,
        serialized,
        searchText: buildEntrySearchText(entry),
      });
      byteOffset += byteLength + 1;
    }

    return {
      descriptor: {
        path,
        format: TRANSCRIPT_ARTIFACT_FORMAT,
        taskId: task.id,
        sessionId,
        entries: entries.length,
        bytes: body.byteLength,
        sha256: bodySha256,
        beginEntryId,
        endEntryId,
        complete: task.status !== "open",
      },
      entries,
    };
  }
}

export function locateTranscriptEntry(
  transcript: MaterializedTranscript,
  entryId: string,
): EntryLocator {
  const match = transcript.entries.find((item) => item.entryId === entryId);
  if (!match) {
    throw new Error(`Entry ${entryId} does not belong to task ${transcript.descriptor.taskId} on the active branch`);
  }
  return {
    path: transcript.descriptor.path,
    format: TRANSCRIPT_ARTIFACT_FORMAT,
    entryId,
    line: match.line,
    byteOffset: match.byteOffset,
    entryBytes: match.byteLength,
    entrySha256: sha256(match.serialized),
    artifactSha256: transcript.descriptor.sha256,
  };
}
