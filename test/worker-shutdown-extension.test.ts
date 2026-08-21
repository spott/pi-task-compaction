import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { WorkerRoute } from "../src/model/worker.js";
import { FileRunRegistry } from "../src/store/run-registry.js";
import {
  registerTaskFramework,
  WORKER_SHUTDOWN_CUSTOM_TYPE,
} from "../src/task-framework.js";
import type {
  WorkerProcessExit,
  WorkerProcessHandle,
  WorkerProcessLauncher,
  WorkerProcessSpec,
} from "../src/workers/process.js";
import { precreateWorkerTaskSource, readWorkerTaskSource } from "../src/workers/source.js";

const config: Config = {
  features: { tasks: true, summaries: true, compaction: false, agents: true },
  limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
  shutdown: { workerDrainMs: 0, workerTermGraceMs: 100, workerKillGraceMs: 50 },
};

class TerminatingLauncher implements WorkerProcessLauncher {
  readonly specs: WorkerProcessSpec[] = [];
  readonly signals: NodeJS.Signals[][] = [];

  async launch(spec: WorkerProcessSpec): Promise<WorkerProcessHandle> {
    const index = this.specs.length;
    this.specs.push(spec);
    this.signals.push([]);
    let finish!: (exit: WorkerProcessExit) => void;
    const exit = new Promise<WorkerProcessExit>((resolve) => { finish = resolve; });
    return {
      pid: 60_000 + index,
      wait: () => exit,
      terminate: (signal = "SIGTERM") => {
        this.signals[index]!.push(signal);
        finish({ exitCode: null, signal, stderr: "" });
        return true;
      },
    };
  }
}

interface Harness {
  handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => any>>;
  tools: Map<string, any>;
  pi: ExtensionAPI;
  setActive(manager: SessionManager): void;
  notifications: Array<{ message: string; level: string }>;
}

function harness(initial: SessionManager): Harness {
  let active = initial;
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const tools = new Map<string, any>();
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) { active.appendCustomEntry(customType, data); },
  } as unknown as ExtensionAPI;
  return {
    handlers,
    tools,
    pi,
    setActive(manager) { active = manager; },
    notifications,
  };
}

function context(directory: string, manager: SessionManager, notifications: Harness["notifications"]): ExtensionContext {
  return {
    cwd: directory,
    sessionManager: manager,
    ui: {
      setStatus() {},
      notify(message: string, level: string) { notifications.push({ message, level }); },
    },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

async function managerAt(directory: string, name: string): Promise<SessionManager> {
  const path = join(directory, `${name}.jsonl`);
  await writeFile(path, "", { mode: 0o600 });
  return SessionManager.open(path, directory, directory);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "task-worker-shutdown-extension-"));
  const manager = await managerAt(directory, "session-a");
  const registry = await FileRunRegistry.create({ root: join(directory, "run-a") });
  const launcher = new TerminatingLauncher();
  const test = harness(manager);
  const ctx = context(directory, manager, test.notifications);
  const services = registerTaskFramework(test.pi, config, {
    agents: {
      registry,
      localSessionId: manager.getSessionId(),
      launcher,
      openRegistry: async () => registry,
    },
  })!;
  return { directory, manager, registry, launcher, test, ctx, services };
}

function shutdownEntries(manager: SessionManager) {
  return manager.getBranch().filter(
    (entry) => entry.type === "custom" && entry.customType === WORKER_SHUTDOWN_CUSTOM_TYPE,
  );
}

describe("worker shutdown extension lifecycle", () => {
  it("registers a barrier with zero workers and appends the persisted report once", async () => {
    const item = await fixture();
    expect(item.test.handlers.get("session_shutdown")).toHaveLength(1);
    await item.test.handlers.get("session_start")![0]!({ type: "session_start" }, item.ctx);
    const handler = item.test.handlers.get("session_shutdown")![0]!;
    await Promise.all([
      handler({ type: "session_shutdown", reason: "quit" }, item.ctx),
      handler({ type: "session_shutdown", reason: "quit" }, item.ctx),
    ]);
    const entries = shutdownEntries(item.manager);
    expect(entries).toHaveLength(1);
    const persisted = await item.registry.listShutdownReports(item.manager.getSessionId());
    expect(persisted).toHaveLength(1);
    expect(entries[0]).toMatchObject({ data: persisted[0] });
    expect(persisted[0]).toMatchObject({
      reason: "quit",
      status: "complete",
      sessionId: item.manager.getSessionId(),
      directWorkerCount: 0,
    });
  });

  it.each(["quit", "reload", "new", "resume", "fork"] as const)(
    "forwards the %s shutdown reason to a complete report",
    async (reason) => {
      const item = await fixture();
      await item.test.handlers.get("session_start")![0]!({ type: "session_start" }, item.ctx);
      const coordinatorId = item.services.agents!.coordinator.coordinatorId;
      await item.test.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason }, item.ctx);
      expect(await item.registry.readShutdownReport(coordinatorId)).toMatchObject({
        reason,
        status: "complete",
        sessionId: item.manager.getSessionId(),
        coordinatorId,
      });
    },
  );

  it("persists and appends a failed report before surfacing the barrier error", async () => {
    const item = await fixture();
    await item.test.handlers.get("session_start")![0]!({ type: "session_start" }, item.ctx);
    await item.registry.registerWorker({
      schemaVersion: 1,
      workerId: randomUUID(),
      taskId: randomUUID(),
      runId: item.registry.runId,
      sessionId: randomUUID(),
      sessionFile: join(item.directory, "unmanaged.jsonl"),
      spawningSessionId: "another-session",
      parentTaskId: null,
      status: "running",
      pid: process.pid,
    });
    const coordinatorId = item.services.agents!.coordinator.coordinatorId;
    await expect(item.test.handlers.get("session_shutdown")![0]!(
      { type: "session_shutdown", reason: "quit" },
      item.ctx,
    )).rejects.toThrow(coordinatorId);
    expect(await item.registry.readShutdownReport(coordinatorId)).toMatchObject({
      status: "failed",
      activeUnmanagedRouteCount: 1,
    });
    expect(shutdownEntries(item.manager)).toHaveLength(1);
    expect(item.test.notifications).toEqual([
      expect.objectContaining({ message: expect.stringContaining("quiescence is unproven"), level: "error" }),
    ]);
  });

  it("re-arms a fresh destination-session coordinator and leaves the old one closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-worker-shutdown-rearm-"));
    const firstManager = await managerAt(directory, "first");
    const secondManager = await managerAt(directory, "second");
    const firstRegistry = await FileRunRegistry.create({ root: join(directory, "run-first") });
    const secondRegistry = await FileRunRegistry.create({ root: join(directory, "run-second") });
    const launcher = new TerminatingLauncher();
    const test = harness(firstManager);
    const opened: string[] = [];
    const services = registerTaskFramework(test.pi, config, {
      agents: {
        registry: firstRegistry,
        localSessionId: firstManager.getSessionId(),
        launcher,
        openRegistry: async (ctx) => {
          opened.push(ctx.sessionManager.getSessionId());
          return secondRegistry;
        },
      },
    })!;
    const firstCtx = context(directory, firstManager, test.notifications);
    const secondCtx = context(directory, secondManager, test.notifications);
    await test.handlers.get("session_start")![0]!({ type: "session_start" }, firstCtx);
    const oldCoordinator = services.agents!.coordinator;
    await test.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason: "new" }, firstCtx);
    expect(oldCoordinator.isClosing).toBe(true);

    test.setActive(secondManager);
    await test.handlers.get("session_start")![0]!({ type: "session_start" }, secondCtx);
    const fresh = services.agents!;
    expect(fresh.coordinator).not.toBe(oldCoordinator);
    expect(fresh.coordinator.coordinatorId).not.toBe(oldCoordinator.coordinatorId);
    expect(fresh.coordinator.ownerSessionId).toBe(secondManager.getSessionId());
    expect(fresh.registry).toBe(secondRegistry);
    expect(opened).toEqual([secondManager.getSessionId()]);
    await expect(oldCoordinator.spawn(
      { task: "stale", requiredContext: [], availableContext: [] },
      {
        cwd: directory,
        sessionId: firstManager.getSessionId(),
        sessionFile: firstManager.getSessionFile()!,
        append: () => "unused",
        projectTrusted: true,
      },
    )).rejects.toThrow("shutting down");

    const spawned = await fresh.coordinator.spawn(
      { task: "destination worker", requiredContext: [], availableContext: [] },
      {
        cwd: directory,
        sessionId: secondManager.getSessionId(),
        sessionFile: secondManager.getSessionFile()!,
        append: (event) => secondManager.appendCustomEntry("pi-task-framework/event", {
          schemaVersion: 1,
          event,
        }),
        projectTrusted: true,
      },
    );
    expect((await secondRegistry.resolveTask(spawned.taskId))?.spawningCoordinatorId).toBe(
      fresh.coordinator.coordinatorId,
    );
    await test.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason: "quit" }, secondCtx);
    expect(await firstRegistry.listShutdownReports(firstManager.getSessionId())).toHaveLength(1);
    expect(await secondRegistry.listShutdownReports(secondManager.getSessionId())).toHaveLength(1);
    expect(launcher.signals.at(-1)).toEqual(["SIGTERM"]);
  });

  it("creates non-overwriting coordinator reports when the same session and run resume", async () => {
    const item = await fixture();
    await item.test.handlers.get("session_start")![0]!({ type: "session_start" }, item.ctx);
    const first = item.services.agents!.coordinator;
    await item.test.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason: "resume" }, item.ctx);
    await item.test.handlers.get("session_start")![0]!({ type: "session_start" }, item.ctx);
    const second = item.services.agents!.coordinator;
    expect(second.coordinatorId).not.toBe(first.coordinatorId);
    await item.test.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason: "quit" }, item.ctx);
    const reports = await item.registry.listShutdownReports(item.manager.getSessionId());
    expect(reports.map((entry) => entry.coordinatorId).sort()).toEqual(
      [first.coordinatorId, second.coordinatorId].sort(),
    );
  });

  it("fails a resumed root barrier when an older coordinator leaves an active route", async () => {
    const item = await fixture();
    await item.test.handlers.get("session_start")![0]!({ type: "session_start" }, item.ctx);
    const first = item.services.agents!.coordinator;
    await item.test.handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason: "resume" }, item.ctx);
    await item.registry.registerWorker({
      schemaVersion: 1,
      workerId: randomUUID(),
      taskId: randomUUID(),
      runId: item.registry.runId,
      sessionId: randomUUID(),
      sessionFile: join(item.directory, "stale-worker.jsonl"),
      spawningSessionId: item.manager.getSessionId(),
      spawningCoordinatorId: first.coordinatorId,
      parentTaskId: null,
      status: "running",
      pid: process.pid,
    });
    await item.test.handlers.get("session_start")![0]!({ type: "session_start" }, item.ctx);
    const second = item.services.agents!.coordinator;
    await expect(item.test.handlers.get("session_shutdown")![0]!(
      { type: "session_shutdown", reason: "quit" },
      item.ctx,
    )).rejects.toThrow(second.coordinatorId);
    expect(await item.registry.readShutdownReport(second.coordinatorId)).toMatchObject({
      status: "failed",
      activeUnmanagedRouteCount: 1,
    });
    expect(await item.registry.listShutdownReports(item.manager.getSessionId())).toHaveLength(2);
  });

  it("runs nested-worker cleanup before assigned-root finalization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-worker-shutdown-order-"));
    const registry = await FileRunRegistry.create({ root: join(directory, "run") });
    const workerId = randomUUID();
    const taskId = randomUUID();
    const source = await precreateWorkerTaskSource({
      runDirectory: registry.directory,
      cwd: directory,
      workerId,
      taskId,
      task: "assigned root",
      parentTaskId: null,
      agentDepth: 1,
    });
    const workerRoute: WorkerRoute = {
      schemaVersion: 1,
      workerId,
      taskId,
      runId: registry.runId,
      sessionId: source.sessionId,
      sessionFile: source.sessionFile,
      spawningSessionId: "parent",
      spawningCoordinatorId: randomUUID(),
      parentTaskId: null,
      status: "starting",
    };
    await registry.registerWorker(workerRoute);
    await registry.acquireLease(workerId, 4);
    const manager = SessionManager.open(source.sessionFile);
    const test = harness(manager);
    const ctx = context(directory, manager, test.notifications);
    registerTaskFramework(test.pi, config, {
      agents: {
        registry,
        localSessionId: source.sessionId,
        bootstrap: {
          schemaVersion: 1,
          workerId,
          taskId,
          task: "assigned root",
          parentTaskId: null,
          agentDepth: 1,
          runId: registry.runId,
          runDirectory: registry.directory,
          sessionId: source.sessionId,
          sessionFile: source.sessionFile,
          spawningSessionId: "parent",
          requiredContext: [],
          availableContext: [],
        },
      },
    });
    await test.handlers.get("session_start")![0]!({ type: "session_start" }, ctx);
    const shutdown = test.handlers.get("session_shutdown")!;
    expect(shutdown).toHaveLength(2);
    await shutdown[0]!({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(readWorkerTaskSource(source.sessionFile, taskId).task.status).toBe("open");
    expect(await registry.listShutdownReports(source.sessionId)).toHaveLength(1);
    await shutdown[1]!({ type: "session_shutdown", reason: "quit" }, ctx);
    expect(readWorkerTaskSource(source.sessionFile, taskId).task.status).toBe("failed");
    expect((await registry.resolveWorker(workerId))?.status).toBe("failed");
    expect(await registry.listLeaseWorkerIds()).toEqual([]);
  });
});
