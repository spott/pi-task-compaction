import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/transform.js";
import { assistant, beginMarker, closedTaskMessages, endMarker, toolResult, user } from "./fixtures.js";

const accepted = (messages: Parameters<typeof transformMessages>[0], taskId = "task1") =>
  transformMessages(messages).diagnostics.find((item) => item.taskId === taskId && item.accepted);

const rejection = (messages: Parameters<typeof transformMessages>[0], taskId = "task1") =>
  transformMessages(messages).diagnostics.find((item) => item.taskId === taskId && !item.accepted);

describe("transformMessages", () => {
  it("replaces one complete task with one historical custom summary", () => {
    const input = [user(), ...closedTaskMessages(), user("Continue")];
    const result = transformMessages(input);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]?.role).toBe("custom");
    const summary = (result.messages[1] as { content: string }).content;
    expect(summary).toContain("<task-summary id=\"task1\">");
    expect(summary).toContain("Execution context: repo /tmp/project; branch main; cwd /tmp/project; clean worktree");
    expect(summary).toContain("Do not acknowledge or respond to them directly");
    expect(summary).toContain("Continue the most recent unresolved user request");
    expect(accepted(input)?.rawChars).toBeGreaterThan(8000);
    expect(() => convertToLlm(result.messages)).not.toThrow();
  });

  it("continues to accept summaries created before execution context was added", () => {
    const input = closedTaskMessages();
    const endResult = input[5];
    if (endResult?.role === "toolResult") {
      delete (endResult.details as { executionContext?: string }).executionContext;
    }

    const result = transformMessages(input);
    expect(accepted(input)).toBeTruthy();
    expect((result.messages[0] as { content: string }).content).toContain("Execution context: Not recorded");
  });

  it("compacts two sequential tasks newest-to-oldest without index drift", () => {
    const input = [user(), ...closedTaskMessages("one"), ...closedTaskMessages("two")];
    const result = transformMessages(input);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "custom", "custom"]);
    expect(result.diagnostics.filter((item) => item.accepted)).toHaveLength(2);
  });

  it("retains an open task", () => {
    const begin = beginMarker();
    const input = [assistant([{ id: begin.toolCallId, name: "begin_task" }]), toolResult(begin.toolCallId, "begin_task", begin)];
    expect(transformMessages(input).messages).toEqual(input);
    expect(rejection(input)?.reason).toContain("open");
  });

  it("rejects duplicate and nested-looking begin markers", () => {
    const begin = beginMarker();
    const end = endMarker();
    const input = [
      assistant([{ id: begin.toolCallId, name: "begin_task" }]),
      toolResult(begin.toolCallId, "begin_task", begin),
      assistant([{ id: "begin-duplicate", name: "begin_task" }]),
      toolResult("begin-duplicate", "begin_task", { ...begin, toolCallId: "begin-duplicate" }),
      assistant([{ id: end.endToolCallId, name: "end_task" }]),
      toolResult(end.endToolCallId, "end_task", end),
    ];
    expect(transformMessages(input).messages).toEqual(input);
    expect(rejection(input)?.reason).toContain("duplicate");
  });

  it("rejects a closed outer task containing another task marker", () => {
    const outerBegin = beginMarker("outer");
    const innerBegin = beginMarker("inner");
    const outerEnd = endMarker("outer");
    const input = [
      assistant([{ id: outerBegin.toolCallId, name: "begin_task" }]),
      toolResult(outerBegin.toolCallId, "begin_task", outerBegin),
      assistant([{ id: innerBegin.toolCallId, name: "begin_task" }]),
      toolResult(innerBegin.toolCallId, "begin_task", innerBegin),
      assistant([{ id: outerEnd.endToolCallId, name: "end_task", arguments: { task_id: "outer" } }]),
      toolResult(outerEnd.endToolCallId, "end_task", outerEnd),
    ];
    expect(transformMessages(input).messages).toEqual(input);
    expect(rejection(input, "outer")?.reason).toContain("overlap or nest");
  });

  it("rejects a mismatched end marker", () => {
    const begin = beginMarker("one");
    const end = endMarker("two", begin.toolCallId, "end-two");
    const input = [
      assistant([{ id: begin.toolCallId, name: "begin_task" }]),
      toolResult(begin.toolCallId, "begin_task", begin),
      assistant([{ id: end.endToolCallId, name: "end_task" }]),
      toolResult(end.endToolCallId, "end_task", end),
    ];
    expect(transformMessages(input).messages).toEqual(input);
    expect(rejection(input, "one")?.reason).toContain("open");
    expect(rejection(input, "two")?.reason).toContain("no begin");
  });

  it("rejects boundary result and end-task argument mismatches", () => {
    const wrongArgument = closedTaskMessages();
    const endAssistant = wrongArgument[4];
    if (endAssistant?.role === "assistant") {
      const call = endAssistant.content.find((block) => block.type === "toolCall");
      if (call?.type === "toolCall") call.arguments = { task_id: "wrong" };
    }
    expect(rejection(wrongArgument)?.reason).toContain("mismatched task ID");

    const wrongResult = closedTaskMessages();
    const endResult = wrongResult[5];
    if (endResult?.role === "toolResult") endResult.toolCallId = "wrong-result-id";
    expect(rejection(wrongResult)?.reason).toContain("result does not match");
  });

  it("never removes a user interruption", () => {
    const task = closedTaskMessages();
    const input = [...task.slice(0, 2), user("Steer this"), ...task.slice(2)];
    expect(transformMessages(input).messages).toEqual(input);
    expect(rejection(input)?.reason).toContain("user-like user");
  });

  it("rejects sibling calls on either boundary", () => {
    const begin = beginMarker();
    const end = endMarker();
    const input = [
      assistant([{ id: begin.toolCallId, name: "begin_task" }, { id: "sibling", name: "read" }]),
      toolResult(begin.toolCallId, "begin_task", begin),
      toolResult("sibling", "read"),
      assistant([{ id: end.endToolCallId, name: "end_task" }]),
      toolResult(end.endToolCallId, "end_task", end),
    ];
    expect(transformMessages(input).messages).toEqual(input);
    expect(rejection(input)?.reason).toContain("isolated");
  });

  it("accepts provider/model switches between assistant messages", () => {
    const messages = closedTaskMessages();
    const switched = messages.map((message, index) =>
      message.role === "assistant" && index > 1 ? { ...message, provider: "openai", model: "gpt-test", api: "openai-responses" } : message,
    );
    expect(accepted(switched)).toBeTruthy();
  });

  it("accepts task summaries adjacent to branch/global summaries but rejects them inside", () => {
    const adjacent = [
      { role: "branchSummary", summary: "old branch", fromId: "x", timestamp: 1 } as const,
      ...closedTaskMessages(),
      { role: "compactionSummary", summary: "old context", tokensBefore: 1, timestamp: 2 } as const,
    ];
    expect(accepted(adjacent)).toBeTruthy();

    const task = closedTaskMessages();
    const inside = [...task.slice(0, 2), adjacent[0]!, ...task.slice(2)];
    expect(rejection(inside)?.reason).toContain("branchSummary");
  });

  it("retains corrupted and future-version marker details", () => {
    const begin = beginMarker();
    const corrupted = [
      assistant([{ id: begin.toolCallId, name: "begin_task" }]),
      toolResult(begin.toolCallId, "begin_task", { ...begin, objective: 42 }),
    ];
    expect(transformMessages(corrupted).messages).toEqual(corrupted);

    const future = [
      assistant([{ id: begin.toolCallId, name: "begin_task" }]),
      toolResult(begin.toolCallId, "begin_task", { ...begin, schemaVersion: 2 }),
    ];
    expect(transformMessages(future).messages).toEqual(future);
  });
});
