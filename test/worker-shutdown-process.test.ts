import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope, type TaskEvent } from "../src/model/events.js";
import { FileRunRegistry } from "../src/store/run-registry.js";
import { LocalTaskRuntime } from "../src/store/task-runtime.js";
import { AsyncWorkerCoordinator, WorkerTaskRouter } from "../src/workers/coordinator.js";
import { NodeWorkerProcessLauncher, type WorkerProcessLauncher } from "../src/workers/process.js";

const config: Config = {
  features: { tasks: true, summaries: true, compaction: false, agents: true },
  limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
  shutdown: { workerDrainMs: 0, workerTermGraceMs: 750, workerKillGraceMs: 250 },
};

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for nested worker state");
}

async function existingFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function writeNestedExtension(directory: string, ignoreGrandchildTerm: boolean): Promise<string> {
  const extension = join(directory, ignoreGrandchildTerm ? "nested-force-extension.ts" : "nested-extension.ts");
  const configPath = join(process.cwd(), "src", "config.ts");
  const eventsPath = join(process.cwd(), "src", "model", "events.ts");
  const registryPath = join(process.cwd(), "src", "store", "run-registry.ts");
  const frameworkPath = join(process.cwd(), "src", "task-framework.ts");
  const bootstrapPath = join(process.cwd(), "src", "workers", "bootstrap.ts");
  const coordinatorPath = join(process.cwd(), "src", "workers", "coordinator.ts");
  const bashToolPath = join(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "core",
    "tools",
    "bash.js",
  );
  await writeFile(
    extension,
    `import { appendFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { createLocalBashOperations } from ${JSON.stringify(bashToolPath)};\n` +
      `import { registerConfigFlags, resolveConfig } from ${JSON.stringify(configPath)};\n` +
      `import { TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope } from ${JSON.stringify(eventsPath)};\n` +
      `import { FileRunRegistry } from ${JSON.stringify(registryPath)};\n` +
      `import { registerTaskFramework } from ${JSON.stringify(frameworkPath)};\n` +
      `import { loadWorkerBootstrap } from ${JSON.stringify(bootstrapPath)};\n` +
      `import { spawnExecutionContext } from ${JSON.stringify(coordinatorPath)};\n` +
      `const extensionPath = ${JSON.stringify(extension)};\n` +
      `const ignoreGrandchildTerm = ${JSON.stringify(ignoreGrandchildTerm)};\n` +
      `export default function nestedTestExtension(pi) {\n` +
      `  registerConfigFlags(pi);\n` +
      `  const bootstrapPromise = loadWorkerBootstrap();\n` +
      `  let initialized = false;\n` +
      `  let services;\n` +
      `  let bootstrap;\n` +
      `  let spawned = false;\n` +
      `  let heartbeat;\n` +
      `  let shellStarted = false;\n` +
      `  pi.on("session_start", async (_event, ctx) => {\n` +
      `    if (!initialized) {\n` +
      `      bootstrap = await bootstrapPromise;\n` +
      `      if (!bootstrap) throw new Error("nested test worker requires bootstrap");\n` +
      `      const config = resolveConfig({ cwd: ctx.cwd, getFlag: (name) => pi.getFlag(name) });\n` +
      `      const registry = await FileRunRegistry.open(bootstrap.runDirectory);\n` +
      `      services = registerTaskFramework(pi, config, {\n` +
      `        registerSessionStart: false,\n` +
      `        agents: { registry, localSessionId: ctx.sessionManager.getSessionId(), bootstrap, extensionPath },\n` +
      `      });\n` +
      `      initialized = true;\n` +
      `    }\n` +
      `    await services.startSession(ctx);\n` +
      `    if (!heartbeat) {\n` +
      `      const path = join(ctx.cwd, "worker-heartbeat.log");\n` +
      `      heartbeat = setInterval(() => appendFileSync(path, process.pid + ":" + Date.now() + "\\n"), 20);\n` +
      `    }\n` +
      `    if (bootstrap.agentDepth === 1 && !shellStarted) {\n` +
      `      shellStarted = true;\n` +
      `      const shell = createLocalBashOperations();\n` +
      `      void shell.exec(\n` +
      `        "echo $$ > tracked-shell.pid; while true; do printf x >> tracked-shell-heartbeat.log; sleep 0.02; done",\n` +
      `        ctx.cwd,\n` +
      `        { onData: () => {} },\n` +
      `      ).catch(() => {});\n` +
      `    }\n` +
      `    if (ignoreGrandchildTerm && bootstrap.agentDepth === 2) {\n` +
      `      process.removeAllListeners("SIGTERM");\n` +
      `      process.on("SIGTERM", () => {});\n` +
      `    }\n` +
      `    if (bootstrap.agentDepth === 1 && !spawned) {\n` +
      `      spawned = true;\n` +
      `      const append = (event) => ctx.sessionManager.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope(event));\n` +
      `      const { model: _model, ...nestedContext } = spawnExecutionContext(ctx, append);\n` +
      `      await services.agents.coordinator.spawn(\n` +
      `        { task: "nested grandchild", requiredContext: [], availableContext: [] },\n` +
      `        nestedContext,\n` +
      `      );\n` +
      `    }\n` +
      `  });\n` +
      `  pi.on("input", async () => {\n` +
      `    await new Promise(() => {});\n` +
      `    return { action: "handled" };\n` +
      `  });\n` +
      `}\n`,
    { mode: 0o600 },
  );
  return extension;
}

async function runCascade(ignoreGrandchildTerm: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "task-worker-shutdown-process-"));
  const registry = await FileRunRegistry.create({ root: join(directory, "run") });
  const parentFile = join(directory, "parent.jsonl");
  await writeFile(parentFile, "", { mode: 0o600 });
  const parent = SessionManager.open(parentFile, directory, directory);
  const runtime = new LocalTaskRuntime(config);
  const router = new WorkerTaskRouter(registry, parent.getSessionId());
  const cli = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const processLauncher = new NodeWorkerProcessLauncher({
    invocation: { command: process.execPath, prefixArgs: [cli] },
  });
  const agentDirectory = join(directory, "pi-agent");
  await mkdir(agentDirectory, { recursive: true });
  const launcher: WorkerProcessLauncher = {
    launch: (spec, signal) => processLauncher.launch({
      ...spec,
      environment: { ...spec.environment, PI_CODING_AGENT_DIR: agentDirectory },
    }, signal),
  };
  const extensionPath = await writeNestedExtension(directory, ignoreGrandchildTerm);
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const coordinator = new AsyncWorkerCoordinator({
    config,
    registry,
    runtime,
    router,
    launcher,
    ownerSessionId: parent.getSessionId(),
    extensionPath,
    createId: () => ids.shift()!,
  });
  try {
    const append = (event: TaskEvent) => parent.appendCustomEntry(TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope(event));
    const spawned = await coordinator.spawn(
      { task: "nested child", requiredContext: [], availableContext: [] },
      {
        cwd: directory,
        sessionId: parent.getSessionId(),
        sessionFile: parentFile,
        append,
        projectTrusted: true,
      },
    );
    let latestRoutes = await registry.listWorkers();
    const activeRoutes = await waitFor(
      async () => {
        latestRoutes = await registry.listWorkers();
        if (latestRoutes.some((route) => route.status === "failed" || route.status === "cancelled")) {
          throw new Error(`Nested worker exited before startup: ${JSON.stringify(latestRoutes)}`);
        }
        return latestRoutes;
      },
      (routes) => routes.length === 2 && routes.every((route) => route.status === "running" && route.pid !== undefined),
    );
    expect(activeRoutes.find((route) => route.taskId === spawned.taskId)).toBeDefined();
    const pids = activeRoutes.map((route) => route.pid!);
    expect(pids.every(processExists)).toBe(true);
    const heartbeatPath = join(directory, "worker-heartbeat.log");
    const shellHeartbeatPath = join(directory, "tracked-shell-heartbeat.log");
    const shellPidPath = join(directory, "tracked-shell.pid");
    const liveState = await waitFor(
      async () => ({
        workerHeartbeatSize: await existingFileSize(heartbeatPath),
        shellHeartbeatSize: await existingFileSize(shellHeartbeatPath),
        shellPid: await readFile(shellPidPath, "utf8").then((value) => value.trim(), () => ""),
      }),
      (state) => state.workerHeartbeatSize > 0 && state.shellHeartbeatSize > 0 && state.shellPid !== "",
    );
    const shellPid = Number(liveState.shellPid);
    expect(Number.isSafeInteger(shellPid) && shellPid > 0).toBe(true);
    expect(processExists(shellPid)).toBe(true);

    const rootReport = await coordinator.shutdown({
      reason: "quit",
      sessionId: coordinator.ownerSessionId,
    });
    const finalRoutes = await registry.listWorkers();
    const reports = await registry.listShutdownReports();
    const leases = await registry.listLeaseWorkerIds();
    const sizeAtReport = await existingFileSize(heartbeatPath);
    const shellSizeAtReport = await existingFileSize(shellHeartbeatPath);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sizeAfterDelay = await existingFileSize(heartbeatPath);
    const shellSizeAfterDelay = await existingFileSize(shellHeartbeatPath);

    return {
      directory,
      registry,
      rootReport,
      finalRoutes,
      reports,
      leases,
      pids,
      shellPid,
      shellSizeAtReport,
      shellSizeAfterDelay,
      sizeAtReport,
      sizeAfterDelay,
      heartbeat: await readFile(heartbeatPath, "utf8"),
    };
  } catch (error) {
    await coordinator.shutdown({ reason: "quit", sessionId: coordinator.ownerSessionId }).catch(() => undefined);
    throw error;
  }
}

describe("real nested worker shutdown cascade", () => {
  it("recursively terminates a child and grandchild before the root report completes", async () => {
    const result = await runCascade(false);
    expect(result.rootReport).toMatchObject({
      status: "complete",
      directWorkerCount: 1,
      sigtermRequestedCount: 1,
      sigkillRequestedCount: 0,
      activeOwnedRouteCount: 0,
      activeDescendantRouteCount: 0,
      remainingOwnedLeaseCount: 0,
    });
    expect(result.reports).toHaveLength(3);
    expect(result.reports.every((report) => report.status === "complete")).toBe(true);
    expect(result.reports.reduce((count, report) => count + report.directWorkerCount, 0)).toBe(2);
    expect(result.finalRoutes.every((route) => route.status === "failed")).toBe(true);
    expect(result.leases).toEqual([]);
    expect(result.pids.some(processExists)).toBe(false);
    expect(processExists(result.shellPid)).toBe(false);
    expect(result.shellSizeAfterDelay).toBe(result.shellSizeAtReport);
    expect(result.sizeAfterDelay).toBe(result.sizeAtReport);
    expect(result.heartbeat.trim()).not.toBe("");
  }, 30_000);

  it("escalates an unresponsive grandchild to SIGKILL without leaving a process or write leak", async () => {
    const result = await runCascade(true);
    expect(result.rootReport.status).toBe("complete");
    expect(result.reports).toHaveLength(2);
    const childReport = result.reports.find((report) => report.directWorkerCount === 1 && report.coordinatorId !== result.rootReport.coordinatorId);
    expect(childReport).toMatchObject({
      status: "complete",
      sigtermRequestedCount: 1,
      sigkillRequestedCount: 1,
      survivingHandleCount: 0,
    });
    expect(result.finalRoutes.every((route) => route.status === "failed")).toBe(true);
    expect(result.leases).toEqual([]);
    expect(result.pids.some(processExists)).toBe(false);
    expect(processExists(result.shellPid)).toBe(false);
    expect(result.shellSizeAfterDelay).toBe(result.shellSizeAtReport);
    expect(result.sizeAfterDelay).toBe(result.sizeAtReport);
  }, 30_000);
});
