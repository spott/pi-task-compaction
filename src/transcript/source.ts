import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Task, TaskId } from "../model/task.js";
import type { TranscriptRange } from "./anchors.js";
import { SessionProtocolResolver } from "./protocol.js";

export interface TaskSource {
  sessionId: string;
  sessionFile?: string;
}

export interface TaskResolver {
  resolveTask(taskId: TaskId): Task | undefined;
  resolveTaskSource(taskId: TaskId): TaskSource | undefined;
}

export interface TranscriptResolver {
  resolveTaskTranscript(taskId: TaskId): TranscriptRange;
  resolveEntries(range: TranscriptRange): SessionEntry[];
}

/** Active-session implementation. Worker routing can supply another source in M8. */
export class SessionTranscriptResolver implements TranscriptResolver {
  constructor(
    private readonly sessionId: string,
    private readonly entries: readonly SessionEntry[],
    private readonly resolveTask: (taskId: TaskId) => Task | undefined,
  ) {}

  resolveTaskTranscript(taskId: TaskId): TranscriptRange {
    const task = this.resolveTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.transcript.sessionId !== this.sessionId) {
      throw new Error(`Task ${taskId} is owned by another session (${task.transcript.sessionId})`);
    }
    if (!task.transcript.endAnchor) {
      throw new Error(`Task ${taskId} is still open and has no terminal transcript range`);
    }
    return { start: task.transcript.beginAnchor, end: task.transcript.endAnchor };
  }

  resolveEntries(range: TranscriptRange): SessionEntry[] {
    return new SessionProtocolResolver(this.sessionId, this.entries).resolveRange(range).entries;
  }
}
