import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope, type TaskEvent } from "../src/model/events.js";
import type { TaskSummary } from "../src/model/summary.js";
import { LocalProjectionPlanner } from "../src/projection/planner.js";
import { TASK_SUMMARY_CUSTOM_TYPE } from "../src/projection/render.js";
import { InteractionService } from "../src/store/interactions.js";
import { PreservationService } from "../src/store/preservation.js";
import { PiTaskEventStore } from "../src/store/task-events.js";
import { LocalTaskRuntime } from "../src/store/task-runtime.js";

const config: Config = {
  features: { tasks: true, summaries: true, compaction: true, agents: false },
  limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
};

const summary: TaskSummary = {
  objective: "project the task",
  outcome: "projection complete",
  attempted: ["worked"],
  learnings: ["learned"],
  decisions: [],
  files_read: [],
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

function retryError(
  text = "transient provider failure",
  calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }> = [],
): AssistantMessage {
  return {
    ...assistant(calls, text),
    stopReason: "error",
    errorMessage: "WebSocket error",
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

function persistedMessage(manager: SessionManager, entryId: string): AgentMessage {
  const entry = manager.getEntry(entryId);
  if (entry?.type !== "message") throw new Error(`Expected message entry ${entryId}`);
  return entry.message;
}

function harness() {
  const manager = SessionManager.inMemory("/tmp/task-framework-projection-test");
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
    return opened;
  };
  const end = (taskId: string, taskSummary = summary) => {
    const toolCallId = `end-${++call}`;
    const assistantEntryId = appendMessage(
      assistant([{ id: toolCallId, name: "end_task", arguments: { task_id: taskId } }]),
    );
    const unanswered = interactions.pendingBeforeMarker(taskId, toolCallId, manager).length;
    const closed = runtime.end(
      taskId,
      taskSummary,
      true,
      { sessionId: manager.getSessionId(), assistantEntryId, toolCallId },
      append,
      unanswered,
    );
    appendMessage(result(toolCallId, "end_task", "closed"));
    return closed;
  };
  const protect = (text: string) => {
    const toolCallId = `respond-${++call}`;
    appendMessage(assistant([{ id: toolCallId, name: "respond_to_user" }], text));
    const protectedResult = interactions.protect(toolCallId, manager, append);
    appendMessage(result(toolCallId, "respond_to_user", "protected"));
    return protectedResult;
  };
  const projectMessages = (
    messages: AgentMessage[],
    selectedRuntime = runtime,
    contextEntries = manager.buildContextEntries(),
    branchEntries = manager.getBranch(),
  ) => new LocalProjectionPlanner().plan({
    messages,
    sessionId: manager.getSessionId(),
    branchEntries,
    contextEntries,
    state: selectedRuntime.snapshot,
  });
  const project = (selectedRuntime = runtime) =>
    projectMessages(manager.buildSessionContext().messages, selectedRuntime);
  return {
    manager,
    runtime,
    interactions,
    preservation,
    append,
    appendMessage,
    begin,
    end,
    protect,
    project,
    projectMessages,
  };
}

function summaryMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (message) => message.role === "custom" && message.customType === TASK_SUMMARY_CUSTOM_TYPE,
  );
}

function userTexts(messages: readonly AgentMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "user" && typeof message.content === "string" ? [message.content] : [],
  );
}

describe("M5 interaction ownership and replay", () => {
  it("replays an unanswered user message once after a completed task summary", () => {
    const { appendMessage, begin, end, project } = harness();
    const task = begin("root");
    appendMessage(user("What did you find?"));
    appendMessage(assistant([], "still working"));
    const closed = end(task.task_id);
    expect(closed.unanswered_message_count).toBe(1);

    const projected = project();
    expect(projected.rejections).toEqual([]);
    expect(summaryMessages(projected.messages)).toHaveLength(1);
    expect(userTexts(projected.messages)).toEqual(["What did you find?"]);
    expect(projected.messages.at(-1)).toMatchObject({ role: "user", content: "What did you find?" });
    expect(projected.metrics).toMatchObject({
      replayedMessageCount: 1,
      maxReplayCascadeDepth: 1,
      protectedInteractionCount: 0,
    });
    expect(projected.metrics.inputEstimatedTokens).toBeGreaterThan(0);
    expect(projected.metrics.outputEstimatedTokens).toBeGreaterThan(0);
  });

  it("protects one pending message with an isolated marked response and emits no replay", () => {
    const { manager, appendMessage, begin, protect, end, project, runtime } = harness();
    const task = begin("interactive");
    appendMessage(user("One question"));
    const protectedResult = protect("Here is the durable answer.");
    expect(protectedResult.protected_user_message_count).toBe(1);
    expect(runtime.snapshot.interactions.size).toBe(1);
    expect(end(task.task_id).unanswered_message_count).toBe(0);

    const reconstructed = new LocalTaskRuntime(config);
    reconstructed.reconstructFrom(
      new PiTaskEventStore({ appendEntry() {} } as any),
      manager,
    );
    expect(reconstructed.snapshot.interactions.size).toBe(1);

    const projected = project(reconstructed);
    expect(projected.rejections).toEqual([]);
    expect(userTexts(projected.messages)).toEqual(["One question"]);
    const response = projected.messages.find(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "toolCall" && block.name === "respond_to_user"),
    );
    expect(response).toBeDefined();
    expect(JSON.stringify(response)).toContain("Here is the durable answer.");
    expect(projected.messages.at(-1)).toMatchObject({ role: "custom" });
    expect(projected.metrics).toMatchObject({
      replayedMessageCount: 0,
      maxReplayCascadeDepth: 0,
      protectedInteractionCount: 1,
    });
  });

  it("rejects multiple-message response binding because API v2 leaves it unsettled", () => {
    const { appendMessage, begin, protect } = harness();
    begin("ambiguous binding");
    appendMessage(user("First question"));
    appendMessage(user("Second question"));
    expect(() => protect("Ambiguous combined answer")).toThrow("binding unsettled");
  });

  it("replays multiple unanswered messages in their original order", () => {
    const { appendMessage, begin, end, project } = harness();
    const task = begin("ordered replay");
    appendMessage(user("First unanswered"));
    appendMessage(assistant([], "intermediate work"));
    appendMessage(user("Second unanswered"));
    expect(end(task.task_id).unanswered_message_count).toBe(2);
    const projected = project();
    expect(userTexts(projected.messages)).toEqual(["First unanswered", "Second unanswered"]);
    expect(projected.messages.slice(-2)).toMatchObject([
      { role: "user", content: "First unanswered" },
      { role: "user", content: "Second unanswered" },
    ]);
  });

  it("cascades an unanswered child message through child and parent closure", () => {
    const { appendMessage, begin, end, project } = harness();
    const parent = begin("parent");
    const child = begin("child");
    appendMessage(user("Carry me outward"));
    expect(end(child.task_id).unanswered_message_count).toBe(1);

    const childProjected = project();
    expect(summaryMessages(childProjected.messages)).toHaveLength(1);
    expect(userTexts(childProjected.messages)).toEqual(["Carry me outward"]);
    expect(end(parent.task_id).unanswered_message_count).toBe(1);

    const parentProjected = project();
    expect(parentProjected.rejections).toEqual([]);
    expect(summaryMessages(parentProjected.messages)).toHaveLength(1);
    expect(JSON.stringify(summaryMessages(parentProjected.messages))).toContain(`${child.task_id} — child`);
    expect(userTexts(parentProjected.messages)).toEqual(["Carry me outward"]);
    expect(parentProjected.messages.at(-1)).toMatchObject({ role: "user", content: "Carry me outward" });
    expect(parentProjected.metrics).toMatchObject({
      replayedMessageCount: 1,
      maxReplayCascadeDepth: 2,
    });
  });

  it("lets a restored parent protect a child replay without duplicating the raw user entry", () => {
    const { appendMessage, begin, end, protect, project } = harness();
    const parent = begin("parent");
    const child = begin("child");
    appendMessage(user("Answer after child"));
    end(child.task_id);
    const protectedResult = protect("Answered in the restored parent.");
    expect(protectedResult.protected_user_message_count).toBe(1);
    expect(end(parent.task_id).unanswered_message_count).toBe(0);

    const projected = project();
    expect(projected.rejections).toEqual([]);
    expect(userTexts(projected.messages)).toEqual(["Answer after child"]);
    expect(JSON.stringify(projected.messages)).toContain("Answered in the restored parent.");
    expect(projected.messages.at(-1)).toMatchObject({ role: "custom" });
  });

  it("rejects a marker that shares its assistant message with another tool", () => {
    const { manager, appendMessage, append, begin, interactions } = harness();
    begin("invalid response");
    appendMessage(user("question"));
    appendMessage(
      assistant([
        { id: "respond-invalid", name: "respond_to_user" },
        { id: "sibling", name: "read" },
      ]),
    );
    expect(() => interactions.protect("respond-invalid", manager, append)).toThrow(
      "must be the only tool call",
    );
  });
});

describe("M6 local task projection", () => {
  it("retains a full pinned multi-call closure and drops unpinned task history", () => {
    const { manager, runtime, append, appendMessage, begin, end, preservation, project } = harness();
    const task = begin("pinning");
    const sourceAssistant = appendMessage(
      assistant([
        { id: "source-a", name: "read" },
        { id: "source-b", name: "bash" },
      ]),
    );
    const sourceResultA = appendMessage(result("source-a", "read", "A"));
    const sourceResultB = appendMessage(result("source-b", "bash", "B"));
    appendMessage(assistant([{ id: "pin-marker", name: "preserve_output" }]));
    const pinned = preservation.preserve(
      { tool_call_id: "source-b", pin: true },
      "pin-marker",
      manager,
      append,
    );
    appendMessage(result("pin-marker", "preserve_output", "preserved"));
    appendMessage(assistant([], "replaceable tail"));
    end(task.task_id);

    const projected = project();
    expect(projected.rejections).toEqual([]);
    expect(projected.messages.slice(0, 3)).toEqual([
      persistedMessage(manager, sourceAssistant),
      persistedMessage(manager, sourceResultA),
      persistedMessage(manager, sourceResultB),
    ]);
    expect(JSON.stringify(projected.messages)).not.toContain("replaceable tail");
    expect(JSON.stringify(projected.messages)).toContain(pinned.output_id);
    expect(runtime.snapshot.outputs.get(pinned.output_id)?.pin).toBe(true);
    expect(projected.metrics.pinnedClosureEntryCount).toBe(3);
    expect(projected.metrics.pinnedClosureEstimatedTokens).toBeGreaterThan(0);
    expect(projected.metrics.projectedRawMessageCount).toBeGreaterThan(projected.metrics.outputMessageCount);
  });

  it("orders interleaved pin, protected interaction, and pin survivors chronologically", () => {
    const fixture = harness();
    const task = fixture.begin("survivor ordering");

    fixture.appendMessage(assistant([{ id: "first-source", name: "read" }]));
    fixture.appendMessage(result("first-source", "read", "FIRST PIN"));
    fixture.appendMessage(assistant([{ id: "first-marker", name: "preserve_output" }]));
    fixture.preservation.preserve(
      { tool_call_id: "first-source", pin: true },
      "first-marker",
      fixture.manager,
      fixture.append,
    );
    fixture.appendMessage(result("first-marker", "preserve_output", "preserved"));

    fixture.appendMessage(user("PROTECTED QUESTION"));
    fixture.protect("PROTECTED ANSWER");

    fixture.appendMessage(assistant([{ id: "second-source", name: "bash" }]));
    fixture.appendMessage(result("second-source", "bash", "SECOND PIN"));
    fixture.appendMessage(assistant([{ id: "second-marker", name: "preserve_output" }]));
    fixture.preservation.preserve(
      { tool_call_id: "second-source", pin: true },
      "second-marker",
      fixture.manager,
      fixture.append,
    );
    fixture.appendMessage(result("second-marker", "preserve_output", "preserved"));
    fixture.end(task.task_id);

    const serialized = JSON.stringify(fixture.project().messages);
    const ordered = [
      "FIRST PIN",
      "PROTECTED QUESTION",
      "PROTECTED ANSWER",
      "SECOND PIN",
      "<task-summary",
    ].map((text) => serialized.indexOf(text));
    expect(ordered.every((position) => position >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
  });

  it("keeps descendant pins and protected interactions when an ancestor summary subsumes the child", () => {
    const fixture = harness();
    const parent = fixture.begin("ancestor");
    const child = fixture.begin("descendant");
    fixture.appendMessage(assistant([{ id: "child-source", name: "read" }]));
    fixture.appendMessage(result("child-source", "read", "DESCENDANT PIN"));
    fixture.appendMessage(assistant([{ id: "child-pin-marker", name: "preserve_output" }]));
    fixture.preservation.preserve(
      { tool_call_id: "child-source", pin: true },
      "child-pin-marker",
      fixture.manager,
      fixture.append,
    );
    fixture.appendMessage(result("child-pin-marker", "preserve_output", "preserved"));
    fixture.appendMessage(user("DESCENDANT QUESTION"));
    fixture.protect("DESCENDANT ANSWER");
    fixture.end(child.task_id);
    fixture.end(parent.task_id);

    const projected = fixture.project();
    expect(projected.rejections).toEqual([]);
    expect(summaryMessages(projected.messages)).toHaveLength(1);
    expect(JSON.stringify(projected.messages)).toContain("DESCENDANT PIN");
    expect(userTexts(projected.messages)).toEqual(["DESCENDANT QUESTION"]);
    expect(JSON.stringify(projected.messages)).toContain("DESCENDANT ANSWER");
  });

  it("retains an ambiguous root while projecting an unrelated valid sibling", () => {
    const fixture = harness();
    const first = fixture.begin("ambiguous root");
    fixture.appendMessage(assistant([], "must remain raw"));
    fixture.manager.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, {
      schemaVersion: 99,
      event: { type: "future_event", at: Date.now() },
    });
    fixture.end(first.task_id);
    const second = fixture.begin("valid root");
    fixture.appendMessage(assistant([], "replace valid body"));
    fixture.end(second.task_id);

    const reconstructed = new LocalTaskRuntime(config);
    reconstructed.reconstructFrom(
      new PiTaskEventStore({ appendEntry() {} } as any),
      fixture.manager,
    );
    const projected = fixture.project(reconstructed);
    expect(projected.rejections).toEqual([
      expect.objectContaining({ taskId: first.task_id }),
    ]);
    expect(projected.projectedTaskIds).toContain(second.task_id);
    expect(JSON.stringify(projected.messages)).toContain("must remain raw");
    expect(JSON.stringify(projected.messages)).not.toContain("replace valid body");
    expect(summaryMessages(projected.messages)).toHaveLength(1);
  });

  it("suppresses replay when ambiguity retains the original user message", () => {
    const fixture = harness();
    const task = fixture.begin("ambiguous replay");
    fixture.appendMessage(user("VISIBLE ORIGINAL"));
    fixture.manager.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, {
      schemaVersion: 99,
      event: { type: "future_event", at: Date.now() },
    });
    fixture.end(task.task_id);
    const reconstructed = new LocalTaskRuntime(config);
    reconstructed.reconstructFrom(
      new PiTaskEventStore({ appendEntry() {} } as any),
      fixture.manager,
    );
    const projected = fixture.project(reconstructed);
    expect(projected.rejections).toHaveLength(1);
    expect(userTexts(projected.messages)).toEqual(["VISIBLE ORIGINAL"]);
    expect(summaryMessages(projected.messages)).toHaveLength(0);
  });

  it("projects tasks on both sides of an omitted retry error with actual live indexes", () => {
    const fixture = harness();
    const before = fixture.begin("before retry");
    fixture.appendMessage(assistant([], "BEFORE RETRY RAW BODY"));
    fixture.end(before.task_id);
    fixture.appendMessage(retryError("OMITTED TRANSIENT ERROR"));
    fixture.appendMessage(user("VISIBLE BETWEEN TASKS"));
    const after = fixture.begin("after retry");
    fixture.appendMessage(assistant([], "AFTER RETRY RAW BODY"));
    fixture.end(after.task_id);

    const contextEntries = fixture.manager.buildContextEntries();
    const branchEntries = fixture.manager.getBranch();
    const liveMessages = fixture.manager.buildSessionContext().messages.filter(
      (message) => message.role !== "assistant" || message.stopReason !== "error",
    );
    const contextSnapshot = structuredClone(contextEntries);
    const branchSnapshot = structuredClone(branchEntries);
    const liveSnapshot = structuredClone(liveMessages);

    const first = fixture.projectMessages(
      liveMessages,
      fixture.runtime,
      contextEntries,
      branchEntries,
    );
    const second = fixture.projectMessages(liveMessages);

    expect(new Set(first.projectedTaskIds)).toEqual(new Set([before.task_id, after.task_id]));
    expect(first.rejections).toEqual([]);
    expect(first.metrics).toMatchObject({
      contextAlignment: "retry_error_omissions",
      omittedRetryErrorEntryCount: 1,
    });
    expect(summaryMessages(first.messages)).toHaveLength(2);
    expect(userTexts(first.messages)).toEqual(["VISIBLE BETWEEN TASKS"]);
    expect(JSON.stringify(first.messages)).not.toContain("BEFORE RETRY RAW BODY");
    expect(JSON.stringify(first.messages)).not.toContain("AFTER RETRY RAW BODY");
    expect(JSON.stringify(first.messages)).not.toContain("OMITTED TRANSIENT ERROR");
    expect(second.messages).toEqual(first.messages);
    expect(second.projectedTaskIds).toEqual(first.projectedTaskIds);
    expect(contextEntries).toEqual(contextSnapshot);
    expect(branchEntries).toEqual(branchSnapshot);
    expect(liveMessages).toEqual(liveSnapshot);
  });

  it("retains a task spanning an omitted partial-thinking and tool-call error", () => {
    const fixture = harness();
    const task = fixture.begin("spans retry error");
    fixture.appendMessage(assistant([], "VISIBLE RAW PREFIX"));
    const error = retryError("PARTIAL ERROR TEXT", [
      { id: "partial-call", name: "read", arguments: { path: "unfinished" } },
    ]);
    error.content.unshift({ type: "thinking", thinking: "PARTIAL PRIVATE THINKING" });
    fixture.appendMessage(error);
    fixture.appendMessage(assistant([], "VISIBLE RAW SUFFIX"));
    fixture.end(task.task_id);
    const liveMessages = fixture.manager.buildSessionContext().messages.filter(
      (message) => message.role !== "assistant" || message.stopReason !== "error",
    );

    const projected = fixture.projectMessages(liveMessages);

    expect(projected.projectedTaskIds).toEqual([]);
    expect(projected.metrics).toMatchObject({
      contextAlignment: "retry_error_omissions",
      omittedRetryErrorEntryCount: 1,
    });
    expect(projected.rejections[0]).toMatchObject({
      taskId: task.task_id,
      reasons: expect.arrayContaining([
        "task transcript is only partially visible after Pi context construction",
      ]),
    });
    expect(projected.messages).toEqual(liveMessages);
    expect(JSON.stringify(projected.messages)).toContain("VISIBLE RAW PREFIX");
    expect(JSON.stringify(projected.messages)).toContain("VISIBLE RAW SUFFIX");
    expect(JSON.stringify(projected.messages)).not.toContain("PARTIAL ERROR TEXT");
    expect(JSON.stringify(projected.messages)).not.toContain("PARTIAL PRIVATE THINKING");
    expect(JSON.stringify(projected.messages)).not.toContain("partial-call");
  });

  it("does not reconstruct an omitted retry-error entry to satisfy a pinned closure", () => {
    const fixture = harness();
    const task = fixture.begin("retry error pin safety");
    const errorEntryId = fixture.appendMessage(retryError("OMITTED PIN SOURCE", [
      { id: "retry-source", name: "read", arguments: { path: "partial" } },
    ]));
    fixture.appendMessage(result("retry-source", "read", "orphaned result"));
    fixture.appendMessage(assistant([{ id: "pin-retry-source", name: "preserve_output" }]));
    fixture.preservation.preserve(
      { tool_call_id: "retry-source", pin: true },
      "pin-retry-source",
      fixture.manager,
      fixture.append,
    );
    fixture.appendMessage(result("pin-retry-source", "preserve_output", "preserved"));
    fixture.end(task.task_id);
    const liveMessages = fixture.manager.buildSessionContext().messages.filter(
      (message) => message.role !== "assistant" || message.stopReason !== "error",
    );

    const projected = fixture.projectMessages(liveMessages);

    expect(projected.projectedTaskIds).toEqual([]);
    expect(projected.rejections[0]?.reasons).toContain(
      `survivor entry ${errorEntryId} was omitted from live provider context after a retry error`,
    );
    expect(projected.messages).toEqual(liveMessages);
    expect(JSON.stringify(projected.messages)).not.toContain("OMITTED PIN SOURCE");
  });

  it("does not reconstruct an omitted retry-error entry to satisfy a protected interaction", () => {
    const fixture = harness();
    const task = fixture.begin("retry error interaction safety");
    fixture.appendMessage(user("PROTECTED RETRY QUESTION"));
    const errorEntryId = fixture.appendMessage(retryError("OMITTED RETRY ANSWER", [
      { id: "retry-response", name: "respond_to_user" },
    ]));
    fixture.interactions.protect("retry-response", fixture.manager, fixture.append);
    fixture.appendMessage(result("retry-response", "respond_to_user", "protected"));
    fixture.end(task.task_id);
    const liveMessages = fixture.manager.buildSessionContext().messages.filter(
      (message) => message.role !== "assistant" || message.stopReason !== "error",
    );

    const projected = fixture.projectMessages(liveMessages);

    expect(projected.projectedTaskIds).toEqual([]);
    expect(projected.rejections[0]?.reasons).toContain(
      `survivor entry ${errorEntryId} was omitted from live provider context after a retry error`,
    );
    expect(projected.messages).toEqual(liveMessages);
    expect(JSON.stringify(projected.messages)).not.toContain("OMITTED RETRY ANSWER");
  });

  it("retains every candidate when incoming context no longer aligns with Pi entries", () => {
    const fixture = harness();
    const task = fixture.begin("alignment");
    fixture.end(task.task_id);
    const contextEntries = fixture.manager.buildContextEntries();
    const messages = [...fixture.manager.buildSessionContext().messages, user("foreign")];
    const projected = new LocalProjectionPlanner().plan({
      messages,
      sessionId: fixture.manager.getSessionId(),
      branchEntries: fixture.manager.getBranch(),
      contextEntries,
      state: fixture.runtime.snapshot,
    });
    expect(projected.messages).toBe(messages);
    expect(projected.projectedTaskIds).toEqual([]);
    expect(projected.rejections[0]?.reasons[0]).toContain("does not align");
  });
});
