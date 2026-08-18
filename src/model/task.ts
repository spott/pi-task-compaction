import type { OutputId } from "./output.js";
import type { TaskSummary } from "./summary.js";
import type { TaskExecution } from "./worker.js";
import type { TranscriptAnchor } from "../transcript/anchors.js";

export type TaskId = string;

export type SemanticTaskStatus = "open" | "completed" | "failed" | "cancelled";
export type ResolvedTaskStatus =
  | SemanticTaskStatus
  | "starting"
  | "running"
  | "derived_failed";

export interface TaskTranscriptSource {
  sessionId: string;
  beginAnchor: TranscriptAnchor;
  endAnchor?: TranscriptAnchor;
}

export interface Task {
  id: TaskId;
  task: string;
  parentId: TaskId | null;
  localDepth: number;
  status: SemanticTaskStatus;
  createdAt: number;
  completedAt?: number;
  summary?: TaskSummary;
  children: TaskId[];
  preservedOutputs: OutputId[];
  execution: TaskExecution;
  transcript: TaskTranscriptSource;
}

export interface ChildTaskReference {
  taskId: TaskId;
  task: string;
}

export interface TaskListItem {
  id: TaskId;
  parentId: TaskId | null;
  task: string;
  status: ResolvedTaskStatus;
  localDepth: number;
  semanticDepth: number;
  agentDepth: number;
  children: ChildTaskReference[];
  preservedOutputCount: number;
  pinnedOutputCount: number;
  execution: TaskExecution;
}
