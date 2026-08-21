import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope, type TaskEvent } from "../src/model/events.js";
import type { WorkerRoute, WorkerShutdownReport } from "../src/model/worker.js";
import type { RunRegistry } from "../src/store/run-registry.js";
import { FileRunRegistry } from "../src/store/run-registry.js";
import { LocalTaskRuntime } from "../src/store/task-runtime.js";
import {
  AsyncWorkerCoordinator,
  WorkerTaskRouter,
  type WorkerSpawnStage,
} from "../src/workers/coordinator.js";
import type {
  WorkerProcessExit,
  WorkerProcessHandle,
  WorkerProcessLauncher,
  WorkerProcessSpec,
} from "../src/workers/process.js";

const baseConfig: Config = {
  features: { tasks: true, summaries: true, compaction: false, agents: true },
  limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
  shutdown: { workerDrainMs: 0, workerTermGraceMs: 100, workerKillGraceMs: 50 },
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition did not become true");
}

class ControlledHandle implements WorkerProcessHandle {
  readonly signals: NodeJS.Signals[] = [];
  private readonly exit = deferred<WorkerProcessExit>();
  private settled = false;

  constructor(
    readonly pid: number,
    private readonly exitOn: "manual" | "SIGTERM" | "SIGKILL" = "manual",
    private readonly signalResult: boolean | Error = true,
  ) {}

  wait(): Promise<WorkerProcessExit> {
    return this.exit.promise;
  }

  terminate(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.signalResult instanceof Error) throw this.signalResult;
    if (this.exitOn === signal) this.finish({ exitCode: null, signal, stderr: "" });
    return this.signalResult;
  }

  finish(exit: WorkerProcessExit = { exitCode: 0, signal: null, stderr: "" }): void {
    if (this.settled) return;
    this.settled = true;
    this.exit.resolve(exit);
  }

  fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.exit.reject(error);
  }
}

class ControlledLauncher implements WorkerProcessLauncher {
  readonly specs: WorkerProcessSpec[] = [];
  readonly handles: ControlledHandle[] = [];
  readonly calls: Array<{ signal?: AbortSignal }> = [];
  returnGate?: Deferred<void>;

  constructor(
    private readonly exitOn: "manual" | "SIGTERM" | "SIGKILL" = "manual",
    private readonly signalResult: boolean | Error = true,
  ) {}

  async launch(spec: WorkerProcessSpec, signal?: AbortSignal): Promise<WorkerProcessHandle> {
    this.specs.push(spec);
    this.calls.push({ ...(signal ? { signal } : {}) });
    const handle = new ControlledHandle(50_000 + this.handles.length, this.exitOn, this.signalResult);
    this.handles.push(handle);
    await this.returnGate?.promise;
    return handle;
  }
}

function appendTo(manager: SessionManager) {
  return (event: TaskEvent): string => manager.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope(event));
}

function wrapRegistry(base: RunRegistry, overrides: Partial<RunRegistry>): RunRegistry {
  return new Proxy(base, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property, overrides) as unknown;
      if (override !== undefined) return typeof override === "function" ? override.bind(overrides) : override;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

interface FixtureOptions {
  config?: Partial<Config>;
  launcher?: ControlledLauncher;
  registry?: (base: FileRunRegistry) => RunRegistry;
  bootstrap?: {
    workerId: string;
    taskId: string;
    sessionId: string;
    sessionFile: string;
    spawningSessionId: string;
    agentDepth: number;
  };
  coordinatorId?: string;
  waitFor?: (promises: readonly Promise<unknown>[], timeoutMs: number) => Promise<void>;
  onSpawnStage?: (stage: WorkerSpawnStage, signal: AbortSignal) => Promise<void> | void;
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "task-worker-shutdown-"));
  const baseRegistry = await FileRunRegistry.create({ root: join(directory, "run") });
  const registry = options.registry?.(baseRegistry) ?? baseRegistry;
  const parentFile = join(directory, "parent.jsonl");
  await writeFile(parentFile, "", { mode: 0o600 });
  const parent = SessionManager.open(parentFile, directory, directory);
  const config: Config = {
    features: { ...baseConfig.features, ...options.config?.features },
    limits: { ...baseConfig.limits, ...options.config?.limits },
    shutdown: { ...baseConfig.shutdown, ...options.config?.shutdown },
  };
  const runtime = new LocalTaskRuntime(config);
  const router = new WorkerTaskRouter(registry, parent.getSessionId(), options.bootstrap ? {
    schemaVersion: 1,
    runId: registry.runId,
    runDirectory: registry.directory,
    task: "own assigned task",
    parentTaskId: null,
    requiredContext: [],
    availableContext: [],
    ...options.bootstrap,
  } : undefined);
  const launcher = options.launcher ?? new ControlledLauncher();
  const ids = Array.from({ length: 20 }, () => randomUUID());
  const coordinator = new AsyncWorkerCoordinator({
    config,
    registry,
    runtime,
    router,
    launcher,
    ownerSessionId: options.bootstrap?.sessionId ?? parent.getSessionId(),
    coordinatorId: options.coordinatorId ?? randomUUID(),
    extensionPath: join(directory, "task-framework.ts"),
    createId: () => ids.shift()!,
    ...(options.bootstrap ? {
      bootstrap: {
        schemaVersion: 1,
        runId: registry.runId,
        runDirectory: registry.directory,
        task: "own assigned task",
        parentTaskId: null,
        requiredContext: [],
        availableContext: [],
        ...options.bootstrap,
      },
    } : {}),
    ...(options.waitFor ? { waitFor: options.waitFor } : {}),
    ...(options.onSpawnStage ? { onSpawnStage: options.onSpawnStage } : {}),
  });
  const context = {
    cwd: directory,
    sessionId: coordinator.ownerSessionId,
    sessionFile: parentFile,
    append: appendTo(parent),
    projectTrusted: true,
  };
  return { directory, baseRegistry, registry, parent, config, runtime, router, launcher, coordinator, context };
}

async function spawnOne(item: Awaited<ReturnType<typeof fixture>>) {
  return item.coordinator.spawn(
    { task: "unjoined worker", requiredContext: [], availableContext: [] },
    item.context,
  );
}

function route(
  registry: RunRegistry,
  values: Partial<WorkerRoute> & Pick<WorkerRoute, "workerId" | "taskId" | "sessionId" | "spawningSessionId">,
): WorkerRoute {
  return {
    schemaVersion: 1,
    runId: registry.runId,
    sessionFile: join(registry.directory, `${values.sessionId}.jsonl`),
    parentTaskId: null,
    status: "starting",
    ...values,
  };
}

function report(registry: RunRegistry, coordinatorId: string = randomUUID()): WorkerShutdownReport {
  return {
    schemaVersion: 1,
    runId: registry.runId,
    sessionId: randomUUID(),
    coordinatorId,
    reason: "quit",
    startedAt: 1,
    endedAt: 2,
    status: "complete",
    directWorkerCount: 0,
    naturalExitCount: 0,
    sigtermRequestedCount: 0,
    sigkillRequestedCount: 0,
    monitorFailureCount: 0,
    activeOwnedRouteCount: 0,
    activeDescendantRouteCount: 0,
    activeUnmanagedRouteCount: 0,
    remainingOwnedLeaseCount: 0,
    unsettledSpawnCount: 0,
    survivingHandleCount: 0,
    diagnostics: [],
  };
}

function shutdown(
  item: Awaited<ReturnType<typeof fixture>>,
  reason: "quit" | "reload" | "new" | "resume" | "fork",
) {
  return item.coordinator.shutdown({ reason, sessionId: item.coordinator.ownerSessionId });
}

describe("worker shutdown coordinator", () => {
  it("persists one complete zero-worker report for repeated and concurrent shutdown", async () => {
    const item = await fixture({ coordinatorId: "coordinator-zero" });
    const first = shutdown(item, "quit");
    const second = shutdown(item, "reload");
    expect(second).toBe(first);
    const result = await first;
    expect(result).toMatchObject({
      coordinatorId: "coordinator-zero",
      reason: "quit",
      status: "complete",
      directWorkerCount: 0,
      survivingHandleCount: 0,
    });
    expect(await item.registry.listShutdownReports()).toEqual([result]);
  });

  it("rejects spawn after the synchronous shutdown gate without acquiring state", async () => {
    const item = await fixture();
    await shutdown(item, "quit");
    await expect(spawnOne(item)).rejects.toThrow("shutting down");
    expect(await item.registry.listWorkers()).toEqual([]);
    expect(await item.registry.listLeaseWorkerIds()).toEqual([]);
    expect(item.launcher.specs).toEqual([]);
  });

  it("rejects a shutdown request from another session without closing the coordinator", async () => {
    const item = await fixture();
    await expect(item.coordinator.shutdown({ reason: "quit", sessionId: "wrong-session" }))
      .rejects.toThrow("belongs to session");
    expect(item.coordinator.isClosing).toBe(false);
    expect((await shutdown(item, "quit")).status).toBe("complete");
  });

  it.each([
    "context_prepared",
    "lease_acquired",
    "source_created",
    "bootstrap_written",
    "route_registered",
    "launch_start",
    "handle_returned",
    "pid_recorded",
  ] satisfies WorkerSpawnStage[])("settles a shutdown race at %s without losing state", async (stage) => {
    const gate = deferred<void>();
    let entered = false;
    const launcher = new ControlledLauncher("SIGTERM");
    const item = await fixture({
      launcher,
      onSpawnStage: async (current) => {
        if (current !== stage) return;
        entered = true;
        await gate.promise;
      },
    });
    const spawning = spawnOne(item);
    await until(() => entered);
    const barrier = shutdown(item, "quit");
    gate.resolve();
    await expect(spawning).rejects.toThrow("shutdown");
    const result = await barrier;
    expect(result.status).toBe("complete");
    expect(await item.registry.listLeaseWorkerIds()).toEqual([]);
    expect((await item.registry.listWorkers()).every(
      (worker) => worker.status !== "starting" && worker.status !== "running",
    )).toBe(true);
    const processCreated = stage === "handle_returned" || stage === "pid_recorded";
    expect(launcher.handles).toHaveLength(processCreated ? 1 : 0);
    if (processCreated) expect(launcher.handles[0]!.signals).toEqual(["SIGTERM"]);
  });

  it("allows a natural exit during drain without signaling it", async () => {
    const launcher = new ControlledLauncher("manual");
    const item = await fixture({
      launcher,
      config: { shutdown: { workerDrainMs: 100, workerTermGraceMs: 100, workerKillGraceMs: 50 } },
    });
    await spawnOne(item);
    queueMicrotask(() => launcher.handles[0]!.finish({ exitCode: 1, signal: null, stderr: "" }));
    const result = await shutdown(item, "quit");
    expect(result).toMatchObject({
      status: "complete",
      naturalExitCount: 1,
      sigtermRequestedCount: 0,
      sigkillRequestedCount: 0,
    });
    expect(launcher.handles[0]!.signals).toEqual([]);
  });

  it("keeps worker stderr out of the shutdown report", async () => {
    const launcher = new ControlledLauncher("manual");
    const item = await fixture({
      launcher,
      config: { shutdown: { workerDrainMs: 100, workerTermGraceMs: 100, workerKillGraceMs: 50 } },
    });
    await spawnOne(item);
    launcher.handles[0]!.finish({ exitCode: 1, signal: null, stderr: "sensitive worker stderr" });
    const result = await shutdown(item, "quit");
    expect(result.status).toBe("complete");
    expect(JSON.stringify(result)).not.toContain("sensitive worker stderr");
  });

  it("awaits a worker that exits on one SIGTERM and does not escalate", async () => {
    const launcher = new ControlledLauncher("SIGTERM");
    const item = await fixture({ launcher });
    const spawned = await spawnOne(item);
    const result = await shutdown(item, "new");
    expect(result).toMatchObject({
      status: "complete",
      directWorkerCount: 1,
      sigtermRequestedCount: 1,
      sigkillRequestedCount: 0,
      monitorFailureCount: 0,
    });
    expect(launcher.handles[0]!.signals).toEqual(["SIGTERM"]);
    expect((await item.registry.resolveTask(spawned.taskId))?.status).toBe("failed");
    expect(await item.registry.listLeaseWorkerIds()).toEqual([]);
  });

  it("escalates a SIGTERM-ignoring worker exactly once to SIGKILL", async () => {
    let waitCall = 0;
    const launcher = new ControlledLauncher("SIGKILL");
    const item = await fixture({
      launcher,
      waitFor: async (promises) => {
        waitCall += 1;
        if (waitCall === 1) return;
        await Promise.allSettled(promises);
      },
    });
    await spawnOne(item);
    const result = await shutdown(item, "quit");
    expect(result).toMatchObject({ status: "complete", sigtermRequestedCount: 1, sigkillRequestedCount: 1 });
    expect(launcher.handles[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails closed when a process signal is rejected", async () => {
    const launcher = new ControlledLauncher("SIGTERM", false);
    const item = await fixture({ launcher });
    await spawnOne(item);
    const shutdown = item.coordinator.shutdown({ reason: "quit", sessionId: item.coordinator.ownerSessionId });
    launcher.handles[0]!.finish({ exitCode: null, signal: "SIGTERM", stderr: "" });
    const result = await shutdown;
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining("returned false")]));
  });

  it("retains and terminates a handle returned after shutdown starts", async () => {
    const launcher = new ControlledLauncher("SIGTERM");
    launcher.returnGate = deferred<void>();
    const item = await fixture({ launcher });
    const spawning = spawnOne(item);
    await until(() => launcher.handles.length === 1);
    const shutdown = item.coordinator.shutdown({ reason: "fork", sessionId: item.coordinator.ownerSessionId });
    launcher.returnGate.resolve();
    await expect(spawning).rejects.toThrow("shutdown");
    const result = await shutdown;
    expect(result).toMatchObject({ status: "complete", directWorkerCount: 1, sigtermRequestedCount: 1 });
    expect(launcher.handles[0]!.signals).toEqual(["SIGTERM"]);
    expect(await item.registry.listLeaseWorkerIds()).toEqual([]);
  });

  it("rolls back a spawn paused at lease acquisition before process creation", async () => {
    const gate = deferred<void>();
    let entered = false;
    let baseRegistry!: FileRunRegistry;
    const item = await fixture({
      registry: (base) => {
        baseRegistry = base;
        return wrapRegistry(base, {
          async acquireLease(workerId, limit) {
            entered = true;
            await gate.promise;
            await base.acquireLease(workerId, limit);
          },
        });
      },
    });
    const spawning = spawnOne(item);
    await until(() => entered);
    const shutdown = item.coordinator.shutdown({ reason: "quit", sessionId: item.coordinator.ownerSessionId });
    gate.resolve();
    await expect(spawning).rejects.toThrow("shutdown");
    expect((await shutdown).status).toBe("complete");
    expect(item.launcher.specs).toEqual([]);
    expect(await baseRegistry.listWorkers()).toEqual([]);
    expect(await baseRegistry.listLeaseWorkerIds()).toEqual([]);
  });

  it("fails closed when pre-launch rollback cannot release its owned lease", async () => {
    const gate = deferred<void>();
    let entered = false;
    let baseRegistry!: FileRunRegistry;
    const item = await fixture({
      registry: (base) => {
        baseRegistry = base;
        return wrapRegistry(base, {
          async releaseLease() {
            throw new Error("rollback release failed");
          },
        });
      },
      onSpawnStage: async (stage) => {
        if (stage !== "lease_acquired") return;
        entered = true;
        await gate.promise;
      },
    });
    const spawning = spawnOne(item);
    await until(() => entered);
    const barrier = shutdown(item, "quit");
    gate.resolve();
    await expect(spawning).rejects.toThrow("shutdown");
    const result = await barrier;
    expect(result.status).toBe("failed");
    expect(result.remainingOwnedLeaseCount).toBe(1);
    expect(result.diagnostics.join(" ")).toContain("Spawn rollback lease release failed");
    expect(await baseRegistry.listLeaseWorkerIds()).toHaveLength(1);
  });

  it("waits for route finalization and lease release before completing", async () => {
    const routeGate = deferred<void>();
    const leaseGate = deferred<void>();
    let routeBlocked = false;
    let leaseBlocked = false;
    const launcher = new ControlledLauncher("SIGTERM");
    let baseRegistry!: FileRunRegistry;
    const item = await fixture({
      launcher,
      registry: (base) => {
        baseRegistry = base;
        return wrapRegistry(base, {
          async updateWorker(workerId, patch) {
            if (patch.exitedAt !== undefined) {
              routeBlocked = true;
              await routeGate.promise;
            }
            return base.updateWorker(workerId, patch);
          },
          async releaseLease(workerId) {
            leaseBlocked = true;
            await leaseGate.promise;
            return base.releaseLease(workerId);
          },
        });
      },
    });
    await spawnOne(item);
    let settled = false;
    const shutdown = item.coordinator.shutdown({
      reason: "quit",
      sessionId: item.coordinator.ownerSessionId,
    }).then((value) => {
      settled = true;
      return value;
    });
    await until(() => routeBlocked);
    expect(settled).toBe(false);
    routeGate.resolve();
    await until(() => leaseBlocked);
    expect(settled).toBe(false);
    leaseGate.resolve();
    expect((await shutdown).status).toBe("complete");
    expect(await baseRegistry.listLeaseWorkerIds()).toEqual([]);
  });

  it("reports route-finalization and lease-release failures", async () => {
    for (const failure of ["route", "lease"] as const) {
      const launcher = new ControlledLauncher("SIGTERM");
      const item = await fixture({
        launcher,
        registry: (base) => wrapRegistry(base, failure === "route" ? {
          async updateWorker(workerId, patch) {
            if (patch.exitedAt !== undefined) throw new Error("route write failed");
            return base.updateWorker(workerId, patch);
          },
        } : {
          async releaseLease() {
            throw new Error("lease release failed");
          },
        }),
      });
      await spawnOne(item);
      const result = await shutdown(item, "quit");
      expect(result.status).toBe("failed");
      expect(result.monitorFailureCount).toBe(1);
      expect(result.diagnostics.join(" ")).toContain(`${failure} `);
    }
  });

  it("reports a rejected process wait as a monitor failure", async () => {
    const launcher = new ControlledLauncher();
    const item = await fixture({ launcher });
    await spawnOne(item);
    launcher.handles[0]!.fail(new Error("wait failed"));
    const result = await shutdown(item, "quit");
    expect(result.status).toBe("failed");
    expect(result.monitorFailureCount).toBe(1);
    expect(result.diagnostics.join(" ")).toContain("process wait failed: wait failed");
  });

  it("fails an active owned route without a retained handle and never signals its PID", async () => {
    const coordinatorId = randomUUID();
    const item = await fixture({ coordinatorId });
    const workerId = randomUUID();
    await item.registry.registerWorker(route(item.registry, {
      workerId,
      taskId: randomUUID(),
      sessionId: randomUUID(),
      spawningSessionId: item.coordinator.ownerSessionId,
      spawningCoordinatorId: coordinatorId,
      pid: process.pid,
    }));
    await item.registry.acquireLease(workerId, 4);
    const result = await shutdown(item, "quit");
    expect(result).toMatchObject({
      status: "failed",
      directWorkerCount: 0,
      activeOwnedRouteCount: 1,
      activeUnmanagedRouteCount: 1,
      remainingOwnedLeaseCount: 1,
    });
    expect(item.launcher.handles).toEqual([]);
  });

  it("audits transitive descendants while nested coordinators ignore ancestors and siblings", async () => {
    const rootSession = randomUUID();
    const childSession = randomUUID();
    const siblingSession = randomUUID();
    const grandchildSession = randomUUID();
    const rootCoordinatorId = randomUUID();
    const nestedCoordinatorId = randomUUID();
    const item = await fixture({ coordinatorId: rootCoordinatorId });
    const rootOwned = route(item.registry, {
      workerId: randomUUID(),
      taskId: randomUUID(),
      sessionId: childSession,
      spawningSessionId: item.coordinator.ownerSessionId,
      spawningCoordinatorId: rootCoordinatorId,
      status: "completed",
    });
    const sibling = route(item.registry, {
      workerId: randomUUID(),
      taskId: randomUUID(),
      sessionId: siblingSession,
      spawningSessionId: item.coordinator.ownerSessionId,
      spawningCoordinatorId: rootCoordinatorId,
      status: "running",
    });
    const descendant = route(item.registry, {
      workerId: randomUUID(),
      taskId: randomUUID(),
      sessionId: grandchildSession,
      spawningSessionId: childSession,
      spawningCoordinatorId: nestedCoordinatorId,
      status: "running",
    });
    await item.registry.registerWorker(rootOwned);
    await item.registry.registerWorker(sibling);
    await item.registry.registerWorker(descendant);

    const nested = await fixture({
      coordinatorId: nestedCoordinatorId,
      registry: () => item.registry,
      bootstrap: {
        workerId: rootOwned.workerId,
        taskId: rootOwned.taskId,
        sessionId: childSession,
        sessionFile: rootOwned.sessionFile,
        spawningSessionId: rootSession,
        agentDepth: 1,
      },
    });
    const nestedReport = await shutdown(nested, "quit");
    expect(nestedReport).toMatchObject({
      status: "failed",
      activeOwnedRouteCount: 1,
      activeUnmanagedRouteCount: 1,
    });

    await item.registry.updateWorker(descendant.workerId, { status: "completed" });
    const nestedClean = await fixture({
      coordinatorId: randomUUID(),
      registry: () => item.registry,
      bootstrap: {
        workerId: rootOwned.workerId,
        taskId: rootOwned.taskId,
        sessionId: childSession,
        sessionFile: rootOwned.sessionFile,
        spawningSessionId: rootSession,
        agentDepth: 1,
      },
    });
    expect((await shutdown(nestedClean, "quit")).status).toBe("complete");

    const rootReport = await shutdown(item, "quit");
    expect(rootReport).toMatchObject({
      status: "failed",
      activeOwnedRouteCount: 1,
      activeUnmanagedRouteCount: 1,
    });
  });
});

describe("worker shutdown registry", () => {
  it("lists leases and persists non-overwriting private reports across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-worker-shutdown-registry-"));
    const registry = await FileRunRegistry.create({ root: join(directory, "run") });
    const workerIds = [randomUUID(), randomUUID()].sort();
    for (const workerId of workerIds) await registry.acquireLease(workerId, 2);
    expect(await registry.listLeaseWorkerIds()).toEqual(workerIds);
    const value = report(registry, "report-owner");
    await registry.writeShutdownReport(value);
    await expect(registry.writeShutdownReport(value)).rejects.toMatchObject({ code: "EEXIST" });
    const reopened = await FileRunRegistry.open(registry.directory);
    expect(await reopened.readShutdownReport("report-owner")).toEqual(value);
    expect(await reopened.listShutdownReports(value.sessionId)).toEqual([value]);
    expect((await lstat(join(registry.directory, "shutdowns"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(registry.directory, "shutdowns", "report-owner.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed, mismatched, and symlinked report records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-worker-shutdown-registry-invalid-"));
    const registry = await FileRunRegistry.create({ root: join(directory, "run") });
    const malformed = report(registry, "malformed");
    malformed.diagnostics = ["x".repeat(513)];
    await expect(registry.writeShutdownReport(malformed)).rejects.toThrow("malformed");
    const mismatched = { ...report(registry, "wrong-run"), runId: randomUUID() };
    await expect(registry.writeShutdownReport(mismatched)).rejects.toThrow("another run");

    const target = join(directory, "target.json");
    await writeFile(target, JSON.stringify(report(registry, "linked")));
    await symlink(target, join(registry.directory, "shutdowns", "linked.json"));
    await expect(registry.readShutdownReport("linked")).rejects.toThrow("not a real file");

    const onDisk = report(registry, "filename-mismatch");
    await writeFile(join(registry.directory, "shutdowns", "different.json"), `${JSON.stringify(onDisk)}\n`);
    await expect(registry.listShutdownReports()).rejects.toThrow("filename does not match");
    expect(await readFile(target, "utf8")).toContain("linked");
  });
});
