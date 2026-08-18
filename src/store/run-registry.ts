import type { TaskId } from "../model/task.js";
import type { RunId, WorkerId, WorkerRoute } from "../model/worker.js";
import type { TaskSource } from "../transcript/source.js";

/** Routing and process lifecycle only; never semantic task state. */
export interface RunRegistry {
  readonly runId: RunId;
  resolveTaskSource(taskId: TaskId): Promise<TaskSource | undefined>;
  resolveWorker(workerId: WorkerId): Promise<WorkerRoute | undefined>;
  listWorkers(): Promise<WorkerRoute[]>;
}
