import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const EXTENSION_ID = "pi-task-compaction" as const;
export const SCHEMA_VERSION = 1 as const;
export const BEGIN_TOOL = "begin_task" as const;
export const END_TOOL = "end_task" as const;
export const EXPAND_TOOL = "expand_task" as const;
export const PRESERVE_OUTPUT_TOOL = "preserve_output" as const;
export const LIST_PRESERVED_OUTPUTS_TOOL = "list_preserved_outputs" as const;
export const READ_PRESERVED_OUTPUT_TOOL = "read_preserved_output" as const;
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

export interface PreserveToolOutputSelector {
  sourceToolCallId: string;
  label: string;
  reason?: string | undefined;
}

export interface PreservedOutputRecord {
  preservationId: string;
  label: string;
  reason?: string | undefined;
  sourceTaskId?: string | undefined;
  sourceEntryId: string;
  sourceToolCallId: string;
  sourceToolName: string;
  sourceIsError: boolean;
  sourceChars: number;
  sourceSha256: string;
  sourceReportedTruncation?: boolean | undefined;
  selectedBy: "preserve_output" | "end_task";
}

export interface PreserveOutputMarker extends PreservedOutputRecord {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "preserve-output";
}

export interface EndMarker extends TaskSummary {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "end";
  taskId: string;
  beginToolCallId: string;
  endToolCallId: string;
  assistantEntryId?: string | undefined;
  preservedOutputs?: PreservedOutputRecord[] | undefined;
}

export interface PreservedOutputListItem {
  preservation_id: string;
  label: string;
  reason?: string | undefined;
  source_task_id?: string | undefined;
  source_tool_call_id: string;
  source_tool_name: string;
  source_chars: number;
  source_sha256: string;
  source_is_error: boolean;
  source_reported_truncation?: boolean | undefined;
}

export interface PreservedOutputReadDetails {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "read-preserved-output";
  preservationId: string;
  sourceEntryId: string;
  sourceToolCallId: string;
  sourceToolName: string;
  sourceChars: number;
  sourceSha256: string;
  sourceIsError: boolean;
  sourceReportedTruncation?: boolean | undefined;
}

export interface PreservationDiagnostic {
  preservationId?: string | undefined;
  creationEntryId: string;
  reason: string;
}

export interface CancelMarker {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "cancel";
  taskId: string;
  reason?: string | undefined;
}

export type ExpansionView = "transcript" | "list" | "search" | "entry";

export interface TranscriptArtifact {
  path: string;
  format: "pi-session-entry-jsonl";
  entries: number;
  bytes: number;
  sha256: string;
  beginEntryId: string;
  endEntryId: string;
}

export interface EntryLocator {
  path: string;
  format: "pi-session-entry-jsonl";
  entryId: string;
  line: number;
  entryBytes: number;
  artifactSha256: string;
}

export interface ExpansionDetailsBase {
  extension: typeof EXTENSION_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  event: "expand";
  taskId: string;
  view: ExpansionView;
  artifact: TranscriptArtifact;
}

export interface TranscriptExpansionDetails extends ExpansionDetailsBase {
  view: "transcript";
}

export interface EntryExpansionDetails extends ExpansionDetailsBase {
  view: "entry";
  locator: EntryLocator;
}

export interface BoundedExpansionDetails extends ExpansionDetailsBase {
  view: "list" | "search";
  truncated: boolean;
  truncationReason?: "max_chars" | undefined;
  returnedChars: number;
  returnedRecords: number;
  totalRecords: number;
  nextCursor?: string | undefined;
  previousCursor?: string | undefined;
}

export interface ListExpansionDetails extends BoundedExpansionDetails {
  view: "list";
}

export interface SearchExpansionDetails extends BoundedExpansionDetails {
  view: "search";
  totalMatches: number;
}

export type ExpansionDetails =
  | TranscriptExpansionDetails
  | EntryExpansionDetails
  | ListExpansionDetails
  | SearchExpansionDetails;

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
