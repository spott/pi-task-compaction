import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const EXTENSION_ID = "pi-task-compaction" as const;
export const SCHEMA_VERSION = 1 as const;
export const BEGIN_TOOL = "begin_task" as const;
export const END_TOOL = "end_task" as const;
export const EXPAND_TOOL = "expand_task" as const;
export const CANCEL_ENTRY = "pi-task-compaction/cancel" as const;

export interface BeginMarker {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "begin";
  taskId: string;
  objective: string;
  expectedScope?: string | undefined;
  toolCallId: string;
  assistantEntryId?: string | undefined;
}

export interface TaskSummary {
  objective: string;
  outcome: string;
  executionContext?: string | undefined;
  attempted: string[];
  learnings: string[];
  decisions: string[];
  filesRead: string[];
  filesModified: string[];
  artifacts: string[];
  verification: string[];
  openThreads: string[];
}

export interface EndMarker extends TaskSummary {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "end";
  taskId: string;
  beginToolCallId: string;
  endToolCallId: string;
  assistantEntryId?: string | undefined;
}

export interface CancelMarker {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "cancel";
  taskId: string;
  reason?: string | undefined;
}

export interface ExpansionDetails {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "expand";
  taskId: string;
  truncated: boolean;
  returnedChars: number;
}

export type Marker = BeginMarker | EndMarker;

export type TaskStatus = "open" | "closed" | "cancelled" | "invalid";

export interface IndexedTask {
  taskId: string;
  objective: string;
  status: TaskStatus;
  begin?: BeginMarker | undefined;
  end?: EndMarker | undefined;
  cancel?: CancelMarker | undefined;
  beginAssistantEntryId?: string | undefined;
  beginResultEntryId?: string | undefined;
  endAssistantEntryId?: string | undefined;
  endResultEntryId?: string | undefined;
  beginEntryIndex?: number | undefined;
  endEntryIndex?: number | undefined;
  rawChars?: number | undefined;
  summaryChars?: number | undefined;
  expansionCount?: number | undefined;
  rejectionReason?: string | undefined;
}

export interface TaskIndex {
  tasks: Map<string, IndexedTask>;
  ordered: IndexedTask[];
  open: IndexedTask | undefined;
}

export interface RegionDiagnostic {
  taskId: string;
  accepted: boolean;
  reason?: string;
  start?: number;
  end?: number;
  rawChars?: number;
  summaryChars?: number;
}

export interface TransformResult {
  messages: AgentMessage[];
  diagnostics: RegionDiagnostic[];
}

export interface TaskCompactionDetails {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  readFiles: string[];
  modifiedFiles: string[];
  projectedTaskIds: string[];
}
