import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskId } from "../model/task.js";
import type { RunId, WorkerId, WorkerRoute } from "../model/worker.js";
import type { TaskSource } from "../transcript/source.js";

const RUN_SCHEMA_VERSION = 1;
const LOCK_RETRY_MS = 5;
const LOCK_ATTEMPTS = 1_000;

interface RunMetadata {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  runId: RunId;
  createdAt: number;
}

interface LeaseRecord {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  workerId: WorkerId;
  acquiredAt: number;
}

/** Routing and process lifecycle only; never semantic task state. */
export interface RunRegistry {
  readonly runId: RunId;
  readonly directory: string;
  resolveTaskSource(taskId: TaskId): Promise<TaskSource | undefined>;
  resolveTask(taskId: TaskId): Promise<WorkerRoute | undefined>;
  resolveWorker(workerId: WorkerId): Promise<WorkerRoute | undefined>;
  listWorkers(): Promise<WorkerRoute[]>;
  registerWorker(route: WorkerRoute): Promise<void>;
  updateWorker(workerId: WorkerId, patch: Partial<WorkerRoute>): Promise<WorkerRoute>;
  acquireLease(workerId: WorkerId, limit: number): Promise<void>;
  releaseLease(workerId: WorkerId): Promise<void>;
}

function assertDirectory(metadata: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Task-framework run path is not a real directory: ${path}`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    assertDirectory(await lstat(path), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    assertDirectory(await lstat(path), path);
  }
  await chmod(path, 0o700);
}

async function writePrivateJson(path: string, value: unknown, exclusive = false): Promise<void> {
  const bytes = `${JSON.stringify(value)}\n`;
  await ensurePrivateDirectory(dirname(path));
  if (exclusive) {
    const handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }

  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readPrivateJson<T>(path: string): Promise<T> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Task-framework run record is not a real file: ${path}`);
  }
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function validateRoute(value: unknown, runId: RunId): asserts value is WorkerRoute {
  if (typeof value !== "object" || value === null) throw new Error("Worker route is not an object");
  const route = value as Partial<WorkerRoute>;
  if (
    route.schemaVersion !== RUN_SCHEMA_VERSION ||
    route.runId !== runId ||
    typeof route.workerId !== "string" ||
    typeof route.taskId !== "string" ||
    typeof route.sessionId !== "string" ||
    typeof route.sessionFile !== "string" ||
    typeof route.spawningSessionId !== "string" ||
    (route.parentTaskId !== null && typeof route.parentTaskId !== "string") ||
    !["starting", "running", "completed", "failed", "cancelled"].includes(String(route.status))
  ) {
    throw new Error("Worker route is malformed or belongs to another run");
  }
}

function routeFilename(workerId: WorkerId): string {
  if (!/^[0-9a-f-]+$/iu.test(workerId)) throw new Error("worker ID contains unsafe path characters");
  return `${workerId}.json`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface FileRunRegistryCreateOptions {
  root?: string;
  runId?: RunId;
  now?: () => number;
}

/** Private, process-independent routing/liveness registry with atomic run-wide leases. */
export class FileRunRegistry implements RunRegistry {
  private constructor(
    readonly directory: string,
    readonly runId: RunId,
    private readonly now: () => number = Date.now,
  ) {}

  static async create(options: FileRunRegistryCreateOptions = {}): Promise<FileRunRegistry> {
    const runId = options.runId ?? randomUUID();
    const directory = options.root ?? join(tmpdir(), "pi-task-framework-runs", runId);
    await ensurePrivateDirectory(directory);
    await ensurePrivateDirectory(join(directory, "workers"));
    await ensurePrivateDirectory(join(directory, "leases"));
    const metadataPath = join(directory, "run.json");
    await writePrivateJson(metadataPath, {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId,
      createdAt: (options.now ?? Date.now)(),
    } satisfies RunMetadata, true).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const existing = await readPrivateJson<RunMetadata>(metadataPath);
      if (existing.schemaVersion !== RUN_SCHEMA_VERSION || existing.runId !== runId) {
        throw new Error(`Run directory already belongs to another run: ${directory}`);
      }
    });
    return new FileRunRegistry(directory, runId, options.now);
  }

  static async open(directory: string): Promise<FileRunRegistry> {
    assertDirectory(await lstat(directory), directory);
    const metadata = await readPrivateJson<RunMetadata>(join(directory, "run.json"));
    if (metadata.schemaVersion !== RUN_SCHEMA_VERSION || typeof metadata.runId !== "string") {
      throw new Error(`Unsupported task-framework run metadata: ${directory}`);
    }
    await ensurePrivateDirectory(join(directory, "workers"));
    await ensurePrivateDirectory(join(directory, "leases"));
    return new FileRunRegistry(directory, metadata.runId);
  }

  private routePath(workerId: WorkerId): string {
    return join(this.directory, "workers", routeFilename(workerId));
  }

  private leasePath(workerId: WorkerId): string {
    return join(this.directory, "leases", routeFilename(workerId));
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = join(this.directory, ".lock");
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(
          lockPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
        handle = undefined;
        try {
          return await operation();
        } finally {
          await rm(lockPath, { force: true });
        }
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new Error(`Timed out acquiring task-framework run lock: ${lockPath}`);
  }

  async registerWorker(route: WorkerRoute): Promise<void> {
    validateRoute(route, this.runId);
    await writePrivateJson(this.routePath(route.workerId), route, true);
  }

  async updateWorker(workerId: WorkerId, patch: Partial<WorkerRoute>): Promise<WorkerRoute> {
    return this.withLock(async () => {
      const current = await this.resolveWorker(workerId);
      if (!current) throw new Error(`Unknown worker: ${workerId}`);
      const updated: WorkerRoute = { ...current, ...patch, schemaVersion: RUN_SCHEMA_VERSION };
      if (
        updated.workerId !== current.workerId ||
        updated.taskId !== current.taskId ||
        updated.runId !== current.runId ||
        updated.sessionId !== current.sessionId ||
        updated.sessionFile !== current.sessionFile ||
        updated.spawningSessionId !== current.spawningSessionId ||
        updated.parentTaskId !== current.parentTaskId
      ) {
        throw new Error("Immutable worker routing fields cannot be changed");
      }
      validateRoute(updated, this.runId);
      await writePrivateJson(this.routePath(workerId), updated);
      return updated;
    });
  }

  async resolveWorker(workerId: WorkerId): Promise<WorkerRoute | undefined> {
    try {
      const route = await readPrivateJson<WorkerRoute>(this.routePath(workerId));
      validateRoute(route, this.runId);
      return route;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listWorkers(): Promise<WorkerRoute[]> {
    const names = (await readdir(join(this.directory, "workers")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    const routes: WorkerRoute[] = [];
    for (const name of names) {
      const route = await readPrivateJson<WorkerRoute>(join(this.directory, "workers", name));
      validateRoute(route, this.runId);
      routes.push(route);
    }
    return routes;
  }

  async resolveTask(taskId: TaskId): Promise<WorkerRoute | undefined> {
    const matches = (await this.listWorkers()).filter((route) => route.taskId === taskId);
    if (matches.length > 1) throw new Error(`Task ${taskId} has multiple worker routes`);
    return matches[0];
  }

  async resolveTaskSource(taskId: TaskId): Promise<TaskSource | undefined> {
    const route = await this.resolveTask(taskId);
    return route ? { sessionId: route.sessionId, sessionFile: route.sessionFile } : undefined;
  }

  async acquireLease(workerId: WorkerId, limit: number): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("concurrency limit must be positive");
    await this.withLock(async () => {
      const leases = (await readdir(join(this.directory, "leases"))).filter((name) => name.endsWith(".json"));
      if (leases.includes(routeFilename(workerId))) return;
      if (leases.length >= limit) {
        throw new Error(`Run ${this.runId} already has ${leases.length}/${limit} worker leases`);
      }
      await writePrivateJson(this.leasePath(workerId), {
        schemaVersion: RUN_SCHEMA_VERSION,
        workerId,
        acquiredAt: this.now(),
      } satisfies LeaseRecord, true);
    });
  }

  async releaseLease(workerId: WorkerId): Promise<void> {
    await rm(this.leasePath(workerId), { force: true });
  }
}
