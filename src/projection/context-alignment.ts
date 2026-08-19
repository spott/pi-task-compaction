import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "../transcript/hash.js";

export type ContextAlignmentStatus = "exact" | "retry_error_omissions" | "mismatch";

export interface ContextMessageRecord {
  entryId: string;
  message: AgentMessage;
  messageIndex: number;
}

export type ContextAlignmentMismatchReason =
  | "message_mismatch"
  | "extra_live_message"
  | "unexpected_context_record";

export interface ContextAlignmentMismatch {
  liveMessageIndex: number;
  contextRecordIndex: number;
  reason: ContextAlignmentMismatchReason;
}

export interface ContextAlignment {
  status: ContextAlignmentStatus;
  records: ContextMessageRecord[];
  omittedRetryErrorEntryIds: string[];
  mismatch?: ContextAlignmentMismatch;
}

interface ReconstructedContextRecord {
  entry: SessionEntry;
  message: AgentMessage;
  retryErrorOmissionEligible: boolean;
}

function reconstructedContextRecords(
  entries: readonly SessionEntry[],
): ReconstructedContextRecord[] {
  const records: ReconstructedContextRecord[] = [];
  for (const entry of entries) {
    const messages = sessionEntryToContextMessages(entry);
    const retryErrorOmissionEligible =
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error" &&
      messages.length === 1;
    for (const message of messages) {
      records.push({ entry, message, retryErrorOmissionEligible });
    }
  }
  return records;
}

function mismatch(
  omittedRetryErrorEntryIds: string[],
  liveMessageIndex: number,
  contextRecordIndex: number,
  reason: ContextAlignmentMismatchReason,
): ContextAlignment {
  return {
    status: "mismatch",
    records: [],
    omittedRetryErrorEntryIds,
    mismatch: { liveMessageIndex, contextRecordIndex, reason },
  };
}

/**
 * Align Pi's live provider context with provider messages reconstructed from
 * persistent context entries. The only accepted difference is a one-sided
 * omission of persisted assistant error messages that Pi removes on retry.
 */
export function alignContextMessages(
  liveMessages: readonly AgentMessage[],
  contextEntries: readonly SessionEntry[],
): ContextAlignment {
  const contextRecords = reconstructedContextRecords(contextEntries);
  const records: ContextMessageRecord[] = [];
  const omittedRetryErrorEntryIds: string[] = [];
  let liveMessageIndex = 0;
  let contextRecordIndex = 0;

  while (liveMessageIndex < liveMessages.length && contextRecordIndex < contextRecords.length) {
    const liveMessage = liveMessages[liveMessageIndex]!;
    const contextRecord = contextRecords[contextRecordIndex]!;

    // Exact matches always win, including retry-error messages genuinely present
    // in the live provider context.
    if (canonicalJson(liveMessage) === canonicalJson(contextRecord.message)) {
      records.push({
        entryId: contextRecord.entry.id,
        message: liveMessage,
        messageIndex: liveMessageIndex,
      });
      liveMessageIndex += 1;
      contextRecordIndex += 1;
      continue;
    }

    if (contextRecord.retryErrorOmissionEligible) {
      omittedRetryErrorEntryIds.push(contextRecord.entry.id);
      contextRecordIndex += 1;
      continue;
    }

    return mismatch(
      omittedRetryErrorEntryIds,
      liveMessageIndex,
      contextRecordIndex,
      "message_mismatch",
    );
  }

  if (liveMessageIndex < liveMessages.length) {
    return mismatch(
      omittedRetryErrorEntryIds,
      liveMessageIndex,
      contextRecordIndex,
      "extra_live_message",
    );
  }

  while (contextRecordIndex < contextRecords.length) {
    const contextRecord = contextRecords[contextRecordIndex]!;
    if (!contextRecord.retryErrorOmissionEligible) {
      return mismatch(
        omittedRetryErrorEntryIds,
        liveMessageIndex,
        contextRecordIndex,
        "unexpected_context_record",
      );
    }
    omittedRetryErrorEntryIds.push(contextRecord.entry.id);
    contextRecordIndex += 1;
  }

  return {
    status: omittedRetryErrorEntryIds.length === 0 ? "exact" : "retry_error_omissions",
    records,
    omittedRetryErrorEntryIds,
  };
}
