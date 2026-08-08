import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { EXTENSION_ID, SCHEMA_VERSION, type BeginMarker, type EndMarker } from "../src/types.js";

let now = 1;
const timestamp = () => now++;

export const user = (text = "Do the work"): AgentMessage => ({ role: "user", content: text, timestamp: timestamp() }) as AgentMessage;

export const assistant = (
  calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
  model = "test-model",
): AgentMessage => ({
  role: "assistant",
  content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} })),
  api: "anthropic-messages",
  provider: "test",
  model,
  usage: {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: timestamp(),
}) as AgentMessage;

export const toolResult = (toolCallId: string, toolName: string, details?: unknown, text = "ok"): AgentMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  details,
  isError: false,
  timestamp: timestamp(),
}) as AgentMessage;

export const beginMarker = (taskId = "task1", callId = `begin-${taskId}`): BeginMarker => ({
  extension: EXTENSION_ID,
  schemaVersion: SCHEMA_VERSION,
  event: "begin",
  taskId,
  objective: `Explore ${taskId}`,
  toolCallId: callId,
});

export const endMarker = (taskId = "task1", beginCallId = `begin-${taskId}`, endCallId = `end-${taskId}`): EndMarker => ({
  extension: EXTENSION_ID,
  schemaVersion: SCHEMA_VERSION,
  event: "end",
  taskId,
  beginToolCallId: beginCallId,
  endToolCallId: endCallId,
  objective: `Explore ${taskId}`,
  outcome: "Found the answer",
  attempted: ["Read the implementation"],
  learnings: ["The durable fact"],
  decisions: ["Use the safe path"],
  filesRead: ["src/read.ts"],
  filesModified: [],
  artifacts: [],
  verification: ["npm test passed"],
  openThreads: [],
});

export const closedTaskMessages = (taskId = "task1", model = "test-model"): AgentMessage[] => {
  const begin = beginMarker(taskId);
  const end = endMarker(taskId);
  return [
    assistant([{ id: begin.toolCallId, name: "begin_task", arguments: { objective: begin.objective } }], model),
    toolResult(begin.toolCallId, "begin_task", begin),
    assistant([{ id: `read-${taskId}`, name: "read", arguments: { path: "src/read.ts" } }], model),
    toolResult(`read-${taskId}`, "read", undefined, "x".repeat(8000)),
    assistant([{ id: end.endToolCallId, name: "end_task", arguments: { task_id: taskId } }], model),
    toolResult(end.endToolCallId, "end_task", end),
  ];
};

export const entriesFor = (messages: AgentMessage[]): SessionEntry[] => messages.map((message, index) => ({
  type: "message",
  id: `e${index.toString().padStart(3, "0")}`,
  parentId: index === 0 ? null : `e${(index - 1).toString().padStart(3, "0")}`,
  timestamp: new Date(timestamp()).toISOString(),
  message,
}) as SessionEntry);
