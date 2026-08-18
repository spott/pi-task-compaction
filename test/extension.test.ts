import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import taskFrameworkExtension from "../extensions/task-framework.js";
import { CONFIG_FLAGS, type Config } from "../src/config.js";
import { TASK_EVENT_CUSTOM_TYPE } from "../src/model/events.js";
import { registerTaskFramework, stripUnretainedSummaries } from "../src/task-framework.js";

interface Collector {
  pi: ExtensionAPI;
  handlers: Map<string, Array<(event: any, ctx: any) => any>>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  flags: string[];
}

function collector(appendEntry: (customType: string, data: unknown) => void = () => undefined): Collector {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const flags: string[] = [];
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    registerFlag(name: string) {
      flags.push(name);
    },
    getFlag() {
      return undefined;
    },
    appendEntry,
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, commands, flags };
}

function config(features: Config["features"]): Config {
  return {
    features,
    limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
  };
}

const taskTools = [
  "begin_task",
  "end_task",
  "inspect_task",
  "list_tasks",
  "preserve_output",
  "read_preserved_output",
  "respond_to_user",
] as const;

const arms = [
  {
    name: "vanilla",
    features: { tasks: false, summaries: false, compaction: false, agents: false },
    tools: [],
    hooks: [],
  },
  {
    name: "tasks only",
    features: { tasks: true, summaries: false, compaction: false, agents: false },
    tools: taskTools,
    hooks: ["context", "session_start", "session_tree", "turn_end"],
  },
  {
    name: "tasks and summaries",
    features: { tasks: true, summaries: true, compaction: false, agents: false },
    tools: taskTools,
    hooks: ["session_start", "session_tree", "turn_end"],
  },
  {
    name: "tasks summaries compaction",
    features: { tasks: true, summaries: true, compaction: true, agents: false },
    tools: taskTools,
    hooks: ["context", "session_before_compact", "session_start", "session_tree", "turn_end"],
  },
  {
    name: "tasks summaries agents",
    features: { tasks: true, summaries: true, compaction: false, agents: true },
    tools: taskTools,
    hooks: ["session_start", "session_tree", "turn_end"],
  },
  {
    name: "full",
    features: { tasks: true, summaries: true, compaction: true, agents: true },
    tools: taskTools,
    hooks: ["context", "session_before_compact", "session_start", "session_tree", "turn_end"],
  },
] as const;

function assistant(toolCallId: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
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

function toolResult(toolCallId: string, toolName: string, text: string) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function context(manager: SessionManager) {
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  const ctx = {
    sessionManager: manager,
    ui: {
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses, notifications };
}

const summaryArgs = {
  objective: "objective",
  outcome: "outcome",
  attempted: ["attempt"],
  learnings: ["learning"],
  decisions: ["decision"],
  files_read: [],
  files_modified: [],
  verification: ["verified"],
  open_threads: [],
};

describe("config-gated extension surface", () => {
  it("defers feature registration until Pi has parsed CLI flags", async () => {
    const manager = SessionManager.inMemory("/tmp/task-framework-flag-test");
    const collected = collector((customType, data) => manager.appendCustomEntry(customType, data));
    const values: Record<string, string> = {
      [CONFIG_FLAGS.tasks]: "false",
      [CONFIG_FLAGS.summaries]: "false",
      [CONFIG_FLAGS.compaction]: "false",
      [CONFIG_FLAGS.agents]: "false",
    };
    (collected.pi as any).getFlag = (name: string) => values[name];
    taskFrameworkExtension(collected.pi);

    expect(collected.tools.size).toBe(0);
    expect(collected.commands.size).toBe(0);
    expect(collected.flags).toHaveLength(8);
    const { ctx } = context(manager);
    await collected.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    expect(collected.tools.size).toBe(0);
    expect(collected.commands.size).toBe(0);
  });

  for (const arm of arms) {
    it(`registers the exact M7 surface for ${arm.name}`, () => {
      const collected = collector();
      registerTaskFramework(collected.pi, config({ ...arm.features }));
      expect([...collected.tools.keys()].sort()).toEqual([...arm.tools].sort());
      expect([...collected.handlers.keys()].sort()).toEqual([...arm.hooks].sort());
      expect([...collected.commands.keys()]).toEqual(arm.features.tasks ? ["tasks"] : []);
    });
  }
});

describe("Pi task extension integration", () => {
  it("persists, reconstructs, and branch-isolates hierarchical task events", async () => {
    const manager = SessionManager.inMemory("/tmp/task-framework-test");
    const collected = collector((customType, data) => manager.appendCustomEntry(customType, data));
    const services = registerTaskFramework(
      collected.pi,
      config({ tasks: true, summaries: true, compaction: false, agents: false }),
    )!;
    const { ctx, statuses } = context(manager);
    await collected.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

    manager.appendMessage(assistant("call-root", "begin_task", { task: "root" }));
    const rootResult = await collected.tools
      .get("begin_task")
      .execute("call-root", { task: "root" }, undefined, undefined, ctx);
    const rootId = rootResult.details.task_id as string;
    expect(statuses.get("task-framework")).toContain("root");

    const rootStartedEntry = manager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === TASK_EVENT_CUSTOM_TYPE &&
          (entry.data as any).event.type === "task_started" &&
          (entry.data as any).event.taskId === rootId,
      )!;

    manager.appendMessage(assistant("call-child", "begin_task", { task: "discarded branch child" }));
    await collected.tools
      .get("begin_task")
      .execute("call-child", { task: "discarded branch child" }, undefined, undefined, ctx);
    expect(services.runtime.activeTasks().map((task) => task.task)).toEqual([
      "root",
      "discarded branch child",
    ]);

    manager.branch(rootStartedEntry.id);
    await collected.handlers.get("session_tree")![0]!({ type: "session_tree" }, ctx);
    expect(services.runtime.activeTasks().map((task) => task.task)).toEqual(["root"]);

    manager.appendMessage(assistant("call-alt", "begin_task", { task: "active branch child" }));
    const childResult = await collected.tools
      .get("begin_task")
      .execute("call-alt", { task: "active branch child" }, undefined, undefined, ctx);
    const childId = childResult.details.task_id as string;
    manager.appendMessage(assistant("call-end-child", "end_task", { task_id: childId, ...summaryArgs }));
    await collected.tools
      .get("end_task")
      .execute("call-end-child", { task_id: childId, ...summaryArgs }, undefined, undefined, ctx);

    expect(services.runtime.snapshot.tasks.size).toBe(2);
    expect(services.runtime.snapshot.tasks.get(rootId)?.children).toEqual([childId]);
    expect(services.runtime.snapshot.tasks.get(childId)?.status).toBe("completed");
    expect(services.runtime.snapshot.activeStack).toEqual([rootId]);
    expect(services.runtime.snapshot.issues).toEqual([]);
  });

  it("uses the same preservation path for delayed end-task selectors and exact reads", async () => {
    const manager = SessionManager.inMemory("/tmp/task-framework-end-preservation-test");
    const collected = collector((customType, data) => manager.appendCustomEntry(customType, data));
    const services = registerTaskFramework(
      collected.pi,
      config({ tasks: true, summaries: true, compaction: false, agents: false }),
    )!;
    const { ctx } = context(manager);
    await collected.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

    manager.appendMessage(assistant("begin-preserve", "begin_task", { task: "preservation" }));
    const beginResult = await collected.tools
      .get("begin_task")
      .execute("begin-preserve", { task: "preservation" }, undefined, undefined, ctx);
    const taskId = beginResult.details.task_id as string;
    manager.appendMessage(toolResult("begin-preserve", "begin_task", "opened"));
    const beginResultEntryId = manager.getLeafId()!;
    manager.appendMessage(assistant("ordinary-source", "read", { path: "important.txt" }));
    manager.appendMessage(toolResult("ordinary-source", "read", "important contents"));
    manager.appendMessage(assistant("end-preserve", "end_task", {
      task_id: taskId,
      ...summaryArgs,
      preserve_outputs: [{ tool_call_id: "ordinary-source", pin: true }],
    }));
    const endResult = await collected.tools.get("end_task").execute(
      "end-preserve",
      {
        task_id: taskId,
        ...summaryArgs,
        preserve_outputs: [{ tool_call_id: "ordinary-source", pin: true }],
      },
      undefined,
      undefined,
      ctx,
    );
    const outputId = endResult.details.preserved_outputs[0].output_id as string;
    manager.appendMessage(toolResult("end-preserve", "end_task", "closed"));
    const endResultEntryId = manager.getLeafId()!;
    await collected.handlers.get("turn_end")![0]!({ type: "turn_end" }, ctx);
    expect(services.runtime.snapshot.tasks.get(taskId)?.transcript).toMatchObject({
      beginAnchor: { tool: { resultEntryId: beginResultEntryId } },
      endAnchor: { tool: { resultEntryId: endResultEntryId } },
    });
    expect(services.runtime.snapshot.outputs.get(outputId)).toMatchObject({ pin: true, taskId });

    const readResult = await collected.tools
      .get("read_preserved_output")
      .execute("read-output", { output_id: outputId }, undefined, undefined, ctx);
    expect(readResult.content).toEqual([{ type: "text", text: "important contents" }]);
  });

  it("wires task projection and replay into the compaction context hook", async () => {
    const manager = SessionManager.inMemory("/tmp/task-framework-context-projection-test");
    const collected = collector((customType, data) => manager.appendCustomEntry(customType, data));
    const services = registerTaskFramework(
      collected.pi,
      config({ tasks: true, summaries: true, compaction: true, agents: false }),
    )!;
    const { ctx } = context(manager);
    await collected.handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);

    manager.appendMessage(assistant("begin-project", "begin_task", { task: "project" }));
    const beginResult = await collected.tools
      .get("begin_task")
      .execute("begin-project", { task: "project" }, undefined, undefined, ctx);
    const taskId = beginResult.details.task_id as string;
    manager.appendMessage(toolResult("begin-project", "begin_task", "opened"));
    manager.appendMessage({ role: "user", content: "Replay through hook", timestamp: Date.now() });
    manager.appendMessage(assistant("end-project", "end_task", { task_id: taskId, ...summaryArgs }));
    const endResult = await collected.tools
      .get("end_task")
      .execute("end-project", { task_id: taskId, ...summaryArgs }, undefined, undefined, ctx);
    expect(endResult.details.unanswered_message_count).toBe(1);
    manager.appendMessage(toolResult("end-project", "end_task", "closed"));

    const messages = manager.buildSessionContext().messages;
    const transformed = await collected.handlers.get("context")![0]!
      ({ type: "context", messages }, ctx);
    expect(transformed.messages.filter((message: AgentMessage) => message.role === "custom")).toHaveLength(1);
    expect(
      transformed.messages.filter(
        (message: AgentMessage) => message.role === "user" && message.content === "Replay through hook",
      ),
    ).toHaveLength(1);
    expect(transformed.messages.at(-1)).toMatchObject({ role: "user", content: "Replay through hook" });
    expect(services.projection.lastPlan?.projectedTaskIds).toEqual([taskId]);
    expect(services.projection.rejectionCounts.size).toBe(0);
  });

  it("removes authored summary fields from the next context when retention is disabled", () => {
    const messages = [
      assistant("call-end", "end_task", {
        task_id: "00000000-0000-4000-8000-000000000001",
        objective: "SECRET OBJECTIVE",
        outcome: "SECRET OUTCOME",
        attempted: [],
        learnings: [],
        decisions: [],
        files_read: [],
        files_modified: [],
        verification: [],
        open_threads: [],
      }),
    ] as AgentMessage[];
    const stripped = stripUnretainedSummaries(messages);
    const serialized = JSON.stringify(stripped);
    expect(serialized).not.toContain("SECRET OBJECTIVE");
    expect(serialized).not.toContain("SECRET OUTCOME");
    expect(serialized).toContain('"summary_retained":false');
  });
});
