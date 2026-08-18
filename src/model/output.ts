import type { TranscriptRange } from "../transcript/anchors.js";

export type OutputId = string;

export interface ProtocolClosureEntry {
  entryId: string;
  hash: string;
}

export interface PreservedOutput {
  id: OutputId;
  taskId: string;
  source: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    assistantEntryId: string;
    resultEntryId: string;
    callHash: string;
    resultHash: string;
    closure?: ProtocolClosureEntry[];
  };
  pin: boolean;
}

export interface ProtectedInteraction {
  id: string;
  taskId: string;
  range: TranscriptRange;
  userEntryIds: string[];
  assistantEntryId: string;
  markerToolCallId: string;
}
