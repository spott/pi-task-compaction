import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Task, TaskId } from "../model/task.js";
import type { TranscriptRange } from "./anchors.js";

export interface TaskSource {
  sessionId: string;
  sessionFile?: string;
}

export interface TaskResolver {
  resolveTask(taskId: TaskId): Promise<Task | undefined> | Task | undefined;
  resolveTaskSource(taskId: TaskId): Promise<TaskSource | undefined> | TaskSource | undefined;
}

export interface TranscriptResolver {
  resolveTaskTranscript(taskId: TaskId): Promise<TranscriptRange> | TranscriptRange;
  resolveEntries(range: TranscriptRange): Promise<SessionEntry[]> | SessionEntry[];
}
