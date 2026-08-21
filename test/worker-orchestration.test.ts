import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CONFIG_FLAGS, type Config } from "../src/config.js";
import { TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope, type TaskEvent } from "../src/model/events.js";
import type { TaskSummary } from "../src/model/summary.js";
import { FileRunRegistry } from "../src/store/run-registry.js";
import { LocalTaskRuntime } from "../src/store/task-runtime.js";
import { AsyncWorkerCoordinator, WorkerTaskRouter } from "../src/workers/coordinator.js";
import type {
  WorkerProcessExit,
  WorkerProcessHandle,
  WorkerProcessLauncher,
  WorkerProcessSpec,
} from "../src/workers/process.js";
import { NodeWorkerProcessLauncher } from "../src/workers/process.js";
import { readWorkerTaskSource } from "../src/workers/source.js";

const config: Config = {
  features: { tasks: true, summaries: true, compaction: false, agents: true },
  limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 2 },
  shutdown: { workerDrainMs: 0, workerTermGraceMs: 5_000, workerKillGraceMs: 2_000 },
};

const summary: TaskSummary = {
  objective: "delegated objective",
  outcome: "delegated outcome",
  attempted: ["attempt"],
  learnings: ["learning"],
  decisions: ["decision"],
  files_read: [],
  files_modified: [],
  verification: ["verified"],
  open_threads: [],
};

function appendTo(manager: SessionManager) {
  return (event: TaskEvent): string => manager.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope(event));
}

class FailingLauncher implements WorkerProcessLauncher {
  async launch(_spec: WorkerProcessSpec): Promise<WorkerProcessHandle> {
    throw new Error("spawn syscall failed");
  }
}

class ControlledLauncher implements WorkerProcessLauncher {
  readonly specs: WorkerProcessSpec[] = [];
  private readonly exits: Array<(exit: WorkerProcessExit) => void> = [];

  async launch(spec: WorkerProcessSpec): Promise<WorkerProcessHandle> {
    this.specs.push(spec);
    const pid = 40_000 + this.specs.length;
    let resolve!: (exit: WorkerProcessExit) => void;
    const wait = new Promise<WorkerProcessExit>((done) => {
      resolve = done;
    });
    this.exits.push(resolve);
    return { pid, wait: () => wait, terminate: () => true };
  }

  finish(index: number, exit: WorkerProcessExit): void {
    this.exits[index]!(exit);
  }
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for worker state");
}

async function fixture(overrides: Partial<Config> = {}) {
  const base = await mkdtemp(join(tmpdir(), "task-worker-orchestration-"));
  const registry = await FileRunRegistry.create({ root: join(base, "run") });
  const parentFile = join(base, "parent.jsonl");
  await writeFile(parentFile, "", { mode: 0o600 });
  const parent = SessionManager.open(parentFile, base, base);
  const effective: Config = {
    features: { ...config.features, ...overrides.features },
    limits: { ...config.limits, ...overrides.limits },
    shutdown: { ...config.shutdown, ...overrides.shutdown },
  };
  const runtime = new LocalTaskRuntime(effective);
  const router = new WorkerTaskRouter(registry, parent.getSessionId());
  const launcher = new ControlledLauncher();
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const coordinator = new AsyncWorkerCoordinator({
    config: effective,
    registry,
    runtime,
    router,
    launcher,
    ownerSessionId: parent.getSessionId(),
    extensionPath: join(base, "task-framework.ts"),
    createId: () => ids.shift()!,
    joinPollMs: 2,
  });
  return { base, registry, parent, effective, runtime, router, launcher, coordinator };
}

function spawnContext(item: Awaited<ReturnType<typeof fixture>>) {
  return {
    cwd: item.base,
    sessionId: item.parent.getSessionId(),
    sessionFile: item.parent.getSessionFile()!,
    append: appendTo(item.parent),
    model: { provider: "anthropic", id: "test-model" },
    thinkingLevel: "low",
    projectTrusted: true,
  };
}

describe("asynchronous worker orchestration", () => {
  it("allocates before launch, returns immediately, and joins an authoritative completion", async () => {
    const item = await fixture();
    const spawned = await item.coordinator.spawn(
      { task: "independent branch", requiredContext: [], availableContext: [] },
      spawnContext(item),
    );
    expect(spawned.status).toBe("starting");
    expect(item.launcher.specs).toHaveLength(1);
    const spec = item.launcher.specs[0]!;
    expect(spec.args).toContain("--no-extensions");
    expect(spec.args).toContain("--session");
    for (const [flag, value] of [
      [CONFIG_FLAGS.workerShutdownDrainMs, "0"],
      [CONFIG_FLAGS.workerShutdownTermGraceMs, "5000"],
      [CONFIG_FLAGS.workerShutdownKillGraceMs, "2000"],
    ] as const) {
      const index = spec.args.indexOf(`--${flag}`);
      expect(spec.args.slice(index, index + 2)).toEqual([`--${flag}`, value]);
    }
    expect(spec.args.at(-1)).toContain(`Assigned task ID: ${spawned.taskId}`);
    expect(spec.environment.PI_TASK_FRAMEWORK_BOOTSTRAP).toBeTruthy();
    expect((await lstat(spec.environment.PI_TASK_FRAMEWORK_BOOTSTRAP!)).mode & 0o777).toBe(0o600);
    const bootstrap = JSON.parse(await readFile(spec.environment.PI_TASK_FRAMEWORK_BOOTSTRAP!, "utf8"));
    expect(bootstrap).toMatchObject({
      taskId: spawned.taskId,
      task: "independent branch",
      parentTaskId: null,
      agentDepth: 1,
      spawningSessionId: item.parent.getSessionId(),
    });
    expect(item.runtime.snapshot.workerSpawns.get(spawned.taskId)).toMatchObject({
      task: "independent branch",
      parentTaskId: null,
    });
    expect((await item.coordinator.poll(spawned.taskId)).lifecycleStatus).toBe("starting");

    const route = (await item.registry.resolveTask(spawned.taskId))!;
    const worker = SessionManager.open(route.sessionFile);
    const append = appendTo(worker);
    append({ type: "task_started", at: Date.now(), taskId: spawned.taskId });
    append({
      type: "task_completed",
      at: Date.now(),
      taskId: spawned.taskId,
      endAnchor: { sessionId: route.sessionId, entryId: worker.getLeafId(), boundary: "after" },
      summary,
    });
    await item.registry.updateWorker(route.workerId, { status: "running", startedAt: Date.now() });
    item.launcher.finish(0, { exitCode: 0, signal: null, stderr: "" });

    const completed = await waitFor(
      () => item.coordinator.poll(spawned.taskId),
      (value) => value.lifecycleStatus === "completed",
    );
    expect(completed).toMatchObject({
      semanticStatus: "completed",
      resolvedStatus: "completed",
      evidence: "semantic",
    });
    const joined = await item.coordinator.join([spawned.taskId], "all");
    expect(joined).toEqual({
      wait: "all",
      completed: [{
        task_id: spawned.taskId,
        task: "independent branch",
        status: "completed",
        summary_retained: true,
        summary,
        evidence: "semantic",
      }],
      pending: [],
      failed: [],
    });
  });

  it("creates a direct cross-session semantic child when the spawner has an active task", async () => {
    const item = await fixture();
    const parentId = item.runtime.begin(
      "active parent",
      { sessionId: item.parent.getSessionId(), assistantEntryId: "parent-assistant", toolCallId: "parent-call" },
      appendTo(item.parent),
    ).task_id;
    const spawned = await item.coordinator.spawn(
      { task: "worker child", requiredContext: [], availableContext: [] },
      spawnContext(item),
    );
    expect(item.runtime.snapshot.tasks.get(parentId)?.children).toContain(spawned.taskId);
    expect(item.runtime.snapshot.workerSpawns.get(spawned.taskId)?.parentTaskId).toBe(parentId);
    const route = (await item.registry.resolveTask(spawned.taskId))!;
    expect(readWorkerTaskSource(route.sessionFile, spawned.taskId).task.parentId).toBe(parentId);
  });

  it("records a launch-transaction failure and releases its run-wide lease", async () => {
    const item = await fixture();
    const coordinator = new AsyncWorkerCoordinator({
      config: item.effective,
      registry: item.registry,
      runtime: item.runtime,
      router: item.router,
      launcher: new FailingLauncher(),
      ownerSessionId: item.parent.getSessionId(),
    });
    await expect(coordinator.spawn(
      { task: "cannot launch", requiredContext: [], availableContext: [] },
      spawnContext(item),
    )).rejects.toThrow("spawn syscall failed");
    const [route] = await item.registry.listWorkers();
    expect(route).toMatchObject({ status: "failed", diagnostics: expect.stringContaining("spawn syscall failed") });
    expect(item.runtime.snapshot.workerSpawns.has(route!.taskId)).toBe(true);
    const leaseA = randomUUID();
    const leaseB = randomUUID();
    await item.registry.acquireLease(leaseA, 2);
    await item.registry.acquireLease(leaseB, 2);
  });

  it("reports process death without completion as registry-derived failure", async () => {
    const item = await fixture();
    const spawned = await item.coordinator.spawn(
      { task: "dies before startup", requiredContext: [], availableContext: [] },
      spawnContext(item),
    );
    item.launcher.finish(0, { exitCode: 1, signal: null, stderr: "startup exploded" });
    const failed = await waitFor(
      () => item.coordinator.poll(spawned.taskId),
      (value) => value.lifecycleStatus === "failed",
    );
    expect(failed).toMatchObject({
      semanticStatus: "open",
      resolvedStatus: "derived_failed",
      lifecycleStatus: "failed",
      evidence: "registry",
    });
    expect(failed.diagnostics).toContain("startup exploded");
    const joined = await item.coordinator.join([spawned.taskId], "any");
    expect(joined.completed).toEqual([]);
    expect(joined.pending).toEqual([]);
    expect(joined.failed[0]).toMatchObject({
      task_id: spawned.taskId,
      status: "failed",
      semantic_status: "open",
      evidence: "registry",
    });
    expect(readWorkerTaskSource(failed.route.sessionFile, spawned.taskId).task.status).toBe("open");
  });

  it("join any returns the first terminal partition without cancelling a pending sibling", async () => {
    const item = await fixture();
    const first = await item.coordinator.spawn(
      { task: "still running", requiredContext: [], availableContext: [] },
      spawnContext(item),
    );
    const second = await item.coordinator.spawn(
      { task: "first terminal", requiredContext: [], availableContext: [] },
      spawnContext(item),
    );
    item.launcher.finish(1, { exitCode: 2, signal: null, stderr: "terminal failure" });
    const joined = await item.coordinator.join([first.taskId, second.taskId], "any");
    expect(joined.pending).toEqual([
      { task_id: first.taskId, task: "still running", status: "starting" },
    ]);
    expect(joined.failed[0]).toMatchObject({ task_id: second.taskId, evidence: "registry" });
    expect((await item.coordinator.poll(first.taskId)).lifecycleStatus).toBe("starting");
  });

  it("injects completed required summaries, exposes available references, and enforces agent depth", async () => {
    const item = await fixture();
    const taskId = randomUUID();
    const availableTaskId = randomUUID();
    const contextIds = [taskId, availableTaskId];
    const call = { sessionId: item.parent.getSessionId(), assistantEntryId: "assistant", toolCallId: "call" };
    const seeded = new LocalTaskRuntime(item.effective, "parent", () => contextIds.shift()!);
    seeded.begin("completed prior task", call, appendTo(item.parent));
    seeded.end(taskId, summary, true, call, appendTo(item.parent));
    seeded.begin("optional prior task", call, appendTo(item.parent));
    seeded.end(availableTaskId, summary, true, call, appendTo(item.parent));
    item.runtime.reconstructEntries(item.parent.getBranch());

    await item.coordinator.spawn(
      { task: "uses context", requiredContext: [taskId], availableContext: [availableTaskId] },
      spawnContext(item),
    );
    const bootstrap = JSON.parse(
      await readFile(item.launcher.specs[0]!.environment.PI_TASK_FRAMEWORK_BOOTSTRAP!, "utf8"),
    );
    const parentSource = {
      sessionId: item.parent.getSessionId(),
      sessionFile: item.parent.getSessionFile(),
    };
    expect(bootstrap.requiredContext).toEqual([{
      taskId,
      task: "completed prior task",
      summary,
      source: parentSource,
    }]);
    expect(bootstrap.availableContext).toEqual([{
      taskId: availableTaskId,
      task: "optional prior task",
      status: "completed",
      source: parentSource,
    }]);

    const workerRoute = (await item.registry.listWorkers())[0]!;
    const workerBootstrap = { ...bootstrap, agentDepth: 2 };
    const workerRuntime = new LocalTaskRuntime(item.effective);
    workerRuntime.reconstructEntries(SessionManager.open(workerRoute.sessionFile).getBranch());
    const workerRouter = new WorkerTaskRouter(item.registry, workerRoute.sessionId, workerBootstrap);
    expect((await workerRouter.resolveVisibleTask(availableTaskId))?.task.task).toBe("optional prior task");
    expect((await workerRouter.list()).map((entry) => entry.task.id).sort()).toEqual(
      [taskId, availableTaskId, workerRoute.taskId].sort(),
    );
    const nested = new AsyncWorkerCoordinator({
      config: item.effective,
      registry: item.registry,
      runtime: workerRuntime,
      router: workerRouter,
      bootstrap: workerBootstrap,
      launcher: item.launcher,
      ownerSessionId: workerRoute.sessionId,
    });
    await expect(nested.spawn(
      { task: "too deep", requiredContext: [], availableContext: [] },
      { ...spawnContext(item), sessionId: workerRoute.sessionId },
    )).rejects.toThrow("max_agent_depth 2");
  });

  it("adopts a pre-created source in a real Pi 0.84.1 subprocess and records graceful failure", async () => {
    const item = await fixture();
    const wrapper = join(item.base, "worker-test-extension.ts");
    const productionExtension = join(process.cwd(), "extensions", "task-framework.ts");
    await writeFile(
      wrapper,
      `import base from ${JSON.stringify(productionExtension)};\n` +
        `export default function testWorker(pi) {\n` +
        `  base(pi);\n` +
        `  pi.on("input", () => ({ action: "handled" }));\n` +
        `}\n`,
      { mode: 0o600 },
    );
    const cli = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    const launcher = new NodeWorkerProcessLauncher({
      invocation: { command: process.execPath, prefixArgs: [cli] },
    });
    const ids = [randomUUID(), randomUUID()];
    const coordinator = new AsyncWorkerCoordinator({
      config: item.effective,
      registry: item.registry,
      runtime: item.runtime,
      router: item.router,
      launcher,
      ownerSessionId: item.parent.getSessionId(),
      extensionPath: wrapper,
      createId: () => ids.shift()!,
      joinPollMs: 5,
    });
    const { model: _model, ...contextWithoutModel } = spawnContext(item);
    const spawned = await coordinator.spawn(
      { task: "real subprocess adoption", requiredContext: [], availableContext: [] },
      contextWithoutModel,
    );
    const failed = await waitFor(
      () => coordinator.poll(spawned.taskId),
      (value) => value.lifecycleStatus === "failed",
    );
    expect(failed).toMatchObject({
      semanticStatus: "failed",
      resolvedStatus: "failed",
      evidence: "semantic",
    });
    const source = readWorkerTaskSource(failed.route.sessionFile, spawned.taskId);
    expect(source.state.startedTaskIds.has(spawned.taskId)).toBe(true);
    expect(source.task.status).toBe("failed");
    const finalRoute = await waitFor(
      () => item.registry.resolveTask(spawned.taskId),
      (value) => value?.exitCode === 0,
    );
    expect(finalRoute?.exitCode).toBe(0);
  }, 20_000);

  it("supports agents without summaries but hard-errors required summary injection", async () => {
    const item = await fixture({ features: { ...config.features, summaries: false } });
    await expect(item.coordinator.spawn(
      { task: "invalid required summary", requiredContext: [randomUUID()], availableContext: [] },
      spawnContext(item),
    )).rejects.toThrow("required_context is unavailable when summaries are disabled");
    expect(item.launcher.specs).toEqual([]);

    const spawned = await item.coordinator.spawn(
      { task: "traditional subagent", requiredContext: [], availableContext: [] },
      spawnContext(item),
    );
    const route = (await item.registry.resolveTask(spawned.taskId))!;
    const worker = SessionManager.open(route.sessionFile);
    const append = appendTo(worker);
    append({ type: "task_started", at: Date.now(), taskId: spawned.taskId });
    append({
      type: "task_completed",
      at: Date.now(),
      taskId: spawned.taskId,
      endAnchor: { sessionId: route.sessionId, entryId: worker.getLeafId(), boundary: "after" },
    });
    await item.registry.updateWorker(route.workerId, { status: "running" });
    item.launcher.finish(0, { exitCode: 0, signal: null, stderr: "" });
    const joined = await item.coordinator.join([spawned.taskId], "all");
    expect(joined.completed).toEqual([{
      task_id: spawned.taskId,
      task: "traditional subagent",
      status: "completed",
      summary_retained: false,
      evidence: "semantic",
    }]);
  });
});
