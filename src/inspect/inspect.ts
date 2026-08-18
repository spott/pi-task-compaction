import type { TaskId } from "../model/task.js";

export type InspectTaskView = "summary" | "list" | "search" | "entry" | "transcript";

export interface InspectTaskRequest {
  task_id: TaskId;
  view?: InspectTaskView;
  query?: string;
  entry?: string;
  cursor?: string;
  max_chars?: number;
}

export interface TaskInspector {
  inspect(request: InspectTaskRequest): Promise<unknown>;
}
