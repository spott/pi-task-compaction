import type { RunId } from "../model/worker.js";
import type { TaskId } from "../model/task.js";

export interface WorkerBootstrap {
  taskId: TaskId;
  task: string;
  parentTaskId: TaskId | null;
  agentDepth: number;
  runId: RunId;
  requiredContext: TaskId[];
  availableContext: TaskId[];
}
