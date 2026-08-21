import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { taskEventEnvelope, type TaskEvent } from "../src/model/events.js";
import type { TaskSummary } from "../src/model/summary.js";
import { LocalTaskRuntime, reconstructTaskState } from "../src/store/task-runtime.js";
import type { TaskEventLog } from "../src/store/task-events.js";

const config: Config = {
  features: { tasks: true, summaries: true, compaction: false, agents: false },
  limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
  shutdown: { workerDrainMs: 0, workerTermGraceMs: 5_000, workerKillGraceMs: 2_000 },
};

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

const summary: TaskSummary = {
  objective: "objective",
  outcome: "outcome",
  attempted: ["attempt"],
  learnings: ["learning"],
  decisions: ["decision"],
  files_read: ["a.ts"],
  files_modified: ["b.ts"],
  verification: ["tests pass"],
  open_threads: [],
};

function harness() {
  let nextId = 0;
  let now = 100;
  const events: TaskEvent[] = [];
  const runtime = new LocalTaskRuntime(
    config,
    "10000000-0000-4000-8000-000000000001",
    () => ids[nextId++]!,
    () => now++,
  );
  const append = (event: TaskEvent) => {
    events.push(event);
    return `entry-${events.length}`;
  };
  const boundary = (toolCallId: string) => ({
    sessionId: "session-1",
    assistantEntryId: `assistant-${toolCallId}`,
    toolCallId,
  });
  return { runtime, events, append, boundary };
}

function logFrom(events: TaskEvent[]): TaskEventLog {
  return {
    records: events.map((event, index) => ({
      entryId: `entry-${index + 1}`,
      envelope: taskEventEnvelope(event),
    })),
    issues: [],
  };
}

describe("hierarchical local task runtime", () => {
  it("opens nested tasks, enforces local depth, and restores parents on close", () => {
    const { runtime, events, append, boundary } = harness();
    const root = runtime.begin("root", boundary("begin-root"), append);
    const child = runtime.begin("child", boundary("begin-child"), append);
    const grandchild = runtime.begin("grandchild", boundary("begin-grandchild"), append);

    expect([root.depth, child.depth, grandchild.depth]).toEqual([1, 2, 3]);
    expect(() => runtime.begin("too deep", boundary("too-deep"), append)).toThrow(
      "max_task_depth 3",
    );
    expect(() => runtime.end(root.task_id, summary, true, boundary("end-root-early"), append)).toThrow(
      "active stack top",
    );

    expect(runtime.end(grandchild.task_id, summary, true, boundary("end-grandchild"), append))
      .toMatchObject({ restored_parent_task_id: child.task_id });
    expect(runtime.end(child.task_id, summary, true, boundary("end-child"), append))
      .toMatchObject({ restored_parent_task_id: root.task_id });
    const rootResult = runtime.end(root.task_id, summary, true, boundary("end-root"), append);
    expect(rootResult.restored_parent_task_id).toBeNull();
    expect(rootResult.direct_children).toEqual([{ task_id: child.task_id, task: "child" }]);
    expect(runtime.snapshot.activeStack).toEqual([]);
    expect(runtime.snapshot.tasks.get(root.task_id)?.summary).toEqual(summary);

    const reconstructed = reconstructTaskState(logFrom(events));
    expect(reconstructed.activeStack).toEqual([]);
    expect(reconstructed.tasks.get(child.task_id)?.status).toBe("completed");
    expect(reconstructed.tasks.get(root.task_id)?.children).toEqual([child.task_id]);
    expect(reconstructed.issues).toEqual([]);
  });

  it("does not retain summaries in the summaries-disabled arm", () => {
    const { runtime, append, boundary } = harness();
    const task = runtime.begin("ephemeral summary", boundary("begin"), append);
    runtime.end(task.task_id, summary, false, boundary("end"), append);
    expect(runtime.snapshot.tasks.get(task.task_id)?.status).toBe("completed");
    expect(runtime.snapshot.tasks.get(task.task_id)?.summary).toBeUndefined();
  });

  it("reports malformed future events and retains already-valid state", () => {
    const { runtime, events, append, boundary } = harness();
    const task = runtime.begin("still safe", boundary("begin"), append);
    const log = logFrom(events);
    log.issues.push({
      entryId: "future-entry",
      code: "unknown_version",
      message: "unsupported task event schema version: 2",
    });
    const reconstructed = reconstructTaskState(log);
    expect(reconstructed.tasks.get(task.task_id)?.status).toBe("open");
    expect(reconstructed.activeStack).toEqual([task.task_id]);
    expect(reconstructed.issues).toContainEqual(expect.objectContaining({ code: "unknown_version" }));
  });

  it("lists canonical child metadata and both local and agent depth", () => {
    const { runtime, append, boundary } = harness();
    const root = runtime.begin("root", boundary("root"), append);
    runtime.begin("child", boundary("child"), append);
    const listed = runtime.list({ root_task_id: root.task_id });
    expect(listed.map((item) => [item.task, item.localDepth, item.semanticDepth, item.agentDepth])).toEqual([
      ["root", 1, 1, 0],
      ["child", 2, 2, 0],
    ]);
    expect(listed[0]?.children).toEqual([{ taskId: ids[1], task: "child" }]);
  });
});
