import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ProtocolClosureEntry } from "../model/output.js";
import type { TranscriptRange } from "./anchors.js";

export interface ToolProtocolUnit {
  assistantEntryId: string;
  assistantMessage: AssistantMessage;
  toolCallId: string;
  toolName: string;
  toolCallBlock: ToolCall;
  resultEntryId: string;
  result: ToolResultMessage;
}

export interface ProtocolValidation {
  valid: boolean;
  reasons: string[];
}

export interface ProtocolResolver {
  resolveProtocolUnit(toolCallId: string): Promise<ToolProtocolUnit> | ToolProtocolUnit;
  extractProtocolUnits(range: TranscriptRange): Promise<ToolProtocolUnit[]> | ToolProtocolUnit[];
  validateProtocolRange(range: TranscriptRange): Promise<ProtocolValidation> | ProtocolValidation;
  computeMinimalProtocolClosure(
    toolCallId: string,
  ): Promise<ProtocolClosureEntry[]> | ProtocolClosureEntry[];
}
