import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ProtocolClosureEntry } from "../model/output.js";
import type { TranscriptAnchor, TranscriptRange } from "./anchors.js";
import { hashSessionEntry } from "./hash.js";

export interface ToolProtocolUnit {
  assistantEntryId: string;
  assistantEntryIndex: number;
  assistantMessage: AssistantMessage;
  toolCallId: string;
  toolName: string;
  toolCallBlock: ToolCall;
  resultEntryId: string;
  resultEntryIndex: number;
  result: ToolResultMessage;
}

export interface LocatedToolCall {
  entryId: string;
  entryIndex: number;
  message: AssistantMessage;
  block: ToolCall;
}

export interface ResolvedTranscriptRange {
  start: number;
  end: number;
  entries: SessionEntry[];
}

export interface ProtocolValidation {
  valid: boolean;
  reasons: string[];
}

export interface ProtocolResolver {
  resolveProtocolUnit(toolCallId: string): ToolProtocolUnit;
  extractProtocolUnits(range: TranscriptRange): ToolProtocolUnit[];
  validateProtocolRange(range: TranscriptRange): ProtocolValidation;
  computeMinimalProtocolClosure(toolCallId: string): ProtocolClosureEntry[];
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function unique<T>(items: readonly T[], describe: string): T {
  if (items.length === 0) throw new Error(`${describe} is missing from the active session branch`);
  if (items.length > 1) throw new Error(`${describe} is ambiguous on the active session branch`);
  return items[0]!;
}

/**
 * One active-branch parser for all task transcript, preservation, projection,
 * and inspection call/result relationships.
 */
export class SessionProtocolResolver implements ProtocolResolver {
  constructor(
    private readonly sessionId: string,
    private readonly entries: readonly SessionEntry[],
  ) {}

  locateToolCall(toolCallId: string): LocatedToolCall {
    const matches: LocatedToolCall[] = [];
    for (let entryIndex = 0; entryIndex < this.entries.length; entryIndex += 1) {
      const entry = this.entries[entryIndex]!;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const block of toolCalls(entry.message)) {
        if (block.id === toolCallId) {
          matches.push({
            entryId: entry.id,
            entryIndex,
            message: entry.message,
            block,
          });
        }
      }
    }
    return unique(matches, `tool call ${toolCallId}`);
  }

  resolveProtocolUnit(toolCallId: string): ToolProtocolUnit {
    const call = this.locateToolCall(toolCallId);
    const results: Array<{
      entryId: string;
      entryIndex: number;
      message: ToolResultMessage;
    }> = [];
    for (let entryIndex = 0; entryIndex < this.entries.length; entryIndex += 1) {
      const entry = this.entries[entryIndex]!;
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === toolCallId
      ) {
        results.push({ entryId: entry.id, entryIndex, message: entry.message });
      }
    }
    const result = unique(results, `result for tool call ${toolCallId}`);
    if (result.entryIndex <= call.entryIndex) {
      throw new Error(`result for tool call ${toolCallId} does not follow its assistant call`);
    }
    if (result.message.toolName !== call.block.name) {
      throw new Error(
        `tool name mismatch for ${toolCallId}: call is ${call.block.name}, result is ${result.message.toolName}`,
      );
    }
    return {
      assistantEntryId: call.entryId,
      assistantEntryIndex: call.entryIndex,
      assistantMessage: call.message,
      toolCallId,
      toolName: call.block.name,
      toolCallBlock: call.block,
      resultEntryId: result.entryId,
      resultEntryIndex: result.entryIndex,
      result: result.message,
    };
  }

  resolveAnchor(anchor: TranscriptAnchor): number {
    if (anchor.sessionId !== this.sessionId) {
      throw new Error(`transcript anchor belongs to session ${anchor.sessionId}, not ${this.sessionId}`);
    }
    if (anchor.entryId === null) return anchor.boundary === "before" ? 0 : this.entries.length;
    const entryIndex = this.entries.findIndex((entry) => entry.id === anchor.entryId);
    if (entryIndex < 0) throw new Error(`transcript anchor entry ${anchor.entryId} is not on the active branch`);

    // A tool boundary is semantically outside the complete provider protocol
    // unit even though its result entry does not exist yet when execute() runs.
    if (anchor.tool) {
      const call = this.locateToolCall(anchor.tool.toolCallId);
      if (call.entryId !== anchor.tool.assistantEntryId || call.block.name !== anchor.tool.toolName) {
        throw new Error(`transcript tool anchor ${anchor.tool.toolCallId} has inconsistent provenance`);
      }
      if (anchor.boundary === "before") return call.entryIndex;
      const unit = this.resolveProtocolUnit(anchor.tool.toolCallId);
      if (anchor.tool.resultEntryId && anchor.tool.resultEntryId !== unit.resultEntryId) {
        throw new Error(`transcript tool anchor ${anchor.tool.toolCallId} result provenance changed`);
      }
      return unit.resultEntryIndex + 1;
    }
    return anchor.boundary === "before" ? entryIndex : entryIndex + 1;
  }

  resolveRange(range: TranscriptRange): ResolvedTranscriptRange {
    const start = this.resolveAnchor(range.start);
    const end = this.resolveAnchor(range.end);
    if (end < start) throw new Error("transcript range ends before it starts");
    return { start, end, entries: this.entries.slice(start, end) };
  }

  extractProtocolUnits(range: TranscriptRange): ToolProtocolUnit[] {
    const resolved = this.resolveRange(range);
    const units: ToolProtocolUnit[] = [];
    for (let index = resolved.start; index < resolved.end; index += 1) {
      const entry = this.entries[index]!;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const call of toolCalls(entry.message)) {
        const unit = this.resolveProtocolUnit(call.id);
        if (unit.resultEntryIndex < resolved.end) units.push(unit);
      }
    }
    return units;
  }

  validateProtocolRange(range: TranscriptRange): ProtocolValidation {
    const reasons: string[] = [];
    let resolved: ResolvedTranscriptRange;
    try {
      resolved = this.resolveRange(range);
    } catch (error) {
      return { valid: false, reasons: [error instanceof Error ? error.message : String(error)] };
    }

    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (let index = resolved.start; index < resolved.end; index += 1) {
      const entry = this.entries[index]!;
      if (entry.type !== "message") continue;
      if (entry.message.role === "assistant") {
        for (const call of toolCalls(entry.message)) {
          if (callIds.has(call.id)) reasons.push(`duplicate tool call ${call.id} in range`);
          callIds.add(call.id);
          try {
            const unit = this.resolveProtocolUnit(call.id);
            if (unit.resultEntryIndex >= resolved.end) reasons.push(`result for ${call.id} falls outside range`);
          } catch (error) {
            reasons.push(error instanceof Error ? error.message : String(error));
          }
        }
      } else if (entry.message.role === "toolResult") {
        if (resultIds.has(entry.message.toolCallId)) {
          reasons.push(`duplicate result for ${entry.message.toolCallId} in range`);
        }
        resultIds.add(entry.message.toolCallId);
        try {
          const unit = this.resolveProtocolUnit(entry.message.toolCallId);
          if (unit.assistantEntryIndex < resolved.start) {
            reasons.push(`call for ${entry.message.toolCallId} falls outside range`);
          }
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    for (const callId of callIds) {
      if (!resultIds.has(callId)) reasons.push(`tool call ${callId} has no result in range`);
    }
    for (const resultId of resultIds) {
      if (!callIds.has(resultId)) reasons.push(`tool result ${resultId} has no call in range`);
    }
    return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  computeMinimalProtocolClosure(toolCallId: string): ProtocolClosureEntry[] {
    const selected = this.resolveProtocolUnit(toolCallId);
    const siblingCalls = toolCalls(selected.assistantMessage);
    const entryIndexes = new Set<number>([selected.assistantEntryIndex]);
    for (const call of siblingCalls) {
      entryIndexes.add(this.resolveProtocolUnit(call.id).resultEntryIndex);
    }
    return [...entryIndexes]
      .sort((left, right) => left - right)
      .map((index) => {
        const entry = this.entries[index]!;
        return { entryId: entry.id, hash: hashSessionEntry(entry) };
      });
  }

  validateClosure(closure: readonly ProtocolClosureEntry[]): ProtocolValidation {
    const reasons: string[] = [];
    let previous = -1;
    for (const item of closure) {
      const index = this.entries.findIndex((entry) => entry.id === item.entryId);
      if (index < 0) {
        reasons.push(`closure entry ${item.entryId} is not on the active branch`);
        continue;
      }
      if (index <= previous) reasons.push("closure entries are not in original transcript order");
      previous = index;
      if (hashSessionEntry(this.entries[index]!) !== item.hash) {
        reasons.push(`closure entry ${item.entryId} failed integrity validation`);
      }
    }
    return { valid: reasons.length === 0, reasons };
  }
}
