import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { taskEventEnvelope, type TaskEvent } from "../src/model/events.js";
import type { TaskSummary } from "../src/model/summary.js";
import { resolveAndPersistTaskAnchors } from "../src/store/anchor-resolutions.js";
import { PreservationService } from "../src/store/preservation.js";
import { PiTaskEventStore, readTaskEventLog } from "../src/store/task-events.js";
import { LocalTaskRuntime } from "../src/store/task-runtime.js";
import type { TranscriptRange } from "../src/transcript/anchors.js";
import { SessionProtocolResolver } from "../src/transcript/protocol.js";
import { SessionTranscriptResolver } from "../src/transcript/source.js";

const config: Config = {
  features: { tasks: true, summaries: true, compaction: false, agents: false },
  limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
};

const summary: TaskSummary = {
  objective: "preserve useful output",
  outcome: "done",
  attempted: [],
  learnings: [],
  decisions: [],
  files_read: [],
  files_modified: [],
  verification: [],
  open_threads: [],
};

function assistant(calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall" as const,
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
    })),
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
    timestamp: 1,
  };
}

function result(
  id: string,
  name: string,
  text: string,
  extra: Partial<ToolResultMessage> = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
    ...extra,
  };
}

function preservationHarness(
  manager = SessionManager.inMemory("/tmp/task-framework-preservation-test"),
) {
  let taskId = 0;
  const runtime = new LocalTaskRuntime(
    config,
    "10000000-0000-4000-8000-000000000001",
    () => `00000000-0000-4000-8000-${String(++taskId).padStart(12, "0")}`,
    () => 100 + taskId,
  );
  const append = (event: TaskEvent): string => {
    manager.appendCustomEntry("pi-task-framework/task-event", taskEventEnvelope(event));
    return manager.getLeafId()!;
  };
  let outputId = 0;
  const preservation = new PreservationService(
    runtime,
    () => `10000000-0000-4000-8000-${String(++outputId).padStart(12, "0")}`,
  );
  const appendMessage = (message: AssistantMessage | ToolResultMessage): string => {
    manager.appendMessage(message);
    return manager.getLeafId()!;
  };
  const begin = (task = "root") => {
    appendMessage(assistant([{ id: "begin", name: "begin_task", arguments: { task } }]));
    return runtime.begin(
      task,
      {
        sessionId: manager.getSessionId(),
        assistantEntryId: manager.getLeafId(),
        toolCallId: "begin",
      },
      append,
    );
  };
  return { manager, runtime, preservation, append, appendMessage, begin };
}

describe("shared transcript protocol resolver", () => {
  it("pairs calls/results once and computes an original full-batch closure", () => {
    const manager = SessionManager.inMemory("/tmp/task-framework-protocol-test");
    manager.appendMessage(assistant([
      { id: "call-a", name: "read" },
      { id: "call-b", name: "bash" },
    ]));
    const assistantEntryId = manager.getLeafId()!;
    manager.appendMessage(result("call-a", "read", "A"));
    const resultAEntryId = manager.getLeafId()!;
    manager.appendMessage(result("call-b", "bash", "B"));
    const resultBEntryId = manager.getLeafId()!;

    const resolver = new SessionProtocolResolver(manager.getSessionId(), manager.getBranch());
    expect(resolver.resolveProtocolUnit("call-b")).toMatchObject({
      assistantEntryId,
      resultEntryId: resultBEntryId,
      toolName: "bash",
    });
    expect(resolver.computeMinimalProtocolClosure("call-b").map((entry) => entry.entryId)).toEqual([
      assistantEntryId,
      resultAEntryId,
      resultBEntryId,
    ]);

    const range: TranscriptRange = {
      start: { sessionId: manager.getSessionId(), entryId: assistantEntryId, boundary: "before" },
      end: { sessionId: manager.getSessionId(), entryId: resultBEntryId, boundary: "after" },
    };
    expect(resolver.validateProtocolRange(range)).toEqual({ valid: true, reasons: [] });
    expect(resolver.extractProtocolUnits(range).map((unit) => unit.toolCallId)).toEqual([
      "call-a",
      "call-b",
    ]);
  });

  it("resolves task tool anchors around complete persisted begin/end protocol units", () => {
    const { manager, runtime, append, appendMessage, begin } = preservationHarness();
    const task = begin("anchored");
    const beginResultEntryId = appendMessage(result("begin", "begin_task", "opened"));
    appendMessage(assistant([{ id: "ordinary", name: "read" }]));
    appendMessage(result("ordinary", "read", "body"));
    const endAssistantEntryId = appendMessage(assistant([{ id: "end", name: "end_task" }]));
    runtime.end(
      task.task_id,
      summary,
      true,
      {
        sessionId: manager.getSessionId(),
        assistantEntryId: endAssistantEntryId,
        toolCallId: "end",
      },
      append,
    );
    const endResultEntryId = appendMessage(result("end", "end_task", "closed"));

    const pi = {
      appendEntry(customType: string, data: unknown) {
        manager.appendCustomEntry(customType, data);
      },
    };
    expect(
      resolveAndPersistTaskAnchors(
        runtime.snapshot,
        pi,
        { sessionManager: manager } as unknown as ExtensionContext,
      ),
    ).toBe(2);
    expect(runtime.snapshot.tasks.get(task.task_id)?.transcript).toMatchObject({
      beginAnchor: { tool: { resultEntryId: beginResultEntryId } },
      endAnchor: { tool: { resultEntryId: endResultEntryId } },
    });
    const reconstructed = new LocalTaskRuntime(config);
    reconstructed.reconstructFrom(new PiTaskEventStore(pi), manager);
    expect(reconstructed.snapshot.tasks.get(task.task_id)?.transcript).toMatchObject({
      beginAnchor: { tool: { resultEntryId: beginResultEntryId } },
      endAnchor: { tool: { resultEntryId: endResultEntryId } },
    });

    const transcript = new SessionTranscriptResolver(
      manager.getSessionId(),
      manager.getBranch(),
      (taskId) => runtime.snapshot.tasks.get(taskId),
    );
    const range = transcript.resolveTaskTranscript(task.task_id);
    const entries = transcript.resolveEntries(range);
    expect(entries[0]).toMatchObject({ type: "message", message: { role: "assistant" } });
    expect(entries.at(-1)).toMatchObject({ id: endResultEntryId });
    expect(
      new SessionProtocolResolver(manager.getSessionId(), manager.getBranch()).validateProtocolRange(range),
    ).toEqual({ valid: true, reasons: [] });
  });

  it("rejects ambiguous, mismatched, and incomplete protocol ranges", () => {
    const manager = SessionManager.inMemory("/tmp/task-framework-invalid-protocol-test");
    manager.appendMessage(assistant([{ id: "call-a", name: "read" }]));
    const assistantEntryId = manager.getLeafId()!;
    manager.appendMessage(result("call-a", "bash", "wrong tool"));
    const resultEntryId = manager.getLeafId()!;
    const resolver = new SessionProtocolResolver(manager.getSessionId(), manager.getBranch());
    expect(() => resolver.resolveProtocolUnit("call-a")).toThrow("tool name mismatch");
    expect(
      resolver.validateProtocolRange({
        start: { sessionId: manager.getSessionId(), entryId: assistantEntryId, boundary: "before" },
        end: { sessionId: manager.getSessionId(), entryId: resultEntryId, boundary: "after" },
      }),
    ).toMatchObject({ valid: false });
  });
});

describe("preservation and immutable pinning", () => {
  it("preserves arbitrary ordinary output, retains sibling closure, and re-emits exact content", () => {
    const { manager, runtime, preservation, append, appendMessage, begin } = preservationHarness();
    const task = begin();
    const assistantEntryId = appendMessage(assistant([
      { id: "call-a", name: "read" },
      { id: "call-b", name: "bash" },
    ]));
    const resultAEntryId = appendMessage(result("call-a", "read", "first"));
    const resultBEntryId = appendMessage(
      result("call-b", "bash", "second", {
        content: [
          { type: "text", text: "second" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      }),
    );
    const markerEntryId = appendMessage(assistant([{ id: "preserve", name: "preserve_output" }]));

    const preserved = preservation.preserve(
      { tool_call_id: "call-b", pin: true },
      "preserve",
      manager,
      append,
    );
    expect(preserved).toMatchObject({
      task_id: task.task_id,
      tool_call_id: "call-b",
      pin: true,
      closure_entry_count: 3,
      already_preserved: false,
    });
    const output = runtime.snapshot.outputs.get(preserved.output_id)!;
    expect(output.source.closure?.map((entry) => entry.entryId)).toEqual([
      assistantEntryId,
      resultAEntryId,
      resultBEntryId,
    ]);
    expect(preservation.read(preserved.output_id, manager).content).toEqual([
      { type: "text", text: "second" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ]);
    expect(runtime.list()[0]).toMatchObject({ preservedOutputCount: 1, pinnedOutputCount: 1 });

    const reconstructed = new LocalTaskRuntime(config);
    reconstructed.reconstruct(readTaskEventLog(manager.getBranch()));
    expect(reconstructed.snapshot.outputs.get(preserved.output_id)).toEqual(output);
    expect(reconstructed.list()[0]).toMatchObject({ preservedOutputCount: 1, pinnedOutputCount: 1 });

    manager.branch(markerEntryId);
    const alternate = new LocalTaskRuntime(config);
    alternate.reconstructFrom(new PiTaskEventStore({ appendEntry() {} }), manager);
    expect(alternate.snapshot.outputs.size).toBe(0);
    expect(alternate.list()[0]).toMatchObject({ preservedOutputCount: 0, pinnedOutputCount: 0 });
  });

  it("reloads preserved records and exact source content from a real Pi session file", () => {
    const root = mkdtempSync(join(tmpdir(), "task-framework-preservation-reload-"));
    try {
      const sessionPath = join(root, "session.jsonl");
      writeFileSync(sessionPath, "");
      const manager = SessionManager.open(sessionPath);
      const { runtime, preservation, append, appendMessage, begin } = preservationHarness(manager);
      begin("durable");
      appendMessage(assistant([{ id: "source", name: "read" }]));
      appendMessage(result("source", "read", "durable exact content"));
      appendMessage(assistant([{ id: "marker", name: "preserve_output" }]));
      const record = preservation.preserve(
        { tool_call_id: "source", pin: true },
        "marker",
        manager,
        append,
      );
      expect(runtime.snapshot.outputs.has(record.output_id)).toBe(true);

      const reopened = SessionManager.open(sessionPath);
      const reconstructed = new LocalTaskRuntime(config);
      reconstructed.reconstructFrom(
        new PiTaskEventStore({ appendEntry() {} }),
        reopened,
      );
      const reloadedService = new PreservationService(reconstructed);
      expect(reloadedService.read(record.output_id, reopened).content).toEqual([
        { type: "text", text: "durable exact content" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent for the same pin and rejects pin mutation", () => {
    const { manager, runtime, preservation, append, appendMessage, begin } = preservationHarness();
    begin();
    appendMessage(assistant([{ id: "source", name: "read" }]));
    appendMessage(result("source", "read", "value"));
    appendMessage(assistant([{ id: "preserve-1", name: "preserve_output" }]));
    const first = preservation.preserve({ tool_call_id: "source" }, "preserve-1", manager, append);
    appendMessage(assistant([{ id: "preserve-2", name: "preserve_output" }]));
    const second = preservation.preserve({ tool_call_id: "source" }, "preserve-2", manager, append);
    expect(second).toMatchObject({ output_id: first.output_id, already_preserved: true });
    expect(runtime.snapshot.outputs.size).toBe(1);

    appendMessage(assistant([{ id: "preserve-3", name: "preserve_output" }]));
    expect(() =>
      preservation.preserve(
        { tool_call_id: "source", pin: true },
        "preserve-3",
        manager,
        append,
      ),
    ).toThrow("immutable pin=false");
  });

  it("atomically validates delayed end-task selectors and persists them before completion", () => {
    const { manager, runtime, preservation, append, appendMessage, begin } = preservationHarness();
    const task = begin();
    appendMessage(assistant([{ id: "source", name: "read" }]));
    appendMessage(result("source", "read", "value"));
    const endAssistantEntryId = appendMessage(assistant([{ id: "end", name: "end_task" }]));

    expect(() =>
      preservation.preserveForEnd(
        task.task_id,
        [
          { tool_call_id: "source", pin: false },
          { tool_call_id: "source", pin: true },
        ],
        "end",
        manager,
        append,
      ),
    ).toThrow("changes immutable pin state");
    expect(runtime.snapshot.outputs.size).toBe(0);

    const outputs = preservation.preserveForEnd(
      task.task_id,
      [{ tool_call_id: "source", pin: true }],
      "end",
      manager,
      append,
    );
    runtime.end(
      task.task_id,
      summary,
      true,
      { sessionId: manager.getSessionId(), assistantEntryId: endAssistantEntryId, toolCallId: "end" },
      append,
    );
    expect(outputs).toHaveLength(1);
    expect(runtime.snapshot.tasks.get(task.task_id)?.status).toBe("completed");
    expect(runtime.snapshot.tasks.get(task.task_id)?.preservedOutputs).toEqual([
      outputs[0]!.output_id,
    ]);
  });

  it("rejects control tools, sources outside the active task, and changed persisted content", () => {
    const { manager, runtime, preservation, append, appendMessage, begin } = preservationHarness();
    appendMessage(assistant([{ id: "outside", name: "read" }]));
    appendMessage(result("outside", "read", "outside"));
    begin();
    appendMessage(assistant([{ id: "control", name: "list_tasks" }]));
    appendMessage(result("control", "list_tasks", "metadata"));
    appendMessage(assistant([{ id: "marker", name: "preserve_output" }]));
    expect(() => preservation.preserve({ tool_call_id: "outside" }, "marker", manager, append)).toThrow(
      "outside active task",
    );
    expect(() => preservation.preserve({ tool_call_id: "control" }, "marker", manager, append)).toThrow(
      "control tool",
    );

    // A forged durable record cannot bypass read-time call/result hash checks.
    runtime.preserve(
      {
        id: "forged",
        taskId: runtime.activeTask()!.id,
        source: {
          sessionId: manager.getSessionId(),
          toolCallId: "outside",
          toolName: "read",
          assistantEntryId: "wrong",
          resultEntryId: "wrong",
          callHash: "wrong",
          resultHash: "wrong",
        },
        pin: false,
      },
      append,
    );
    expect(() => preservation.read("forged", manager)).toThrow("provenance validation");
  });
});
