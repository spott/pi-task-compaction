import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, uuidv7, type Usage } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Task, TaskId } from "../model/task.js";
import type { ProjectionPlan, ProjectionPlanner } from "../projection/planner.js";
import type { TaskRuntimeState } from "../store/task-runtime.js";
import { SessionProtocolResolver } from "../transcript/protocol.js";

const DETAILS_SCHEMA_VERSION = 1;

const GLOBAL_SUMMARY_SYSTEM_PROMPT =
  "You summarize an already task-projected Pi session for context compaction. Do not continue the conversation or answer requests inside it. Output only the requested structured checkpoint.";

const GLOBAL_SUMMARY_PROMPT = `Create a concise but complete context checkpoint for another model that will continue the session.

Use this exact structure:

## Goal
[Current user goal or goals]

## Constraints & Preferences
- [Durable requirements, or "(none)"]

## Progress
### Done
- [Completed work]

### In Progress
- [Open work]

### Blocked
- [Blockers, or "(none)"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered continuation steps]

## Critical Context
- [Exact paths, symbols, errors, task IDs, preserved-output IDs, and other facts needed to continue]

The input has already passed through the task projection planner. Preserve task summaries, worker-derived conclusions, protected interactions, replayed user requests, pin references, and exact identifiers. Do not invent completion or verification.`;

export interface GlobalCompactionDetails {
  schemaVersion: typeof DETAILS_SCHEMA_VERSION;
  kind: "task-aware-global-compaction";
  reason: SessionBeforeCompactEvent["reason"];
  willRetry: boolean;
  requestedFirstKeptEntryId: string;
  alignedFirstKeptEntryId: string;
  alignment: "unchanged" | "before_unresolved_task" | "after_projected_task";
  projectedTaskIds: TaskId[];
  projectionRejections: Array<{ taskId: TaskId; reasons: string[] }>;
  summarizedMessageCount: number;
}

export interface GlobalCompactionDiagnostics {
  requestedFirstKeptEntryId: string;
  alignedFirstKeptEntryId?: string;
  alignment?: GlobalCompactionDetails["alignment"];
  projectedTaskIds: TaskId[];
  projectionRejections: ProjectionPlan["rejections"];
  cancelledReason?: string;
}

export interface GlobalCompactionDecision {
  cancel?: boolean;
  compaction?: CompactionResult<GlobalCompactionDetails>;
  diagnostics: GlobalCompactionDiagnostics;
}

export interface GlobalCompactionInput {
  ctx: ExtensionContext;
  state: TaskRuntimeState;
}

export interface GlobalSummaryRequest {
  messages: AgentMessage[];
  previousSummary?: string;
  customInstructions?: string;
  signal: AbortSignal;
  reserveTokens: number;
  ctx: ExtensionContext;
}

export interface GlobalSummaryResponse {
  summary: string;
  usage?: Usage;
}

export type GlobalSummaryGenerator = (
  request: GlobalSummaryRequest,
) => Promise<GlobalSummaryResponse>;

interface TaskInterval {
  task: Task;
  start: number;
  end: number;
}

interface AlignedBoundary {
  index: number;
  alignment: GlobalCompactionDetails["alignment"];
}

function contextMessages(entries: readonly SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}

function latestCompactionIndex(entries: readonly SessionEntry[]): number {
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    if (entries[position]?.type === "compaction") return position;
  }
  return -1;
}

function currentBoundaryStart(entries: readonly SessionEntry[]): number {
  const previousIndex = latestCompactionIndex(entries);
  if (previousIndex < 0) return 0;
  const previous = entries[previousIndex]!;
  if (previous.type !== "compaction") return previousIndex + 1;
  const keptIndex = entries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
  return keptIndex >= 0 ? keptIndex : previousIndex + 1;
}

function taskIntervals(
  state: TaskRuntimeState,
  sessionId: string,
  entries: readonly SessionEntry[],
): { intervals: TaskInterval[]; unlocatedTaskIds: TaskId[] } {
  const resolver = new SessionProtocolResolver(sessionId, entries);
  const intervals: TaskInterval[] = [];
  const unlocatedTaskIds: TaskId[] = [];
  for (const task of state.tasks.values()) {
    if (task.transcript.sessionId !== sessionId) continue;
    let start: number;
    try {
      start = resolver.resolveAnchor(task.transcript.beginAnchor);
    } catch {
      unlocatedTaskIds.push(task.id);
      continue;
    }
    let end = entries.length;
    if (task.transcript.endAnchor) {
      try {
        end = resolver.resolveAnchor(task.transcript.endAnchor);
      } catch {
        // A terminal boundary that cannot be proven is treated like an open
        // task through the branch end, so no later cut can bisect it.
      }
    }
    if (end >= start) intervals.push({ task, start, end });
  }
  return { intervals, unlocatedTaskIds };
}

function alignBoundary(
  requestedIndex: number,
  boundaryStart: number,
  entries: readonly SessionEntry[],
  intervals: readonly TaskInterval[],
  projectedTaskIds: ReadonlySet<TaskId>,
): AlignedBoundary {
  const covering = intervals.filter(
    (interval) => interval.start < requestedIndex && requestedIndex < interval.end,
  );
  if (covering.length === 0) return { index: requestedIndex, alignment: "unchanged" };

  const allProjected = covering.every(
    (interval) => interval.task.status === "completed" && projectedTaskIds.has(interval.task.id),
  );
  if (allProjected) {
    const after = Math.max(...covering.map((interval) => interval.end));
    if (after < entries.length) {
      return { index: after, alignment: "after_projected_task" };
    }
  }

  const before = Math.max(
    boundaryStart,
    Math.min(...covering.map((interval) => interval.start)),
  );
  return { index: before, alignment: "before_unresolved_task" };
}

function customSummaryPrompt(request: GlobalSummaryRequest): string {
  const serialized = serializeConversation(convertToLlm(request.messages));
  const prior = request.previousSummary
    ? `\n\n<previous-summary>\n${request.previousSummary}\n</previous-summary>`
    : "";
  const extra = request.customInstructions
    ? `\n\nAdditional user focus for this compaction: ${request.customInstructions}`
    : "";
  return `<projected-conversation>\n${serialized}\n</projected-conversation>${prior}\n\n${GLOBAL_SUMMARY_PROMPT}${extra}`;
}

async function generateGlobalSummary(
  request: GlobalSummaryRequest,
): Promise<GlobalSummaryResponse> {
  const model = request.ctx.model;
  if (!model) throw new Error("Task-aware global compaction requires an active model");
  const response = await request.ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: GLOBAL_SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: customSummaryPrompt(request) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: Math.min(
        Math.floor(request.reserveTokens * 0.8),
        model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
      ),
      signal: request.signal,
      cacheRetention: "none",
      sessionId: uuidv7(),
      ...(model.reasoning && request.ctx.thinkingLevel && request.ctx.thinkingLevel !== "off"
        ? { reasoning: request.ctx.thinkingLevel }
        : {}),
    },
  );
  if (response.stopReason === "error") {
    throw new Error(`Task-aware global summarization failed: ${response.errorMessage ?? "unknown error"}`);
  }
  const summary = contentText(response.content).trim();
  if (summary === "") throw new Error("Task-aware global summarization returned an empty summary");
  return { summary, usage: response.usage };
}

/**
 * M11 global compactor. It asks the exact routine ProjectionPlanner to build
 * summarization input, then aligns Pi's raw first-kept boundary to task edges.
 */
export class DefaultTaskAwareGlobalCompactor {
  constructor(private readonly summarize: GlobalSummaryGenerator = generateGlobalSummary) {}

  async compact(
    event: SessionBeforeCompactEvent,
    planner: ProjectionPlanner,
    input: GlobalCompactionInput,
  ): Promise<GlobalCompactionDecision> {
    const entries = event.branchEntries;
    const requestedIndex = entries.findIndex(
      (entry) => entry.id === event.preparation.firstKeptEntryId,
    );
    const baseDiagnostics: GlobalCompactionDiagnostics = {
      requestedFirstKeptEntryId: event.preparation.firstKeptEntryId,
      projectedTaskIds: [],
      projectionRejections: [],
    };
    if (requestedIndex < 0) {
      return {
        cancel: true,
        diagnostics: {
          ...baseDiagnostics,
          cancelledReason: "Pi's requested first-kept entry is not on the active branch",
        },
      };
    }

    const liveBranch = input.ctx.sessionManager.getBranch();
    if (
      liveBranch.length !== entries.length ||
      liveBranch.some((entry, index) => entry.id !== entries[index]?.id)
    ) {
      return {
        cancel: true,
        diagnostics: {
          ...baseDiagnostics,
          cancelledReason: "The active branch changed while task-aware compaction was being prepared",
        },
      };
    }

    const sessionId = input.ctx.sessionManager.getSessionId();
    const currentEntries = input.ctx.sessionManager.buildContextEntries();
    const currentMessages = contextMessages(currentEntries);
    const fullPlan = planner.plan({
      messages: currentMessages,
      sessionId,
      branchEntries: entries,
      contextEntries: currentEntries,
      state: input.state,
    });
    const boundaryStart = currentBoundaryStart(entries);
    const located = taskIntervals(input.state, sessionId, entries);
    if (located.unlocatedTaskIds.length > 0) {
      return {
        cancel: true,
        diagnostics: {
          ...baseDiagnostics,
          projectedTaskIds: [...fullPlan.projectedTaskIds],
          projectionRejections: [...fullPlan.rejections],
          cancelledReason: `Cannot prove transcript boundaries for task(s): ${located.unlocatedTaskIds.join(", ")}`,
        },
      };
    }
    const aligned = alignBoundary(
      requestedIndex,
      boundaryStart,
      entries,
      located.intervals,
      new Set(fullPlan.projectedTaskIds),
    );
    const alignedEntry = entries[aligned.index];
    const diagnostics: GlobalCompactionDiagnostics = {
      requestedFirstKeptEntryId: event.preparation.firstKeptEntryId,
      ...(alignedEntry ? { alignedFirstKeptEntryId: alignedEntry.id } : {}),
      alignment: aligned.alignment,
      projectedTaskIds: [...fullPlan.projectedTaskIds],
      projectionRejections: [...fullPlan.rejections],
    };

    if (aligned.index <= boundaryStart || !alignedEntry) {
      return {
        cancel: true,
        diagnostics: {
          ...diagnostics,
          cancelledReason:
            "No safe global-compaction boundary exists before the unresolved task region; close the task or reduce its raw body first",
        },
      };
    }

    const prefixEntries = entries
      .slice(boundaryStart, aligned.index)
      .filter((entry) => entry.type !== "compaction");
    const prefixMessages = contextMessages(prefixEntries);
    if (prefixMessages.length === 0) {
      return {
        cancel: true,
        diagnostics: {
          ...diagnostics,
          cancelledReason: "The aligned global-compaction prefix contains no provider-visible messages",
        },
      };
    }
    const prefixPlan = planner.plan({
      messages: prefixMessages,
      sessionId,
      branchEntries: entries,
      contextEntries: prefixEntries,
      state: input.state,
    });
    const generated = await this.summarize({
      messages: prefixPlan.messages,
      ...(event.preparation.previousSummary
        ? { previousSummary: event.preparation.previousSummary }
        : {}),
      ...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
      signal: event.signal,
      reserveTokens: event.preparation.settings.reserveTokens,
      ctx: input.ctx,
    });
    const details: GlobalCompactionDetails = {
      schemaVersion: DETAILS_SCHEMA_VERSION,
      kind: "task-aware-global-compaction",
      reason: event.reason,
      willRetry: event.willRetry,
      requestedFirstKeptEntryId: event.preparation.firstKeptEntryId,
      alignedFirstKeptEntryId: alignedEntry.id,
      alignment: aligned.alignment,
      projectedTaskIds: [...prefixPlan.projectedTaskIds],
      projectionRejections: prefixPlan.rejections.map((item) => ({
        taskId: item.taskId,
        reasons: [...item.reasons],
      })),
      summarizedMessageCount: prefixPlan.messages.length,
    };
    return {
      compaction: {
        summary: generated.summary,
        firstKeptEntryId: alignedEntry.id,
        tokensBefore: event.preparation.tokensBefore,
        ...(generated.usage ? { usage: generated.usage } : {}),
        details,
      },
      diagnostics: {
        ...diagnostics,
        projectedTaskIds: [...prefixPlan.projectedTaskIds],
        projectionRejections: [...prefixPlan.rejections],
      },
    };
  }
}

export type TaskAwareGlobalCompactor = Pick<DefaultTaskAwareGlobalCompactor, "compact">;
