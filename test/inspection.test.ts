import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { LocalTaskInspector } from "../src/inspect/inspect.js";
import { registerTaskFramework } from "../src/task-framework.js";

function assistant(
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  text?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(text === undefined ? [] : [{ type: "text" as const, text }]),
      { type: "toolCall", id: toolCallId, name, arguments: args },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  details?: unknown,
) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    ...(details === undefined ? {} : { details }),
    isError: false,
    timestamp: Date.now(),
  };
}

function config(): Config {
  return {
    features: { tasks: true, summaries: true, compaction: true, agents: false },
    limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
  };
}

function harness(manager: SessionManager) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) {
      manager.appendCustomEntry(customType, data);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: manager,
    ui: { setStatus() {}, notify() {} },
  } as unknown as ExtensionContext;
  const services = registerTaskFramework(pi, config())!;
  return { handlers, tools, ctx, services };
}

const summary = (name: string) => ({
  objective: `${name} objective`,
  outcome: `${name} outcome`,
  attempted: [`${name} attempt`],
  learnings: [`${name} learning`],
  decisions: [`${name} decision`],
  files_read: [`${name}.read`],
  files_modified: [`${name}.modified`],
  verification: [`${name} verified`],
  open_threads: [],
});

interface Fixture {
  manager: SessionManager;
  rootId: string;
  childId: string;
  outputId: string;
  sourceEntryId: string;
  beginEntryId: string;
  endResultEntryId: string;
  inspector: LocalTaskInspector;
  services: ReturnType<typeof harness>["services"];
  tools: Map<string, any>;
  ctx: ExtensionContext;
}

async function completedFixture(cacheRoot: string): Promise<Fixture> {
  const manager = SessionManager.inMemory(`/tmp/task-inspection-${process.pid}-${Date.now()}`);
  manager.appendMessage(toolResult("outside-before", "read", "unrelated before"));
  const { handlers, tools, ctx, services } = harness(manager);
  await handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

  manager.appendMessage(assistant("begin-root", "begin_task", { task: "root task" }));
  const beginEntryId = manager.getLeafId()!;
  const root = await tools.get("begin_task").execute(
    "begin-root",
    { task: "root task" },
    undefined,
    undefined,
    ctx,
  );
  const rootId = root.details.task_id as string;
  manager.appendMessage(toolResult("begin-root", "begin_task", "opened root"));

  manager.appendMessage(assistant("begin-child", "begin_task", { task: "child task" }));
  const child = await tools.get("begin_task").execute(
    "begin-child",
    { task: "child task" },
    undefined,
    undefined,
    ctx,
  );
  const childId = child.details.task_id as string;
  manager.appendMessage(toolResult("begin-child", "begin_task", "opened child"));
  manager.appendCustomEntry("inspection-test", { text: "CUSTOM_SEARCH_NEEDLE child record" });
  manager.appendMessage(assistant("end-child", "end_task", { task_id: childId, ...summary("child") }));
  await tools.get("end_task").execute(
    "end-child",
    { task_id: childId, ...summary("child") },
    undefined,
    undefined,
    ctx,
  );
  manager.appendMessage(toolResult("end-child", "end_task", "closed child"));

  manager.appendMessage(
    assistant("ordinary-source", "read", {
      path: "src/important.ts",
      secret: "TOP_SECRET_ARGUMENT",
      nested: { needle: "ARGUMENT_SEARCH_NEEDLE" },
    }),
  );
  manager.appendMessage(
    toolResult(
      "ordinary-source",
      "read",
      `${"x".repeat(8_000)} DEEP_RESULT_SEARCH_NEEDLE`,
      { truncation: { truncated: true } },
    ),
  );
  const sourceEntryId = manager.getLeafId()!;
  manager.appendMessage(assistant("preserve-source", "preserve_output", {
    tool_call_id: "ordinary-source",
    pin: true,
  }));
  const preserved = await tools.get("preserve_output").execute(
    "preserve-source",
    { tool_call_id: "ordinary-source", pin: true },
    undefined,
    undefined,
    ctx,
  );
  const outputId = preserved.details.output_id as string;
  manager.appendMessage(toolResult("preserve-source", "preserve_output", "preserved"));

  manager.appendMessage({
    role: "user",
    content: "PROTECTED_SEARCH_NEEDLE question",
    timestamp: Date.now(),
  });
  manager.appendMessage(
    assistant("protect-user", "respond_to_user", {}, "PROTECTED_RESPONSE_NEEDLE answer"),
  );
  await tools.get("respond_to_user").execute(
    "protect-user",
    {},
    undefined,
    undefined,
    ctx,
  );
  manager.appendMessage(toolResult("protect-user", "respond_to_user", "protected"));

  for (let index = 0; index < 18; index += 1) {
    manager.appendCustomEntry("inspection-page", {
      text: `PAGED_SEARCH_NEEDLE record ${index}`,
    });
  }

  manager.appendMessage(assistant("end-root", "end_task", { task_id: rootId, ...summary("root") }));
  await tools.get("end_task").execute(
    "end-root",
    { task_id: rootId, ...summary("root") },
    undefined,
    undefined,
    ctx,
  );
  manager.appendMessage(toolResult("end-root", "end_task", "closed root"));
  const endResultEntryId = manager.getLeafId()!;
  await handlers.get("turn_end")![0]!({ type: "turn_end" }, ctx);
  manager.appendMessage(toolResult("outside-after", "read", "unrelated after"));

  const inspector = new LocalTaskInspector(services.runtime, {
    cacheRoot,
    projection: services.projection,
  });
  return {
    manager,
    rootId,
    childId,
    outputId,
    sourceEntryId,
    beginEntryId,
    endResultEntryId,
    inspector,
    services,
    tools,
    ctx,
  };
}

function details<T extends Record<string, unknown>>(result: { details: Record<string, unknown> }): T {
  return result.details as T;
}

function listedIds(text: string): string[] {
  return [...text.matchAll(/^- \[\d[\d,]* "([^"]+)"\]/gm)].map((match) => match[1]!);
}

function matchedIds(text: string): string[] {
  return [...text.matchAll(/^\* \[\d[\d,]* "([^"]+)"\]/gm)].map((match) => match[1]!);
}

describe("task inspection", () => {
  it("returns complete summary metadata without materializing task history", async () => {
    const cacheRoot = join(await mkdtemp(join(tmpdir(), "task-inspect-summary-")), "cache");
    const fixture = await completedFixture(cacheRoot);
    const result = await fixture.inspector.inspect(
      { task_id: fixture.rootId },
      fixture.manager,
    );
    const value = result.details as any;

    expect(value).toMatchObject({
      view: "summary",
      task_id: fixture.rootId,
      task: "root task",
      status: "completed",
      parent_task_id: null,
      summary: { objective: "root objective", outcome: "root outcome" },
      summary_retained: true,
      local_depth: 1,
      semantic_depth: 1,
      agent_depth: 0,
      execution: { kind: "local", sessionId: fixture.manager.getSessionId() },
      source: { sessionId: fixture.manager.getSessionId() },
      preserved_output_count: 1,
      pinned_output_count: 1,
      protected_interaction_count: 1,
    });
    expect(value.direct_children).toEqual([{ task_id: fixture.childId, task: "child task" }]);
    expect(value.preserved_outputs).toEqual([
      expect.objectContaining({
        output_id: fixture.outputId,
        tool_name: "read",
        tool_call_id: "ordinary-source",
        pin: true,
        closure_entry_count: 2,
      }),
    ]);
    expect(value.protected_interactions).toEqual([
      expect.objectContaining({ marker_tool_call_id: "protect-user" }),
    ]);
    expect(result.text).not.toContain("DEEP_RESULT_SEARCH_NEEDLE");
    await expect(
      fixture.inspector.inspect({ task_id: fixture.rootId, view: "summary", query: "no" }, fixture.manager),
    ).rejects.toThrow("query is not valid");
  });

  it("materializes the exact private JSONL task range and exact entry locators", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "task-inspect-artifact-"));
    const cacheRoot = join(sandbox, "cache");
    const fixture = await completedFixture(cacheRoot);
    const transcriptResult = await fixture.inspector.inspect(
      { task_id: fixture.rootId, view: "transcript" },
      fixture.manager,
    );
    const artifact = (transcriptResult.details as any).artifact;
    const raw = await readFile(artifact.path, "utf8");
    const lines = raw.trimEnd().split("\n");
    const branch = fixture.manager.getBranch();
    const start = branch.findIndex((entry) => entry.id === fixture.beginEntryId);
    const end = branch.findIndex((entry) => entry.id === fixture.endResultEntryId);

    expect(lines.map((line) => JSON.parse(line).id)).toEqual(
      branch.slice(start, end + 1).map((entry) => entry.id),
    );
    expect(raw).toContain("DEEP_RESULT_SEARCH_NEEDLE");
    expect(raw).not.toContain("unrelated before");
    expect(raw).not.toContain("unrelated after");
    expect(artifact).toMatchObject({
      taskId: fixture.rootId,
      sessionId: fixture.manager.getSessionId(),
      entries: lines.length,
      beginEntryId: fixture.beginEntryId,
      endEntryId: fixture.endResultEntryId,
      complete: true,
    });
    expect(createHash("sha256").update(raw).digest("hex")).toBe(artifact.sha256);
    expect((await stat(cacheRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(artifact.path))).mode & 0o777).toBe(0o700);
    expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);

    const entryResult = await fixture.inspector.inspect(
      { task_id: fixture.rootId, view: "entry", entry: fixture.sourceEntryId },
      fixture.manager,
    );
    const locator = (entryResult.details as any).locator;
    expect(JSON.parse(lines[locator.line - 1]!).id).toBe(fixture.sourceEntryId);
    expect(locator).toMatchObject({
      path: artifact.path,
      entryId: fixture.sourceEntryId,
      artifactSha256: artifact.sha256,
    });
    expect(entryResult.text).not.toContain("DEEP_RESULT_SEARCH_NEEDLE");
    await expect(
      fixture.inspector.inspect({ task_id: fixture.rootId, view: "entry", entry: "outside" }, fixture.manager),
    ).rejects.toThrow("does not belong to task");

    await chmod(artifact.path, 0o600);
    await writeFile(artifact.path, "corrupt\n");
    const restored = await fixture.inspector.inspect(
      { task_id: fixture.rootId, view: "transcript" },
      fixture.manager,
    );
    expect((restored.details as any).artifact).toEqual(artifact);
    expect(await readFile(artifact.path, "utf8")).toContain("DEEP_RESULT_SEARCH_NEEDLE");

    const unsafeTarget = await mkdtemp(join(tmpdir(), "task-inspect-unsafe-target-"));
    const unsafeCache = join(sandbox, "symlink-cache");
    await symlink(unsafeTarget, unsafeCache);
    const unsafeInspector = new LocalTaskInspector(fixture.services.runtime, {
      cacheRoot: unsafeCache,
    });
    await expect(
      unsafeInspector.inspect({ task_id: fixture.rootId, view: "transcript" }, fixture.manager),
    ).rejects.toThrow("not a private directory");
  });

  it("pages safe list metadata without gaps or leaking raw arguments and results", async () => {
    const cacheRoot = join(await mkdtemp(join(tmpdir(), "task-inspect-list-")), "cache");
    const fixture = await completedFixture(cacheRoot);
    const transcript = await fixture.inspector.inspect(
      { task_id: fixture.rootId, view: "transcript" },
      fixture.manager,
    );
    const artifact = (transcript.details as any).artifact;
    const expectedIds = (await readFile(artifact.path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line).id as string);

    const ids: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    do {
      const page = await fixture.inspector.inspect(
        {
          task_id: fixture.rootId,
          view: "list",
          max_chars: 1_000,
          ...(cursor ? { cursor } : {}),
        },
        fixture.manager,
      );
      expect(page.text.length).toBeLessThanOrEqual(1_000);
      expect(page.text).not.toContain("TOP_SECRET_ARGUMENT");
      expect(page.text).not.toContain("x".repeat(100));
      ids.push(...listedIds(page.text));
      cursor = (page.details as any).nextCursor;
      firstCursor ??= cursor;
    } while (cursor);

    expect(ids).toEqual(expectedIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(firstCursor).toBeDefined();
    await expect(
      fixture.inspector.inspect(
        { task_id: fixture.rootId, view: "search", cursor: firstCursor! },
        fixture.manager,
      ),
    ).rejects.toThrow("belongs to view list, not search");

    const decoded = JSON.parse(Buffer.from(firstCursor!, "base64url").toString("utf8"));
    decoded.requestFingerprint = `${decoded.requestFingerprint.startsWith("0") ? "1" : "0"}${decoded.requestFingerprint.slice(1)}`;
    const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    await expect(
      fixture.inspector.inspect(
        { task_id: fixture.rootId, view: "list", cursor: tampered },
        fixture.manager,
      ),
    ).rejects.toThrow("request fingerprint is invalid");
  });

  it("searches complete persisted content with bounded hash-bound continuation", async () => {
    const cacheRoot = join(await mkdtemp(join(tmpdir(), "task-inspect-search-")), "cache");
    const fixture = await completedFixture(cacheRoot);

    for (const query of [
      "argument_search_needle",
      "deep_result_search_needle",
      "custom_search_needle",
      "protected_search_needle",
      "protected_response_needle",
    ]) {
      const result = await fixture.inspector.inspect(
        { task_id: fixture.rootId, view: "search", query, max_chars: 2_000 },
        fixture.manager,
      );
      expect((result.details as any).totalMatches, query).toBeGreaterThan(0);
      expect(result.text.toLocaleLowerCase("en-US"), query).toContain(query);
      expect(result.text, query).not.toContain("x".repeat(500));
    }

    const ids: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    do {
      const result = await fixture.inspector.inspect(
        {
          task_id: fixture.rootId,
          view: "search",
          max_chars: 1_500,
          ...(cursor ? { cursor } : { query: "paged_search_needle" }),
        },
        fixture.manager,
      );
      expect(result.text.length).toBeLessThanOrEqual(1_500);
      ids.push(...matchedIds(result.text));
      cursor = (result.details as any).nextCursor;
      firstCursor ??= cursor;
    } while (cursor);
    expect(ids).toHaveLength(18);
    expect(new Set(ids).size).toBe(18);

    await expect(
      fixture.inspector.inspect(
        {
          task_id: fixture.rootId,
          view: "search",
          cursor: firstCursor!,
          query: "paged_search_needle",
        },
        fixture.manager,
      ),
    ).rejects.toThrow("mutually exclusive");
    const empty = await fixture.inspector.inspect(
      { task_id: fixture.rootId, view: "search", query: "ABSENT_FROM_TRANSCRIPT", max_chars: 1_000 },
      fixture.manager,
    );
    expect(empty.details).toMatchObject({
      totalMatches: 0,
      totalRecords: 0,
      returnedRecords: 0,
      truncated: false,
    });
  });

  it("registers the settled inspect_task schema and executes through the extension", async () => {
    const cacheRoot = join(await mkdtemp(join(tmpdir(), "task-inspect-extension-")), "cache");
    const fixture = await completedFixture(cacheRoot);
    const tool = fixture.tools.get("inspect_task");
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.promptGuidelines.join("\n")).toContain("Use summary first");
    expect(tool.promptGuidelines.join("\n")).toContain("do not copy them into the repository");

    fixture.manager.appendMessage(
      assistant("inspect-summary", "inspect_task", { task_id: fixture.rootId }),
    );
    const result = await tool.execute(
      "inspect-summary",
      { task_id: fixture.rootId },
      undefined,
      undefined,
      fixture.ctx,
    );
    expect(result.details).toMatchObject({
      view: "summary",
      task_id: fixture.rootId,
      task: "root task",
    });
    expect(result.content[0].text).toContain("root objective");
  });
});
