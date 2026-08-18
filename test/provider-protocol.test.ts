import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as streamOpenAI } from "@earendil-works/pi-ai/api/openai-responses";
import { convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  StreamOptions,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
    { type: "toolCall", id: "call-b", name: "bash", arguments: { command: "b" } },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "fixture",
  usage,
  stopReason: "toolUse",
  timestamp: 1,
};

function result(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  };
}

const context: Context = {
  messages: [assistant, result("call-a", "read", "A"), result("call-b", "bash", "B")],
};

type CaptureStream = (
  model: Model<any>,
  context: Context,
  options: StreamOptions,
) => AssistantMessageEventStream;

function model(api: string, provider: string): Model<any> {
  return {
    id: "fixture",
    name: "fixture",
    api,
    provider,
    baseUrl: "http://localhost.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };
}

async function capturePayload(
  stream: CaptureStream,
  requestModel: Model<any>,
  apiKey: string,
  requestContext: Context = context,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  const events = stream(requestModel, requestContext, {
    apiKey,
    transport: "sse",
    cacheRetention: "none",
    onPayload(value) {
      payload = value;
      throw new Error("payload captured before transport");
    },
  });
  for await (const _event of events) {
    // The deliberate onPayload error terminates the stream without network I/O.
  }
  expect(payload).toBeDefined();
  return payload as Record<string, unknown>;
}

describe("Pi 0.84.1 provider protocol closures", () => {
  it("serializes a full original multi-call closure for Anthropic Messages", async () => {
    const payload = await capturePayload(
      streamAnthropic as CaptureStream,
      model("anthropic-messages", "anthropic"),
      "fixture-key",
    );
    expect(payload.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-a", name: "read", input: { path: "a" } },
          { type: "tool_use", id: "call-b", name: "bash", input: { command: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-a", content: "A", is_error: false },
          { type: "tool_result", tool_use_id: "call-b", content: "B", is_error: false },
        ],
      },
    ]);
  });

  for (const fixture of [
    {
      name: "OpenAI Responses",
      stream: streamOpenAI as CaptureStream,
      model: model("openai-responses", "openai"),
      apiKey: "fixture-key",
    },
    {
      name: "Codex Responses",
      stream: streamCodex as CaptureStream,
      model: model("openai-codex-responses", "openai-codex"),
      apiKey: `x.${Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
        }),
      ).toString("base64url")}.x`,
    },
  ]) {
    it(`serializes a full original multi-call closure for ${fixture.name}`, async () => {
      const payload = await capturePayload(fixture.stream, fixture.model, fixture.apiKey);
      expect(payload.input).toEqual([
        { type: "function_call", call_id: "call-a", name: "read", arguments: '{"path":"a"}' },
        { type: "function_call", call_id: "call-b", name: "bash", arguments: '{"command":"b"}' },
        { type: "function_call_output", call_id: "call-a", output: "A" },
        { type: "function_call_output", call_id: "call-b", output: "B" },
      ]);
    });
  }
});

const responseAssistant: AssistantMessage = {
  ...assistant,
  content: [
    { type: "text", text: "durable response" },
    { type: "toolCall", id: "respond", name: "respond_to_user", arguments: {} },
  ],
};

const projectedAgentMessages = [
  assistant,
  result("call-a", "read", "A"),
  result("call-b", "bash", "B"),
  { role: "user", content: "one protected question", timestamp: 3 },
  responseAssistant,
  result("respond", "respond_to_user", "protected"),
  {
    role: "custom",
    customType: "pi-task-framework/task-summary",
    content: "<task-summary id=\"task\">projected summary</task-summary>",
    display: false,
    details: { taskId: "task" },
    timestamp: 4,
  },
] as AgentMessage[];

const replayAgentMessages = [
  {
    role: "custom",
    customType: "pi-task-framework/task-summary",
    content: "<task-summary id=\"task\">replay summary</task-summary>",
    display: false,
    details: { taskId: "task" },
    timestamp: 4,
  },
  { role: "user", content: "one replayed question", timestamp: 5 },
] as AgentMessage[];

const providerFixtures = [
  {
    name: "Anthropic Messages",
    stream: streamAnthropic as CaptureStream,
    model: model("anthropic-messages", "anthropic"),
    apiKey: "fixture-key",
  },
  {
    name: "OpenAI Responses",
    stream: streamOpenAI as CaptureStream,
    model: model("openai-responses", "openai"),
    apiKey: "fixture-key",
  },
  {
    name: "Codex Responses",
    stream: streamCodex as CaptureStream,
    model: model("openai-codex-responses", "openai-codex"),
    apiKey: `x.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
      }),
    ).toString("base64url")}.x`,
  },
] as const;

function occurrenceCount(value: unknown, text: string): number {
  return JSON.stringify(value).split(text).length - 1;
}

describe("projected history provider serialization", () => {
  for (const fixture of providerFixtures) {
    it(`serializes pin/protection/summary survivors through ${fixture.name}`, async () => {
      const payload = await capturePayload(
        fixture.stream,
        fixture.model,
        fixture.apiKey,
        { messages: convertToLlm(projectedAgentMessages) },
      );
      expect(occurrenceCount(payload, "one protected question")).toBe(1);
      expect(occurrenceCount(payload, "projected summary")).toBe(1);
      expect(JSON.stringify(payload)).toContain("respond_to_user");
    });

    it(`serializes a replay exactly once after a summary through ${fixture.name}`, async () => {
      const payload = await capturePayload(
        fixture.stream,
        fixture.model,
        fixture.apiKey,
        { messages: convertToLlm(replayAgentMessages) },
      );
      expect(occurrenceCount(payload, "one replayed question")).toBe(1);
      expect(occurrenceCount(payload, "replay summary")).toBe(1);
    });
  }
});
