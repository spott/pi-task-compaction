import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope, type TaskEvent } from "../src/model/events.js";
import type { WorkerRoute } from "../src/model/worker.js";
import { FileRunRegistry } from "../src/store/run-registry.js";
import { readTaskEventLog } from "../src/store/task-events.js";
import { LocalTaskRuntime } from "../src/store/task-runtime.js";
import { registerTaskFramework } from "../src/task-framework.js";
import { WorkerTaskRouter } from "../src/workers/coordinator.js";
import { precreateWorkerTaskSource, readWorkerTaskSource } from "../src/workers/source.js";

const config: Config = {
  features: { tasks: true, summaries: true, compaction: false, agents: true },
  limits: { maxTaskDepth: 2, maxAgentDepth: 2, maxConcurrentAgents: 2 },
};

function appendTo(manager: SessionManager) {
  return (event: TaskEvent): string => manager.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope(event));
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "task-worker-routing-"));
  const runId = randomUUID();
  const registry = await FileRunRegistry.create({ root: join(base, "run"), runId });
  const workerId = randomUUID();
  const taskId = randomUUID();
  const parentTaskId = randomUUID();
  const source = await precreateWorkerTaskSource({
    runDirectory: registry.directory,
    cwd: base,
    workerId,
    taskId,
    task: "worker-owned task",
    parentTaskId,
    agentDepth: 1,
  });
  const route: WorkerRoute = {
    schemaVersion: 1,
    workerId,
    taskId,
    runId,
    sessionId: source.sessionId,
    sessionFile: source.sessionFile,
    spawningSessionId: "parent-session",
    parentTaskId,
    status: "starting",
  };
  await registry.registerWorker(route);
  return { base, registry, workerId, taskId, parentTaskId, source, route };
}

describe("worker routing and single-owner bootstrap", () => {
  it("pre-creates one private worker source and resets the local task-depth budget", async () => {
    const item = await fixture();
    const disk = (await readFile(item.source.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(disk).toHaveLength(2);
    expect((await lstat(item.registry.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(item.source.sessionFile)).mode & 0o777).toBe(0o600);

    const opened = readWorkerTaskSource(item.source.sessionFile, item.taskId);
    expect(opened.task).toMatchObject({
      id: item.taskId,
      parentId: item.parentTaskId,
      localDepth: 0,
      status: "open",
      execution: { kind: "worker", workerId: item.workerId, agentDepth: 1 },
    });
    expect(opened.state.activeStack).toEqual([item.taskId]);
    expect(opened.state.startedTaskIds.size).toBe(0);

    const runtime = new LocalTaskRuntime(config, "worker-process", randomUUID);
    runtime.reconstruct(readTaskEventLog(opened.manager.getBranch()));
    runtime.adoptAssignedRoot(item.taskId, appendTo(opened.manager));
    const childId = randomUUID();
    const childRuntime = new LocalTaskRuntime(config, "worker-process", () => childId);
    childRuntime.reconstruct(readTaskEventLog(opened.manager.getBranch()));
    childRuntime.begin(
      "fresh local child",
      { sessionId: item.source.sessionId, assistantEntryId: "assistant-child", toolCallId: "call-child" },
      appendTo(opened.manager),
    );
    expect(childRuntime.snapshot.tasks.get(childId)).toMatchObject({
      parentId: item.taskId,
      localDepth: 1,
    });
  });

  it("keeps parent spawn provenance separate from the worker semantic stream", async () => {
    const item = await fixture();
    const parent = SessionManager.inMemory(item.base);
    const runtime = new LocalTaskRuntime(config);
    runtime.recordWorkerSpawn(
      {
        spawnedTaskId: item.taskId,
        task: "worker-owned task",
        workerId: item.workerId,
        sessionId: item.source.sessionId,
        agentDepth: 1,
      },
      appendTo(parent),
    );

    expect(runtime.snapshot.tasks.has(item.taskId)).toBe(false);
    expect(runtime.snapshot.workerSpawns.get(item.taskId)).toMatchObject({ parentTaskId: null });
    expect(
      parent.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TASK_EVENT_CUSTOM_TYPE),
    ).toHaveLength(1);
    expect(readWorkerTaskSource(item.source.sessionFile, item.taskId).state.workerSpawns.size).toBe(0);
  });

  it("enforces run-wide leases and routes a never-started dead worker as derived failure", async () => {
    const item = await fixture();
    const second = randomUUID();
    const third = randomUUID();
    await item.registry.acquireLease(item.workerId, 2);
    await item.registry.acquireLease(second, 2);
    await expect(item.registry.acquireLease(third, 2)).rejects.toThrow("2/2 worker leases");
    await item.registry.releaseLease(second);
    await item.registry.acquireLease(third, 2);

    await item.registry.updateWorker(item.workerId, {
      status: "failed",
      exitCode: 1,
      diagnostics: "process exited before startup",
    });
    const router = new WorkerTaskRouter(item.registry, "parent-session");
    const resolved = await router.resolve(item.taskId);
    expect(resolved).toMatchObject({
      semanticStatus: "open",
      resolvedStatus: "derived_failed",
      lifecycleStatus: "failed",
      evidence: "registry",
      diagnostics: "process exited before startup",
    });
    expect(readWorkerTaskSource(item.source.sessionFile, item.taskId).task.status).toBe("open");
  });

  it("adopts the pre-created root on session start and records owned failure on graceful shutdown", async () => {
    const item = await fixture();
    const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
    const pi = {
      on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry(customType: string, data: unknown) {
        const manager = activeManager;
        manager.appendCustomEntry(customType, data);
      },
    } as unknown as ExtensionAPI;
    const activeManager = SessionManager.open(item.source.sessionFile);
    const ctx = {
      cwd: item.base,
      sessionManager: activeManager,
      ui: { setStatus() {} },
    } as unknown as ExtensionContext;
    registerTaskFramework(pi, config, {
      worker: {
        bootstrap: {
          schemaVersion: 1,
          workerId: item.workerId,
          taskId: item.taskId,
          task: "worker-owned task",
          parentTaskId: item.parentTaskId,
          agentDepth: 1,
          runId: item.registry.runId,
          runDirectory: item.registry.directory,
          sessionId: item.source.sessionId,
          sessionFile: item.source.sessionFile,
          spawningSessionId: "parent-session",
          requiredContext: [],
          availableContext: [],
        },
        registry: item.registry,
      },
    });
    await handlers.get("session_start")![0]!({ type: "session_start" }, ctx);
    expect((await item.registry.resolveWorker(item.workerId))?.status).toBe("running");
    expect(readWorkerTaskSource(item.source.sessionFile, item.taskId).state.startedTaskIds).toContain(item.taskId);

    await handlers.get("session_shutdown")![0]!({ type: "session_shutdown" }, ctx);
    const reopened = readWorkerTaskSource(item.source.sessionFile, item.taskId);
    expect(reopened.task.status).toBe("failed");
    expect((await item.registry.resolveWorker(item.workerId))?.status).toBe("failed");
  });

  it("restricts worker visibility to its subtree and explicit context", async () => {
    const item = await fixture();
    const unrelatedWorkerId = randomUUID();
    const unrelatedTaskId = randomUUID();
    const unrelated = await precreateWorkerTaskSource({
      runDirectory: item.registry.directory,
      cwd: item.base,
      workerId: unrelatedWorkerId,
      taskId: unrelatedTaskId,
      task: "unrelated",
      parentTaskId: null,
      agentDepth: 1,
    });
    await item.registry.registerWorker({
      schemaVersion: 1,
      workerId: unrelatedWorkerId,
      taskId: unrelatedTaskId,
      runId: item.registry.runId,
      sessionId: unrelated.sessionId,
      sessionFile: unrelated.sessionFile,
      spawningSessionId: "other-session",
      parentTaskId: null,
      status: "starting",
    });

    const bootstrap = {
      schemaVersion: 1 as const,
      workerId: item.workerId,
      taskId: item.taskId,
      task: "worker-owned task",
      parentTaskId: item.parentTaskId,
      agentDepth: 1,
      runId: item.registry.runId,
      runDirectory: item.registry.directory,
      sessionId: item.source.sessionId,
      sessionFile: item.source.sessionFile,
      spawningSessionId: "parent-session",
      requiredContext: [],
      availableContext: [],
    };
    const restricted = new WorkerTaskRouter(item.registry, item.source.sessionId, bootstrap);
    expect((await restricted.listRoutes()).map((route) => route.taskId)).toEqual([item.taskId]);

    const explicit = new WorkerTaskRouter(item.registry, item.source.sessionId, {
      ...bootstrap,
      availableContext: [{ taskId: unrelatedTaskId, task: "unrelated", status: "open" }],
    });
    expect((await explicit.listRoutes()).map((route) => route.taskId).sort()).toEqual(
      [item.taskId, unrelatedTaskId].sort(),
    );
  });
});
