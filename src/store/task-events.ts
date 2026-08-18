import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  isTaskEventEnvelope,
  TASK_EVENT_CUSTOM_TYPE,
  TASK_EVENT_SCHEMA_VERSION,
  taskEventEnvelope,
  type TaskEvent,
  type TaskEventEnvelope,
} from "../model/events.js";

export interface TaskEventRecord {
  entryId: string;
  envelope: TaskEventEnvelope;
}

export interface TaskEventIssue {
  entryId: string;
  code: "invalid_envelope" | "unknown_version" | "unknown_event" | "invalid_event" | "invalid_transition";
  message: string;
}

export interface TaskEventLog {
  records: TaskEventRecord[];
  issues: TaskEventIssue[];
}

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface TaskEventStore {
  read(sessionManager: ReadonlySessionManager): TaskEventLog;
  append(event: TaskEvent, ctx: ExtensionContext): string;
}

function describeInvalidEnvelope(data: unknown): Omit<TaskEventIssue, "entryId"> {
  if (typeof data !== "object" || data === null) {
    return { code: "invalid_envelope", message: "task event envelope is not an object" };
  }
  const envelope = data as { schemaVersion?: unknown; event?: { type?: unknown } };
  if (envelope.schemaVersion !== TASK_EVENT_SCHEMA_VERSION) {
    return {
      code: "unknown_version",
      message: `unsupported task event schema version: ${String(envelope.schemaVersion)}`,
    };
  }
  if (typeof envelope.event?.type === "string") {
    return {
      code: "unknown_event",
      message: `unsupported task event type: ${envelope.event.type}`,
    };
  }
  return { code: "invalid_envelope", message: "task event envelope is malformed" };
}

export function readTaskEventLog(entries: readonly SessionEntry[]): TaskEventLog {
  const records: TaskEventRecord[] = [];
  const issues: TaskEventIssue[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TASK_EVENT_CUSTOM_TYPE) continue;
    if (!isTaskEventEnvelope(entry.data)) {
      issues.push({ entryId: entry.id, ...describeInvalidEnvelope(entry.data) });
      continue;
    }
    records.push({ entryId: entry.id, envelope: entry.data });
  }
  return { records, issues };
}

export class PiTaskEventStore implements TaskEventStore {
  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">) {}

  read(sessionManager: ReadonlySessionManager): TaskEventLog {
    return readTaskEventLog(sessionManager.getBranch());
  }

  append(event: TaskEvent, ctx: ExtensionContext): string {
    this.pi.appendEntry(TASK_EVENT_CUSTOM_TYPE, taskEventEnvelope(event));
    const entryId = ctx.sessionManager.getLeafId();
    if (entryId === null) {
      throw new Error("Pi did not expose the persisted task-event entry ID");
    }
    return entryId;
  }
}
