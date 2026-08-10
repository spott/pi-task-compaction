import {
  compact,
  findTurnStartIndex,
  sessionEntryToContextMessages,
  type FileOperations,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { reconstructTaskIndex } from "./reconstruct.js";
import { HISTORICAL_CONTEXT_INSTRUCTION, transformMessages } from "./transform.js";
import { EXTENSION_ID, SCHEMA_VERSION, type IndexedTask, type TaskCompactionDetails } from "./types.js";

export interface ProjectedPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  boundaryChanged: boolean;
  projectedTaskIds: string[];
  fileOps: FileOperations;
}

const entryMessages = (entries: SessionEntry[], start: number, end: number): AgentMessage[] => {
  const messages: AgentMessage[] = [];
  for (let index = start; index < end; index++) {
    const entry = entries[index]!;
    if (entry.type !== "compaction") messages.push(...sessionEntryToContextMessages(entry));
  }
  return messages;
};

const latestCompactionIndex = (entries: SessionEntry[]): number => {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") return index;
  }
  return -1;
};

function boundaryStart(entries: SessionEntry[]): number {
  const previousIndex = latestCompactionIndex(entries);
  if (previousIndex < 0) return 0;
  const previous = entries[previousIndex];
  if (previous?.type !== "compaction") return 0;
  const kept = entries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
  return kept >= 0 ? kept : previousIndex + 1;
}

function cloneFileOps(fileOps: FileOperations): FileOperations {
  return {
    read: new Set(fileOps.read),
    written: new Set(fileOps.written),
    edited: new Set(fileOps.edited),
  };
}

const isTaskDetails = (value: unknown): value is TaskCompactionDetails => {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Partial<TaskCompactionDetails>;
  return details.extension === EXTENSION_ID && details.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(details.readFiles) && Array.isArray(details.modifiedFiles);
};

function mergePreviousDetails(entries: SessionEntry[], fileOps: FileOperations): void {
  const index = latestCompactionIndex(entries);
  const entry = index >= 0 ? entries[index] : undefined;
  if (!entry || entry.type !== "compaction" || !isTaskDetails(entry.details)) return;
  for (const path of entry.details.readFiles) fileOps.read.add(path);
  for (const path of entry.details.modifiedFiles) fileOps.edited.add(path);
}

function acceptedTasks(entries: SessionEntry[]): IndexedTask[] {
  return reconstructTaskIndex(entries).ordered.filter((task) =>
    task.status === "closed" &&
    task.beginEntryIndex !== undefined &&
    task.endEntryIndex !== undefined &&
    task.beginAssistantEntryId !== undefined,
  );
}

function protectedTasks(entries: SessionEntry[]): Array<{ begin: number; end: number }> {
  const index = reconstructTaskIndex(entries);
  const protectedRegions = acceptedTasks(entries).map((task) => ({
    begin: task.beginEntryIndex!,
    end: task.endEntryIndex!,
  }));
  if (index.open?.beginEntryIndex !== undefined) {
    protectedRegions.push({ begin: index.open.beginEntryIndex, end: entries.length - 1 });
  }
  return protectedRegions;
}

/** Build the transcript and safe kept boundary used by task-aware global compaction. */
export function projectCompaction(event: SessionBeforeCompactEvent): ProjectedPreparation | undefined {
  const entries = event.branchEntries;
  const proposedIndex = entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  if (proposedIndex < 0) return undefined;

  const tasks = acceptedTasks(entries);
  let keptIndex = proposedIndex;
  for (const task of protectedTasks(entries)) {
    if (task.begin < proposedIndex && proposedIndex <= task.end) keptIndex = Math.min(keptIndex, task.begin);
  }

  const start = boundaryStart(entries);
  if (keptIndex < start) return undefined;
  const keptMessages = sessionEntryToContextMessages(entries[keptIndex]!);
  const startsTurn = keptMessages.some((message) =>
    message.role === "user" || message.role === "custom" || message.role === "bashExecution" ||
    message.role === "branchSummary" || message.role === "compactionSummary",
  );
  const turnStart = startsTurn ? -1 : findTurnStartIndex(entries, keptIndex, start);
  const isSplitTurn = !startsTurn && turnStart >= 0;
  const historyEnd = isSplitTurn ? turnStart : keptIndex;

  const history = transformMessages(entryMessages(entries, start, historyEnd));
  const prefix = transformMessages(isSplitTurn ? entryMessages(entries, turnStart, keptIndex) : []);
  const projectedTaskIds = [...history.diagnostics, ...prefix.diagnostics]
    .filter((diagnostic) => diagnostic.accepted)
    .map((diagnostic) => diagnostic.taskId);

  const fileOps = cloneFileOps(event.preparation.fileOps);
  mergePreviousDetails(entries, fileOps);
  for (const task of tasks) {
    if (task.endEntryIndex! >= keptIndex || !task.end) continue;
    for (const path of task.end.filesRead) fileOps.read.add(path);
    for (const path of task.end.filesModified) fileOps.edited.add(path);
  }

  return {
    firstKeptEntryId: entries[keptIndex]!.id,
    messagesToSummarize: history.messages,
    turnPrefixMessages: prefix.messages,
    isSplitTurn,
    boundaryChanged: keptIndex !== proposedIndex,
    projectedTaskIds: [...new Set(projectedTaskIds)],
    fileOps,
  };
}

export async function runTaskAwareCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
  const proposedIndex = event.branchEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  const start = boundaryStart(event.branchEntries);
  const alreadyStranded = proposedIndex >= 0 && protectedTasks(event.branchEntries).some((task) =>
    task.begin < start && task.begin < proposedIndex && proposedIndex <= task.end,
  );
  if (alreadyStranded) {
    if (ctx.hasUI) ctx.ui.notify("Task-aware compaction refused a boundary inside a task whose begin marker is older than the current compaction checkpoint.", "error");
    return { cancel: true } as const;
  }

  const projection = projectCompaction(event);
  if (!projection) return;

  const hasTaskState = reconstructTaskIndex(event.branchEntries).ordered.length > 0;
  const previousIndex = latestCompactionIndex(event.branchEntries);
  const previous = previousIndex >= 0 ? event.branchEntries[previousIndex] : undefined;
  const hasPriorTaskDetails = previous?.type === "compaction" && isTaskDetails(previous.details);
  if (!hasTaskState && !hasPriorTaskDetails) return;

  const model = ctx.model;
  if (!model) {
    if (projection.boundaryChanged) return { cancel: true } as const;
    return;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    if (ctx.hasUI) ctx.ui.notify(`Task-aware compaction could not authenticate ${model.provider}/${model.id}`, "error");
    if (projection.boundaryChanged) return { cancel: true } as const;
    return;
  }

  try {
    const customInstructions = [
      event.customInstructions,
      HISTORICAL_CONTEXT_INSTRUCTION,
      "Completed <task-summary> blocks are authoritative historical summaries. Preserve their durable facts without expanding them into imagined detail.",
    ].filter(Boolean).join("\n\n");
    const result = await compact(
      {
        ...event.preparation,
        firstKeptEntryId: projection.firstKeptEntryId,
        messagesToSummarize: projection.messagesToSummarize,
        turnPrefixMessages: projection.turnPrefixMessages,
        isSplitTurn: projection.isSplitTurn,
        fileOps: projection.fileOps,
      },
      model,
      auth.apiKey,
      auth.headers,
      customInstructions,
      event.signal,
      ctx.thinkingLevel,
      undefined,
      auth.env,
    );
    const standardDetails = result.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
    return {
      compaction: {
        ...result,
        details: {
          extension: EXTENSION_ID,
          schemaVersion: SCHEMA_VERSION,
          readFiles: standardDetails?.readFiles ?? [],
          modifiedFiles: standardDetails?.modifiedFiles ?? [],
          projectedTaskIds: projection.projectedTaskIds,
        } satisfies TaskCompactionDetails,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(`Task-aware compaction failed: ${message}`, "error");
    if (projection.boundaryChanged) return { cancel: true } as const;
    return;
  }
}
