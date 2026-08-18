import type { TaskId } from "../model/task.js";
import type { WorkerRoute } from "../model/worker.js";

export interface SpawnTaskRequest {
  task: string;
  parentTaskId: TaskId | null;
  requiredContext: TaskId[];
  availableContext: TaskId[];
}

export interface WorkerCoordinator {
  spawn(request: SpawnTaskRequest): Promise<{ taskId: TaskId; status: "starting" }>;
  poll(taskId: TaskId): Promise<WorkerRoute>;
  join(taskIds: TaskId[], wait: "all" | "any"): Promise<unknown>;
}
