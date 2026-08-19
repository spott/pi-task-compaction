import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  DefaultTaskAwareGlobalCompactor,
  type GlobalSummaryRequest,
} from "../src/compaction/global.js";
import type { Config } from "../src/config.js";
import { TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope, type TaskEvent } from "../src/model/events.js";
import type { TaskSummary } from "../src/model/summary.js";
import { LocalProjectionPlanner } from "../src/projection/planner.js";
import { TASK_SUMMARY_CUSTOM_TYPE } from "../src/projection/render.js";
import { InteractionService } from "../src/store/interactions.js";
import { PreservationService } from "../src/store/preservation.js";
import { LocalTaskRuntime } from "../src/store/task-runtime.js";

const config: Config = {
  features: { tasks: true, summaries: true, compaction: true, agents: false },
  limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
};

const summary: TaskSummary = {
  objective: "compact safely",
  outcome: "task completed",
  attempted: ["projected the task"],
  learnings: ["one durable learning"],
  decisions: [],
  files_read: ["important.txt"],
  files_modified: [],
  verification: ["checked"],
  open_threads: [],
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }> = [],
  text?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? {},
      })),
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage,
    stopReason: calls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function retryError(text: string): AssistantMessage {
  return {
    ...assistant([], text),
    stopReason: "error",
    errorMessage: "transient provider error",
  };
}

function result(id: string, name: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function fixture() {
  const manager = SessionManager.inMemory("/tmp/task-framework-global-compaction-test");
  const runtime = new LocalTaskRuntime(config);
  const append = (event: TaskEvent): string => {
    manager.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope(event));
    return manager.getLeafId()!;
  };
  const appendMessage = (message: AgentMessage): string => {
    manager.appendMessage(message as any);
    return manager.getLeafId()!;
  };
  const interactions = new InteractionService(runtime);
  const preservation = new PreservationService(runtime);
  let call = 0;
  const begin = (task: string) => {
    const toolCallId = `begin-${++call}`;
    const assistantEntryId = appendMessage(
      assistant([{ id: toolCallId, name: "begin_task", arguments: { task } }]),
    );
    const opened = runtime.begin(
      task,
      { sessionId: manager.getSessionId(), assistantEntryId, toolCallId },
      append,
    );
    appendMessage(result(toolCallId, "begin_task", "opened"));
    return { ...opened, assistantEntryId };
  };
  const end = (taskId: string) => {
    const toolCallId = `end-${++call}`;
    const assistantEntryId = appendMessage(
      assistant([{ id: toolCallId, name: "end_task", arguments: { task_id: taskId } }]),
    );
    runtime.end(
      taskId,
      summary,
      true,
      { sessionId: manager.getSessionId(), assistantEntryId, toolCallId },
      append,
      interactions.pendingBeforeMarker(taskId, toolCallId, manager).length,
    );
    const resultEntryId = appendMessage(result(toolCallId, "end_task", "closed"));
    return { assistantEntryId, resultEntryId };
  };
  return { manager, runtime, append, appendMessage, interactions, preservation, begin, end };
}

function extensionContext(manager: SessionManager): ExtensionContext {
  return {
    sessionManager: manager,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

function event(
  manager: SessionManager,
  firstKeptEntryId: string,
  reason: SessionBeforeCompactEvent["reason"] = "manual",
  previousSummary?: string,
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 42_000,
      ...(previousSummary ? { previousSummary } : {}),
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: manager.getBranch(),
    reason,
    willRetry: reason === "overflow",
    signal: new AbortController().signal,
  };
}

function capturingCompactor(captured: GlobalSummaryRequest[]) {
  return new DefaultTaskAwareGlobalCompactor(async (request) => {
    captured.push(request);
    return { summary: "## Goal\ncontinue safely" };
  });
}

describe("M11 task-aware global compaction", () => {
  it.each(["manual", "threshold", "overflow"] as const)(
    "projects a completed task and moves a %s cut after its complete region",
    async (reason) => {
      const f = fixture();
      f.appendMessage(user("PRELUDE"));
      const task = f.begin("completed region");

      f.appendMessage(assistant([{ id: "source", name: "read", arguments: { path: "important.txt" } }]));
      f.appendMessage(result("source", "read", "PINNED CONTENT"));
      f.appendMessage(assistant([{ id: "preserve", name: "preserve_output" }]));
      f.preservation.preserve(
        { tool_call_id: "source", pin: true },
        "preserve",
        f.manager,
        f.append,
      );
      f.appendMessage(result("preserve", "preserve_output", "preserved"));

      f.appendMessage(user("PROTECTED QUESTION"));
      f.appendMessage(assistant([{ id: "respond", name: "respond_to_user" }], "PROTECTED ANSWER"));
      f.interactions.protect("respond", f.manager, f.append);
      f.appendMessage(result("respond", "respond_to_user", "protected"));
      f.appendMessage(user("REPLAY ME AFTER THE TASK"));
      const rawBodyId = f.appendMessage(assistant([], "DROP RAW TASK BODY"));
      f.end(task.task_id);
      const recentId = f.appendMessage(user("RECENT REQUEST"));

      const captured: GlobalSummaryRequest[] = [];
      const decision = await capturingCompactor(captured).compact(
        event(f.manager, rawBodyId, reason),
        new LocalProjectionPlanner(),
        { ctx: extensionContext(f.manager), state: f.runtime.snapshot },
      );

      expect(decision.cancel).not.toBe(true);
      expect(decision.compaction?.firstKeptEntryId).toBe(recentId);
      expect(decision.compaction?.details).toMatchObject({
        reason,
        willRetry: reason === "overflow",
        alignment: "after_projected_task",
        projectedTaskIds: [task.task_id],
      });
      expect(captured).toHaveLength(1);
      const serialized = JSON.stringify(captured[0]!.messages);
      expect(serialized).toContain("PINNED CONTENT");
      expect(serialized).toContain("PROTECTED QUESTION");
      expect(serialized).toContain("PROTECTED ANSWER");
      expect(serialized).toContain(TASK_SUMMARY_CUSTOM_TYPE);
      expect(serialized.match(/REPLAY ME AFTER THE TASK/gu)).toHaveLength(1);
      expect(serialized.indexOf("REPLAY ME AFTER THE TASK")).toBeGreaterThan(
        serialized.indexOf(TASK_SUMMARY_CUSTOM_TYPE),
      );
      expect(serialized).not.toContain("DROP RAW TASK BODY");
      expect(serialized).not.toContain("RECENT REQUEST");
    },
  );

  it("aligns a cut inside a nested child after the completed ancestor subtree", async () => {
    const f = fixture();
    f.appendMessage(user("NESTED PREFIX"));
    const parent = f.begin("completed parent");
    const child = f.begin("completed child");
    const childBodyId = f.appendMessage(assistant([], "NESTED CHILD RAW BODY"));
    f.end(child.task_id);
    f.appendMessage(assistant([], "PARENT RAW TAIL"));
    f.end(parent.task_id);
    const recentId = f.appendMessage(user("NESTED RECENT"));

    const captured: GlobalSummaryRequest[] = [];
    const decision = await capturingCompactor(captured).compact(
      event(f.manager, childBodyId),
      new LocalProjectionPlanner(),
      { ctx: extensionContext(f.manager), state: f.runtime.snapshot },
    );

    expect(decision.compaction?.firstKeptEntryId).toBe(recentId);
    expect(new Set(decision.compaction?.details?.projectedTaskIds)).toEqual(
      new Set([parent.task_id, child.task_id]),
    );
    const summaryMessages = captured[0]!.messages.filter(
      (message) => message.role === "custom" && message.customType === TASK_SUMMARY_CUSTOM_TYPE,
    );
    expect(summaryMessages).toHaveLength(1);
    expect(JSON.stringify(summaryMessages)).toContain(parent.task_id);
    expect(JSON.stringify(summaryMessages)).toContain(child.task_id);
    expect(JSON.stringify(captured[0]!.messages)).not.toContain("NESTED CHILD RAW BODY");
  });

  it("projects an assigned worker root whose semantic parent lives in another session", async () => {
    const f = fixture();
    const taskId = "00000000-0000-4000-8000-000000000801";
    const parentTaskId = "00000000-0000-4000-8000-000000000700";
    f.append({
      type: "task_created",
      at: Date.now(),
      taskId,
      task: "worker-derived descendant",
      parentTaskId,
      localDepth: 0,
      execution: {
        kind: "worker",
        workerId: "worker-m11",
        processId: "worker-m11",
        sessionId: f.manager.getSessionId(),
        agentDepth: 2,
      },
      transcript: {
        sessionId: f.manager.getSessionId(),
        beginAnchor: {
          sessionId: f.manager.getSessionId(),
          entryId: null,
          boundary: "before",
        },
      },
    });
    f.runtime.reconstructEntries(f.manager.getBranch());
    f.runtime.adoptAssignedRoot(taskId, f.append);
    const bodyId = f.appendMessage(assistant([], "WORKER RAW BODY"));
    f.end(taskId);
    const recentId = f.appendMessage(user("WORKER RECENT"));

    const captured: GlobalSummaryRequest[] = [];
    const decision = await capturingCompactor(captured).compact(
      event(f.manager, bodyId),
      new LocalProjectionPlanner(),
      { ctx: extensionContext(f.manager), state: f.runtime.snapshot },
    );

    expect(decision.compaction?.firstKeptEntryId).toBe(recentId);
    expect(decision.compaction?.details).toMatchObject({
      alignment: "after_projected_task",
      projectedTaskIds: [taskId],
    });
    expect(JSON.stringify(captured[0]!.messages)).toContain("worker-derived descendant");
    expect(JSON.stringify(captured[0]!.messages)).not.toContain("WORKER RAW BODY");
  });

  it("moves a cut before an open task instead of summarizing any part of it", async () => {
    const f = fixture();
    f.appendMessage(user("SAFE PREFIX"));
    const task = f.begin("still open");
    const bodyId = f.appendMessage(assistant([], "OPEN TASK BODY"));
    f.appendMessage(user("OPEN TASK INTERRUPTION"));

    const captured: GlobalSummaryRequest[] = [];
    const decision = await capturingCompactor(captured).compact(
      event(f.manager, bodyId),
      new LocalProjectionPlanner(),
      { ctx: extensionContext(f.manager), state: f.runtime.snapshot },
    );

    expect(decision.compaction?.firstKeptEntryId).toBe(task.assistantEntryId);
    expect(decision.compaction?.details).toMatchObject({
      alignment: "before_unresolved_task",
      projectedTaskIds: [],
    });
    expect(JSON.stringify(captured[0]!.messages)).toContain("SAFE PREFIX");
    expect(JSON.stringify(captured[0]!.messages)).not.toContain("OPEN TASK BODY");
  });

  it("cancels rather than cutting an open task that already crosses a prior Pi boundary", async () => {
    const f = fixture();
    const task = f.begin("cross-boundary open task");
    const priorKeptId = f.appendMessage(assistant([], "KEPT OPEN PREFIX"));
    f.manager.appendCompaction("prior checkpoint", priorKeptId, 30_000, undefined, true);
    const requestedId = f.appendMessage(assistant([], "LATER OPEN BODY"));

    const captured: GlobalSummaryRequest[] = [];
    const decision = await capturingCompactor(captured).compact(
      event(f.manager, requestedId, "overflow", "prior checkpoint"),
      new LocalProjectionPlanner(),
      { ctx: extensionContext(f.manager), state: f.runtime.snapshot },
    );

    expect(f.runtime.snapshot.tasks.get(task.task_id)?.status).toBe("open");
    expect(decision).toMatchObject({
      cancel: true,
      diagnostics: {
        alignment: "before_unresolved_task",
        cancelledReason: expect.stringContaining("No safe global-compaction boundary"),
      },
    });
    expect(captured).toHaveLength(0);
  });

  it("uses the active Pi model registry for a provider-free custom compaction result", async () => {
    const f = fixture();
    f.appendMessage(user("SUMMARIZE THIS"));
    const recentId = f.appendMessage(user("KEEP THIS"));
    const completions: Array<{ context: any; options: any }> = [];
    const ctx = {
      sessionManager: f.manager,
      model: { id: "fixture", maxTokens: 4_096, reasoning: false },
      modelRegistry: {
        async complete(_model: unknown, context: unknown, options: unknown) {
          completions.push({ context, options });
          return assistant([], "## Goal\nprovider-free fixture summary");
        },
      },
      ui: { notify() {} },
    } as unknown as ExtensionContext;

    const decision = await new DefaultTaskAwareGlobalCompactor().compact(
      event(f.manager, recentId),
      new LocalProjectionPlanner(),
      { ctx, state: f.runtime.snapshot },
    );

    expect(decision.compaction).toMatchObject({
      summary: "## Goal\nprovider-free fixture summary",
      firstKeptEntryId: recentId,
      usage,
    });
    expect(completions).toHaveLength(1);
    expect(completions[0]!.options).toMatchObject({
      maxTokens: 4_096,
      cacheRetention: "none",
    });
    const prompt = JSON.stringify(completions[0]!.context);
    expect(prompt).toContain("SUMMARIZE THIS");
    expect(prompt).toContain("already passed through the task projection planner");
    expect(prompt).not.toContain("KEEP THIS");
  });

  it("keeps a persisted assistant error when global-compaction inputs match exactly", async () => {
    const f = fixture();
    f.appendMessage(user("EXACT PREFIX"));
    f.appendMessage(retryError("PERSISTENT ERROR FOR GLOBAL SUMMARY"));
    const recentId = f.appendMessage(user("EXACT RECENT"));
    const captured: GlobalSummaryRequest[] = [];
    const plans: ReturnType<LocalProjectionPlanner["plan"]>[] = [];
    const localPlanner = new LocalProjectionPlanner();
    const planner = {
      plan(input: Parameters<LocalProjectionPlanner["plan"]>[0]) {
        const plan = localPlanner.plan(input);
        plans.push(plan);
        return plan;
      },
    };

    const decision = await capturingCompactor(captured).compact(
      event(f.manager, recentId),
      planner,
      { ctx: extensionContext(f.manager), state: f.runtime.snapshot },
    );

    expect(decision.compaction).toMatchObject({
      firstKeptEntryId: recentId,
      details: { alignment: "unchanged", projectedTaskIds: [] },
    });
    expect(plans).toHaveLength(2);
    expect(plans.every((plan) =>
      plan.metrics.contextAlignment === "exact" &&
      plan.metrics.omittedRetryErrorEntryCount === 0
    )).toBe(true);
    expect(JSON.stringify(captured[0]?.messages)).toContain("PERSISTENT ERROR FOR GLOBAL SUMMARY");
  });

  it("passes the previous global summary and custom instructions to projected summarization", async () => {
    const f = fixture();
    const firstKeptId = f.appendMessage(user("NEW MATERIAL"));
    f.manager.appendCompaction("OLD SUMMARY", firstKeptId, 20_000, undefined, true);
    f.appendMessage(assistant([], "MORE MATERIAL"));
    const recentId = f.appendMessage(user("KEEP THIS"));
    const compactEvent = event(f.manager, recentId, "manual", "OLD SUMMARY");
    compactEvent.customInstructions = "focus on exact IDs";

    const captured: GlobalSummaryRequest[] = [];
    const decision = await capturingCompactor(captured).compact(
      compactEvent,
      new LocalProjectionPlanner(),
      { ctx: extensionContext(f.manager), state: f.runtime.snapshot },
    );

    expect(decision.compaction?.firstKeptEntryId).toBe(recentId);
    expect(captured[0]).toMatchObject({
      previousSummary: "OLD SUMMARY",
      customInstructions: "focus on exact IDs",
    });
    expect(JSON.stringify(captured[0]!.messages)).toContain("NEW MATERIAL");
    expect(JSON.stringify(captured[0]!.messages)).toContain("MORE MATERIAL");
    expect(JSON.stringify(captured[0]!.messages)).not.toContain("OLD SUMMARY");
  });
});
