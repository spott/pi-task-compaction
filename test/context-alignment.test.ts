import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { alignContextMessages } from "../src/projection/context-alignment.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
}

function assistant(
  text: string,
  options: {
    timestamp?: number;
    stopReason?: AssistantMessage["stopReason"];
    toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      ...(options.toolCall
        ? [{
            type: "toolCall" as const,
            id: options.toolCall.id,
            name: options.toolCall.name,
            arguments: options.toolCall.arguments,
          }]
        : []),
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage,
    stopReason: options.stopReason ?? "stop",
    timestamp: options.timestamp ?? 1,
  };
}

function toolResult(text: string, timestamp = 1): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function messageEntry(id: string, message: AgentMessage): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp: String(message.timestamp), message };
}

function customMessageEntry(id: string): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "alignment-test",
    content: "custom content",
    display: false,
  };
}

function branchSummaryEntry(id: string): SessionEntry {
  return {
    type: "branch_summary",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    fromId: "abandoned-entry",
    summary: "branch summary",
  };
}

function compactionEntry(id: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "compaction summary",
    firstKeptEntryId: "kept-entry",
    tokensBefore: 100,
  };
}

function messages(entries: readonly SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}

function retryError(id: string, text = "transient failure", timestamp = 1): SessionEntry {
  return messageEntry(id, assistant(text, { stopReason: "error", timestamp }));
}

describe("retry-aware context alignment", () => {
  it("returns exact records backed by the actual live messages", () => {
    const entries = [
      messageEntry("user", user("question", 1)),
      messageEntry("assistant", assistant("answer", { timestamp: 2 })),
    ];
    const liveMessages = structuredClone(messages(entries));

    const alignment = alignContextMessages(liveMessages, entries);

    expect(alignment).toEqual({
      status: "exact",
      records: [
        { entryId: "user", message: liveMessages[0], messageIndex: 0 },
        { entryId: "assistant", message: liveMessages[1], messageIndex: 1 },
      ],
      omittedRetryErrorEntryIds: [],
    });
    expect(alignment.records[0]?.message).toBe(liveMessages[0]);
    expect(alignment.records[1]?.message).toBe(liveMessages[1]);
  });

  it("reconciles one trailing persisted retry error", () => {
    const visible = messageEntry("visible", user("question"));
    const error = retryError("retry-error");

    expect(alignContextMessages(messages([visible]), [visible, error])).toEqual({
      status: "retry_error_omissions",
      records: [{ entryId: "visible", message: visible.message, messageIndex: 0 }],
      omittedRetryErrorEntryIds: ["retry-error"],
    });
  });

  it("reconciles a mid-sequence retry error and retains actual live indexes", () => {
    const before = messageEntry("before", user("before", 1));
    const error = retryError("retry-error", "failed", 2);
    const after = messageEntry("after", user("after", 3));
    const liveMessages = messages([before, after]);

    const alignment = alignContextMessages(liveMessages, [before, error, after]);

    expect(alignment.status).toBe("retry_error_omissions");
    expect(alignment.records.map(({ entryId, messageIndex }) => ({ entryId, messageIndex }))).toEqual([
      { entryId: "before", messageIndex: 0 },
      { entryId: "after", messageIndex: 1 },
    ]);
    expect(alignment.omittedRetryErrorEntryIds).toEqual(["retry-error"]);
  });

  it("reconciles multiple retry errors in order without shifting live indexes", () => {
    const first = messageEntry("first", user("first", 1));
    const errorOne = retryError("error-one", "one", 2);
    const middle = messageEntry("middle", assistant("middle", { timestamp: 3 }));
    const errorTwo = retryError("error-two", "two", 4);
    const errorThree = retryError("error-three", "three", 5);
    const last = messageEntry("last", user("last", 6));
    const liveMessages = messages([first, middle, last]);

    const alignment = alignContextMessages(
      liveMessages,
      [first, errorOne, middle, errorTwo, errorThree, last],
    );

    expect(alignment.status).toBe("retry_error_omissions");
    expect(alignment.omittedRetryErrorEntryIds).toEqual(["error-one", "error-two", "error-three"]);
    expect(alignment.records.map(({ entryId, messageIndex }) => [entryId, messageIndex])).toEqual([
      ["first", 0],
      ["middle", 1],
      ["last", 2],
    ]);
  });

  it("matches a retry-error message that is genuinely present instead of omitting it", () => {
    const error = retryError("present-error");
    const liveMessages = messages([error]);

    expect(alignContextMessages(liveMessages, [error])).toEqual({
      status: "exact",
      records: [{ entryId: "present-error", message: liveMessages[0], messageIndex: 0 }],
      omittedRetryErrorEntryIds: [],
    });
  });

  it("rejects a missing non-error assistant message", () => {
    const before = messageEntry("before", user("before", 1));
    const missing = messageEntry("missing", assistant("ordinary", { timestamp: 2 }));

    expect(alignContextMessages(messages([before]), [before, missing])).toMatchObject({
      status: "mismatch",
      records: [],
      omittedRetryErrorEntryIds: [],
      mismatch: {
        liveMessageIndex: 1,
        contextRecordIndex: 1,
        reason: "unexpected_context_record",
      },
    });
  });

  it.each([
    ["user", messageEntry("missing", user("missing", 2))],
    ["tool result", messageEntry("missing", toolResult("missing", 2))],
    ["custom message", customMessageEntry("missing")],
    ["branch summary", branchSummaryEntry("missing")],
    ["compaction", compactionEntry("missing")],
  ])("rejects a missing %s context message", (_label, missing) => {
    const before = messageEntry("before", user("before", 1));
    const after = messageEntry("after", user("after", 3));

    expect(alignContextMessages(messages([before, after]), [before, missing, after])).toMatchObject({
      status: "mismatch",
      records: [],
      omittedRetryErrorEntryIds: [],
      mismatch: { liveMessageIndex: 1, contextRecordIndex: 1 },
    });
  });

  it("rejects an extra live message", () => {
    const entry = messageEntry("known", user("known", 1));
    const liveMessages = [...messages([entry]), user("extra", 2)];

    expect(alignContextMessages(liveMessages, [entry])).toMatchObject({
      status: "mismatch",
      records: [],
      mismatch: {
        liveMessageIndex: 1,
        contextRecordIndex: 1,
        reason: "extra_live_message",
      },
    });
  });

  it.each([
    {
      name: "changed content",
      entries: [messageEntry("one", user("original", 1))],
      liveMessages: [user("changed", 1)],
    },
    {
      name: "changed tool-call arguments",
      entries: [messageEntry("one", assistant("work", {
        timestamp: 1,
        stopReason: "toolUse",
        toolCall: { id: "call", name: "read", arguments: { path: "one" } },
      }))],
      liveMessages: [assistant("work", {
        timestamp: 1,
        stopReason: "toolUse",
        toolCall: { id: "call", name: "read", arguments: { path: "two" } },
      })],
    },
    {
      name: "reordering",
      entries: [
        messageEntry("one", user("one", 1)),
        messageEntry("two", user("two", 2)),
      ],
      liveMessages: [user("two", 2), user("one", 1)],
    },
    {
      name: "duplicate ambiguity",
      entries: [
        messageEntry("one", user("duplicate", 1)),
        messageEntry("two", user("duplicate", 1)),
      ],
      liveMessages: [user("duplicate", 1)],
    },
  ])("rejects $name", ({ entries, liveMessages }) => {
    expect(alignContextMessages(liveMessages, entries)).toMatchObject({
      status: "mismatch",
      records: [],
    });
  });

  it("rejects the entire alignment after an eligible omission followed by a mismatch", () => {
    const before = messageEntry("before", user("before", 1));
    const error = retryError("retry-error", "failed", 2);
    const expected = messageEntry("expected", user("expected", 3));
    const liveMessages = [before.message, user("different", 3)];

    expect(alignContextMessages(liveMessages, [before, error, expected])).toEqual({
      status: "mismatch",
      records: [],
      omittedRetryErrorEntryIds: ["retry-error"],
      mismatch: {
        liveMessageIndex: 1,
        contextRecordIndex: 2,
        reason: "message_mismatch",
      },
    });
  });

  it("does not mutate live messages or context entries", () => {
    const before = messageEntry("before", user("before", 1));
    const error = retryError("retry-error", "partial failure", 2);
    const after = messageEntry("after", user("after", 3));
    const entries = [before, error, after];
    const liveMessages = messages([before, after]);
    const entriesSnapshot = structuredClone(entries);
    const messagesSnapshot = structuredClone(liveMessages);

    alignContextMessages(liveMessages, entries);

    expect(entries).toEqual(entriesSnapshot);
    expect(liveMessages).toEqual(messagesSnapshot);
  });
});
