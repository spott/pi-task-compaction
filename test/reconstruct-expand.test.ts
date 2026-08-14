import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  formatEntryResult,
  formatTranscriptResult,
  listTaskTranscript,
  locateTranscriptEntry,
  materializeTaskTranscript,
  searchTaskTranscript,
} from "../src/expand.js";
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

  it("materializes the exact inclusive task range as complete private JSONL", async () => {
    const branch = entriesFor([
      toolResult("before", "other", undefined, "unrelated before"),
      ...closedTaskMessages("recover"),
      toolResult("after", "other", undefined, "unrelated after"),
    ]);
    const task = reconstructTaskIndex(branch).tasks.get("recover")!;
    const sandbox = await mkdtemp(join(tmpdir(), "expand-test-"));
    const transcript = await materializeTaskTranscript(branch, task, {
      sessionId: "session-one",
      cacheRoot: join(sandbox, "cache"),
    });

    expect(transcript.descriptor.entries).toBe(6);
    expect(transcript.descriptor.beginEntryId).toBe(branch[1]!.id);
    expect(transcript.descriptor.endEntryId).toBe(branch[6]!.id);
    const raw = await readFile(transcript.descriptor.path, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(branch.slice(1, 7).map((entry) => entry.id));
    expect(raw).toContain("x".repeat(8000));
    expect(raw).not.toContain("unrelated before");
    expect(raw).not.toContain("unrelated after");
    expect(formatTranscriptResult("recover", transcript.descriptor)).toContain(transcript.descriptor.path);
    expect(formatTranscriptResult("recover", transcript.descriptor)).not.toContain("x".repeat(100));

    expect((await stat(join(sandbox, "cache"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(sandbox, "cache", transcript.descriptor.path.split("/").at(-2)!))).mode & 0o777).toBe(0o700);
    expect((await stat(transcript.descriptor.path)).mode & 0o777).toBe(0o600);
  });

  it("verifies cached bytes before reuse and restores a corrupted artifact atomically", async () => {
    const branch = entriesFor(closedTaskMessages("recover"));
    const task = reconstructTaskIndex(branch).tasks.get("recover")!;
    const sandbox = await mkdtemp(join(tmpdir(), "expand-reuse-test-"));
    const options = { sessionId: "session-reuse", cacheRoot: join(sandbox, "cache") };
    const first = await materializeTaskTranscript(branch, task, options);
    await chmod(first.descriptor.path, 0o600);
    await writeFile(first.descriptor.path, "corrupt\n");

    const second = await materializeTaskTranscript(branch, task, options);
    expect(second.descriptor).toEqual(first.descriptor);
    expect(await readFile(second.descriptor.path, "utf8")).toContain("x".repeat(8000));
  });

  it("lists safe compact metadata and reports source-tool truncation without leaking arguments", async () => {
    const branch = entriesFor(closedTaskMessages("list"));
    const callEntry = branch[2]!;
    if (callEntry.type === "message" && callEntry.message.role === "assistant") {
      const call = callEntry.message.content.find((block) => block.type === "toolCall");
      if (call?.type === "toolCall") call.arguments = { ...call.arguments, secret: "TOP_SECRET_ARGUMENT" };
    }
    const resultEntry = branch[3]!;
    if (resultEntry.type === "message" && resultEntry.message.role === "toolResult") {
      resultEntry.message.details = { truncation: { truncated: true } };
    }
    const task = reconstructTaskIndex(branch).tasks.get("list")!;
    const transcript = await materializeTaskTranscript(branch, task, {
      sessionId: "session-list",
      cacheRoot: join(await mkdtemp(join(tmpdir(), "expand-list-test-")), "cache"),
    });

    const page = listTaskTranscript("list", transcript, { maxChars: 50_000 });
    expect(page.text.length).toBe(page.details.returnedChars);
    expect(page.details).toMatchObject({
      truncated: false,
      returnedRecords: transcript.entries.length,
      totalRecords: transcript.entries.length,
    });
    expect(page.text).toContain(`[3 "${branch[2]!.id}"] assistant calls="read"#"read-list"`);
    expect(page.text).toContain('path="src/read.ts"');
    expect(page.text).toContain(`[4 "${branch[3]!.id}"] toolResult "read" call="read-list"`);
    expect(page.text).toContain("source-truncated");
    expect(page.text).not.toContain("TOP_SECRET_ARGUMENT");
    expect(page.text).not.toContain("x".repeat(100));
  });

  it("pages list records forward and backward without gaps, duplication, or max_chars overflow", async () => {
    const branch = entriesFor(closedTaskMessages("pages"));
    const task = reconstructTaskIndex(branch).tasks.get("pages")!;
    const transcript = await materializeTaskTranscript(branch, task, {
      sessionId: "session-pages",
      cacheRoot: join(await mkdtemp(join(tmpdir(), "expand-pages-test-")), "cache"),
    });
    const idsFrom = (text: string): string[] => [...text.matchAll(/^\[\d[\d,]* "([^"]+)"\]/gm)].map((match) => match[1]!);

    const forwardIds: string[] = [];
    let cursor: string | undefined;
    let firstPage: ReturnType<typeof listTaskTranscript> | undefined;
    do {
      const page = listTaskTranscript("pages", transcript, { cursor, maxChars: 1_000 });
      firstPage ??= page;
      expect(page.text.length).toBeLessThanOrEqual(1_000);
      forwardIds.push(...idsFrom(page.text));
      cursor = page.details.nextCursor;
    } while (cursor);
    expect(forwardIds).toEqual(transcript.entries.map((entry) => entry.entryId));
    expect(new Set(forwardIds).size).toBe(forwardIds.length);
    expect(firstPage?.details.truncated).toBe(true);

    const backwardIds: string[] = [];
    cursor = undefined;
    do {
      const page = listTaskTranscript("pages", transcript, { cursor, direction: cursor ? undefined : "backward", maxChars: 1_000 });
      backwardIds.unshift(...idsFrom(page.text));
      cursor = page.details.nextCursor;
    } while (cursor);
    expect(backwardIds).toEqual(transcript.entries.map((entry) => entry.entryId));

    const secondPage = listTaskTranscript("pages", transcript, {
      cursor: firstPage!.details.nextCursor,
      maxChars: 1_000,
    });
    expect(secondPage.details.previousCursor).toBeDefined();
    const returned = listTaskTranscript("pages", transcript, {
      cursor: secondPage.details.previousCursor,
      maxChars: 1_000,
    });
    expect(idsFrom(returned.text)).toEqual(idsFrom(firstPage!.text));
  });

  it("searches complete decoded calls, reasoning, responses, result text, and custom messages", async () => {
    const branch = entriesFor(closedTaskMessages("search"));
    const callEntry = branch[2]!;
    if (callEntry.type === "message" && callEntry.message.role === "assistant") {
      callEntry.message.content.unshift(
        { type: "text", text: "Assistant RESPONSE_NEEDLE" },
        { type: "thinking", thinking: "private REASONING_NEEDLE" },
      );
      const call = callEntry.message.content.find((block) => block.type === "toolCall");
      if (call?.type === "toolCall") call.arguments = { path: "src/read.ts", nested: { value: "ARGUMENT_NEEDLE" } };
    }
    const resultEntry = branch[3]!;
    if (resultEntry.type === "message" && resultEntry.message.role === "toolResult") {
      resultEntry.message.content = [{ type: "text", text: `${"z".repeat(3_000)}DEEP_RESULT_NEEDLE` }];
    }
    const task = reconstructTaskIndex(branch).tasks.get("search")!;
    branch.splice(4, 0, {
      type: "custom_message",
      id: "custom-search-entry",
      parentId: branch[3]!.id,
      timestamp: new Date().toISOString(),
      customType: "test-message",
      content: "CUSTOM_MESSAGE_NEEDLE",
      display: false,
    });
    task.endEntryIndex! += 1;
    const transcript = await materializeTaskTranscript(branch, task, {
      sessionId: "session-search-sources",
      cacheRoot: join(await mkdtemp(join(tmpdir(), "expand-search-sources-test-")), "cache"),
    });

    for (const query of [
      "argument_needle",
      "reasoning_needle",
      "response_needle",
      "deep_result_needle",
      "custom_message_needle",
    ]) {
      const result = searchTaskTranscript("search", transcript, { query, contextEntries: 0, maxChars: 50_000 });
      expect(result.details.totalMatches, query).toBe(1);
      expect(result.details.returnedRecords, query).toBe(1);
      expect(result.text.toLocaleLowerCase("en-US"), query).toContain(query);
      expect(result.text.length, query).toBe(result.details.returnedChars);
      expect(result.text, query).not.toContain("z".repeat(500));
      expect(result.text, query).toContain(transcript.descriptor.path);
    }

    const empty = searchTaskTranscript("search", transcript, {
      query: "NOT_PRESENT_ANYWHERE",
      maxChars: 1_000,
    });
    expect(empty.details).toMatchObject({ totalMatches: 0, totalRecords: 0, returnedRecords: 0, truncated: false });
  });

  it("merges overlapping search context windows without duplicate entries", async () => {
    const branch = entriesFor(closedTaskMessages("merge"));
    const first = branch[1]!;
    const second = branch[3]!;
    if (first.type === "message" && first.message.role === "toolResult") {
      first.message.content = [{ type: "text", text: "first MERGE_NEEDLE" }];
    }
    if (second.type === "message" && second.message.role === "toolResult") {
      second.message.content = [{ type: "text", text: "second merge_needle" }];
    }
    const task = reconstructTaskIndex(branch).tasks.get("merge")!;
    const transcript = await materializeTaskTranscript(branch, task, {
      sessionId: "session-search-merge",
      cacheRoot: join(await mkdtemp(join(tmpdir(), "expand-search-merge-test-")), "cache"),
    });

    const result = searchTaskTranscript("merge", transcript, {
      query: "MeRgE_NeEdLe",
      contextEntries: 1,
      maxChars: 50_000,
    });
    expect(result.details).toMatchObject({ totalMatches: 2, totalRecords: 1, returnedRecords: 1, truncated: false });
    for (const entry of transcript.entries.slice(0, 5)) {
      expect(result.text.match(new RegExp(`"${entry.entryId}"`, "g"))).toHaveLength(1);
    }
  });

  it("pages search windows in both directions and validates cursor request provenance", async () => {
    const branch = entriesFor(closedTaskMessages("search-pages"));
    const extras: SessionEntry[] = Array.from({ length: 16 }, (_, index) => ({
      type: "custom",
      id: `search-extra-${index}`,
      parentId: branch[1]!.id,
      timestamp: new Date().toISOString(),
      customType: "search-test",
      data: { text: `PAGE_NEEDLE record ${index}` },
    }));
    branch.splice(2, 0, ...extras);
    const task = reconstructTaskIndex(branch).tasks.get("search-pages")!;
    const sandbox = await mkdtemp(join(tmpdir(), "expand-search-pages-test-"));
    const options = { sessionId: "session-search-pages", cacheRoot: join(sandbox, "cache") };
    const transcript = await materializeTaskTranscript(branch, task, options);
    const idsFrom = (text: string): string[] => [...text.matchAll(/^\* \[\d[\d,]* "([^"]+)"\]/gm)].map((match) => match[1]!);

    const forwardIds: string[] = [];
    let cursor: string | undefined;
    let firstPage: ReturnType<typeof searchTaskTranscript> | undefined;
    do {
      const page = searchTaskTranscript("search-pages", transcript, {
        ...(cursor ? { cursor } : { query: "page_needle", contextEntries: 0 }),
        maxChars: 1_500,
      });
      firstPage ??= page;
      expect(page.text.length).toBeLessThanOrEqual(1_500);
      forwardIds.push(...idsFrom(page.text));
      cursor = page.details.nextCursor;
    } while (cursor);
    expect(forwardIds).toEqual(extras.map((entry) => entry.id));
    expect(new Set(forwardIds).size).toBe(forwardIds.length);

    const backwardIds: string[] = [];
    cursor = undefined;
    do {
      const page = searchTaskTranscript("search-pages", transcript, {
        ...(cursor ? { cursor } : { query: "page_needle", contextEntries: 0, direction: "backward" as const }),
        maxChars: 1_500,
      });
      backwardIds.unshift(...idsFrom(page.text));
      cursor = page.details.nextCursor;
    } while (cursor);
    expect(backwardIds).toEqual(extras.map((entry) => entry.id));

    const firstCursor = firstPage!.details.nextCursor!;
    expect(() => searchTaskTranscript("other", transcript, { cursor: firstCursor })).toThrow("belongs to task search-pages, not other");
    expect(() => searchTaskTranscript("search-pages", transcript, { cursor: firstCursor, query: "page_needle" })).toThrow("mutually exclusive");
    expect(() => searchTaskTranscript("search-pages", transcript, { cursor: firstCursor, contextEntries: 1 })).toThrow("context_entries is 0, not 1");
    expect(() => listTaskTranscript("search-pages", transcript, { cursor: firstCursor })).toThrow("belongs to view search, not list");

    const decoded = JSON.parse(Buffer.from(firstCursor, "base64url").toString("utf8"));
    decoded.query = "different query";
    const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    expect(() => searchTaskTranscript("search-pages", transcript, { cursor: tampered })).toThrow("request fingerprint is invalid");

    const changedBranch = structuredClone(branch);
    const changed = changedBranch[3]!;
    if (changed.type === "custom") changed.data = { text: "PAGE_NEEDLE changed persisted text" };
    const changedTranscript = await materializeTaskTranscript(changedBranch, task, options);
    expect(() => searchTaskTranscript("search-pages", changedTranscript, { cursor: firstCursor })).toThrow("artifact hash does not match");
  });

  it("rejects list cursors with mismatched task, direction, or artifact provenance", async () => {
    const branch = entriesFor(closedTaskMessages("cursor"));
    const task = reconstructTaskIndex(branch).tasks.get("cursor")!;
    const sandbox = await mkdtemp(join(tmpdir(), "expand-cursor-test-"));
    const options = { sessionId: "session-cursor", cacheRoot: join(sandbox, "cache") };
    const transcript = await materializeTaskTranscript(branch, task, options);
    const cursor = listTaskTranscript("cursor", transcript, { maxChars: 1_000 }).details.nextCursor!;

    expect(() => listTaskTranscript("other", transcript, { cursor })).toThrow("belongs to task cursor, not other");
    expect(() => listTaskTranscript("cursor", transcript, { cursor, direction: "backward" })).toThrow("direction is forward");

    const changedBranch = structuredClone(branch);
    const changedEntry = changedBranch[3]!;
    if (changedEntry.type === "message" && changedEntry.message.role === "toolResult") {
      changedEntry.message.content = [{ type: "text", text: "changed persisted result" }];
    }
    const changedTranscript = await materializeTaskTranscript(changedBranch, task, options);
    expect(() => listTaskTranscript("cursor", changedTranscript, { cursor })).toThrow("artifact hash does not match");
  });

  it("keeps artifacts and cursors stable when unrelated entries are appended after a closed task", async () => {
    const branch = entriesFor(closedTaskMessages("stable"));
    const task = reconstructTaskIndex(branch).tasks.get("stable")!;
    const sandbox = await mkdtemp(join(tmpdir(), "expand-stable-test-"));
    const options = { sessionId: "session-stable", cacheRoot: join(sandbox, "cache") };
    const original = await materializeTaskTranscript(branch, task, options);
    const cursor = listTaskTranscript("stable", original, { maxChars: 1_000 }).details.nextCursor!;

    const descendantBranch: SessionEntry[] = [...branch, {
      type: "custom",
      id: "unrelated-descendant",
      parentId: branch.at(-1)!.id,
      timestamp: new Date().toISOString(),
      customType: "later-state",
      data: { unrelated: true },
    }];
    const descendantTask = reconstructTaskIndex(descendantBranch).tasks.get("stable")!;
    const descendant = await materializeTaskTranscript(descendantBranch, descendantTask, options);

    expect(descendant.descriptor).toEqual(original.descriptor);
    expect(() => listTaskTranscript("stable", descendant, { cursor, maxChars: 1_000 })).not.toThrow();
  });

  it("resolves exact entry lines and rejects entries or boundaries outside the active task", async () => {
    const branch = entriesFor(closedTaskMessages("recover"));
    const task = reconstructTaskIndex(branch).tasks.get("recover")!;
    const sandbox = await mkdtemp(join(tmpdir(), "expand-entry-test-"));
    const transcript = await materializeTaskTranscript(branch, task, {
      sessionId: "session-entry",
      cacheRoot: join(sandbox, "cache"),
    });
    const locator = locateTranscriptEntry(transcript, branch[3]!.id);
    expect(locator.line).toBe(4);
    expect(JSON.parse((await readFile(locator.path, "utf8")).split("\n")[locator.line - 1]!).id).toBe(locator.entryId);
    expect(formatEntryResult(locator)).toBe(`Entry ${locator.entryId} is line 4 of ${locator.path}`);
    expect(() => locateTranscriptEntry(transcript, "outside")).toThrow("does not belong to this task");

    const changedBranch = [...branch];
    changedBranch[0] = { ...changedBranch[0]!, id: "inactive-branch-entry" } as SessionEntry;
    await expect(materializeTaskTranscript(changedBranch, task, {
      sessionId: "session-entry",
      cacheRoot: join(sandbox, "cache"),
    })).rejects.toThrow("boundaries do not match the active branch");
  });
});
