import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ProtectedInteraction } from "../model/output.js";
import type { Task, TaskId } from "../model/task.js";
import type { TranscriptAnchor } from "../transcript/anchors.js";
import { SessionProtocolResolver } from "../transcript/protocol.js";
import type { LocalTaskRuntime, TaskEventAppender, TaskRuntimeState } from "./task-runtime.js";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface PendingUserMessage {
  entryId: string;
  message: UserMessage;
  sourcePosition: number;
  occurrencePosition: number;
  order: number;
}

export interface ResolvedProtectedInteraction {
  interaction: ProtectedInteraction;
  userOccurrences: PendingUserMessage[];
  closureEntryIds: string[];
}

export interface ProtectResponseResult {
  interaction_id: string;
  task_id: TaskId;
  protected_user_message_count: number;
  protected_user_entry_ids: string[];
}

interface TaskBounds {
  start: number;
  end: number;
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function messageEntry(entry: SessionEntry | undefined): UserMessage | undefined {
  if (entry?.type !== "message" || entry.message.role !== "user") return undefined;
  return entry.message as UserMessage;
}

function anchorForEntry(sessionId: string, entryId: string): TranscriptAnchor {
  return { sessionId, entryId, boundary: "before" };
}

function markerEndAnchor(
  sessionId: string,
  assistantEntryId: string,
  toolCallId: string,
): TranscriptAnchor {
  return {
    sessionId,
    entryId: assistantEntryId,
    boundary: "after",
    tool: {
      toolCallId,
      toolName: "respond_to_user",
      assistantEntryId,
    },
  };
}

/**
 * Reconstructs task-scoped user-message ownership from stable task ranges.
 * Replays are logical occurrences: they never become duplicate raw session entries.
 */
export class InteractionIndex {
  private readonly resolver: SessionProtocolResolver;
  private readonly positionById = new Map<string, number>();
  private readonly boundsByTask = new Map<TaskId, TaskBounds>();
  private readonly ownerByUserEntry = new Map<string, TaskId>();
  private readonly validation = new Map<TaskId, string[]>();

  constructor(
    private readonly state: TaskRuntimeState,
    private readonly sessionId: string,
    private readonly entries: readonly SessionEntry[],
  ) {
    this.resolver = new SessionProtocolResolver(sessionId, entries);
    entries.forEach((entry, index) => this.positionById.set(entry.id, index));
    this.buildBoundsAndOwnership();
  }

  private addValidation(taskId: TaskId, message: string): void {
    const messages = this.validation.get(taskId) ?? [];
    if (!messages.includes(message)) messages.push(message);
    this.validation.set(taskId, messages);
  }

  private semanticDepth(task: Task): number {
    let depth = 1;
    let parentId = task.parentId;
    const seen = new Set<TaskId>([task.id]);
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = this.state.tasks.get(parentId)?.parentId ?? null;
    }
    return depth;
  }

  private buildBoundsAndOwnership(): void {
    for (const task of this.state.tasks.values()) {
      if (task.transcript.sessionId !== this.sessionId) continue;
      try {
        const start = this.resolver.resolveAnchor(task.transcript.beginAnchor);
        const end = task.transcript.endAnchor
          ? this.resolver.resolveAnchor(task.transcript.endAnchor)
          : this.entries.length;
        if (end < start) throw new Error("task range ends before it starts");
        this.boundsByTask.set(task.id, { start, end });
      } catch (error) {
        this.addValidation(
          task.id,
          `cannot resolve task transcript for interaction ownership: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      if (!messageEntry(entry)) continue;
      const owners = [...this.boundsByTask].flatMap(([taskId, bounds]) => {
        if (index < bounds.start || index >= bounds.end) return [];
        const task = this.state.tasks.get(taskId);
        return task ? [{ task, bounds }] : [];
      });
      owners.sort((left, right) => {
        const depth = this.semanticDepth(right.task) - this.semanticDepth(left.task);
        return depth !== 0 ? depth : right.bounds.start - left.bounds.start;
      });
      const owner = owners[0]?.task.id;
      if (owner) this.ownerByUserEntry.set(entry.id, owner);
    }
  }

  taskBounds(taskId: TaskId): TaskBounds {
    const bounds = this.boundsByTask.get(taskId);
    if (!bounds) throw new Error(`Task ${taskId} has no resolvable transcript range in session ${this.sessionId}`);
    return bounds;
  }

  entryPosition(entryId: string): number {
    const position = this.positionById.get(entryId);
    if (position === undefined) throw new Error(`Entry ${entryId} is not on the active session branch`);
    return position;
  }

  issuesForTask(taskId: TaskId, includeDescendants = false): string[] {
    const ids = new Set<TaskId>([taskId]);
    if (includeDescendants) {
      const visit = (id: TaskId): void => {
        const task = this.state.tasks.get(id);
        if (!task) return;
        for (const childId of task.children) {
          if (!ids.has(childId)) {
            ids.add(childId);
            visit(childId);
          }
        }
      };
      visit(taskId);
    }
    return [...ids].flatMap((id) => this.validation.get(id) ?? []);
  }

  private basePending(taskId: TaskId, cutoff: number, visiting: Set<TaskId>): PendingUserMessage[] {
    if (visiting.has(taskId)) {
      this.addValidation(taskId, "task hierarchy contains a cycle while resolving user-message ownership");
      return [];
    }
    const task = this.state.tasks.get(taskId);
    const bounds = this.boundsByTask.get(taskId);
    if (!task || !bounds) return [];
    const nextVisiting = new Set(visiting).add(taskId);
    const effectiveCutoff = Math.min(cutoff, bounds.end);
    const pending: PendingUserMessage[] = [];

    for (let position = bounds.start; position < effectiveCutoff; position += 1) {
      const entry = this.entries[position]!;
      const message = messageEntry(entry);
      if (!message || this.ownerByUserEntry.get(entry.id) !== taskId) continue;
      pending.push({
        entryId: entry.id,
        message,
        sourcePosition: position,
        occurrencePosition: position,
        order: 0,
      });
    }

    for (const childId of task.children) {
      const child = this.state.tasks.get(childId);
      const childBounds = this.boundsByTask.get(childId);
      if (
        !child ||
        !childBounds ||
        child.status !== "completed" ||
        childBounds.end > effectiveCutoff
      ) {
        continue;
      }
      const childPending = this.pendingForTaskInternal(childId, childBounds.end, nextVisiting);
      const divisor = childPending.length + 1;
      childPending.forEach((item, index) => {
        pending.push({
          ...item,
          occurrencePosition: childBounds.end - 0.25 + (index + 1) / (divisor * 10),
          order: index,
        });
      });
    }

    return pending.sort(
      (left, right) =>
        left.occurrencePosition - right.occurrencePosition ||
        left.order - right.order ||
        left.sourcePosition - right.sourcePosition,
    );
  }

  private pendingForTaskInternal(
    taskId: TaskId,
    cutoff: number,
    visiting: Set<TaskId>,
  ): PendingUserMessage[] {
    let pending = this.basePending(taskId, cutoff, visiting);
    const interactions = [...this.state.interactions.values()]
      .filter((interaction) => interaction.taskId === taskId)
      .flatMap((interaction) => {
        const position = this.positionById.get(interaction.assistantEntryId);
        return position === undefined || position >= cutoff ? [] : [{ interaction, position }];
      })
      .sort((left, right) => left.position - right.position);

    for (const { interaction, position } of interactions) {
      const eligible = pending.filter((item) => item.occurrencePosition < position);
      const expected = eligible.map((item) => item.entryId);
      if (JSON.stringify(expected) !== JSON.stringify(interaction.userEntryIds)) {
        this.addValidation(
          taskId,
          `protected interaction ${interaction.id} does not match the task's pending user-message sequence`,
        );
        continue;
      }
      const protectedIds = new Set(interaction.userEntryIds);
      pending = pending.filter((item) => !protectedIds.has(item.entryId));
    }
    return pending.filter((item) => item.occurrencePosition < cutoff);
  }

  pendingForTask(taskId: TaskId, cutoff = this.taskBounds(taskId).end): PendingUserMessage[] {
    return this.pendingForTaskInternal(taskId, cutoff, new Set());
  }

  resolveInteraction(interaction: ProtectedInteraction): ResolvedProtectedInteraction {
    if (interaction.taskId === "" || interaction.range.start.sessionId !== this.sessionId) {
      throw new Error(`Protected interaction ${interaction.id} belongs to another session`);
    }
    const markerPosition = this.entryPosition(interaction.assistantEntryId);
    const unit = this.resolver.resolveProtocolUnit(interaction.markerToolCallId);
    if (
      unit.assistantEntryId !== interaction.assistantEntryId ||
      unit.toolName !== "respond_to_user"
    ) {
      throw new Error(`Protected interaction ${interaction.id} has inconsistent marker provenance`);
    }
    const calls = toolCalls(unit.assistantMessage);
    if (calls.length !== 1 || calls[0]?.id !== interaction.markerToolCallId) {
      throw new Error(`Protected interaction ${interaction.id} marker is not an isolated tool call`);
    }
    const userOccurrences = this.pendingForTask(interaction.taskId, markerPosition);
    if (
      JSON.stringify(userOccurrences.map((item) => item.entryId)) !==
      JSON.stringify(interaction.userEntryIds)
    ) {
      throw new Error(`Protected interaction ${interaction.id} has ambiguous user-message binding`);
    }
    const rangeValidation = this.resolver.validateProtocolRange({
      start: interaction.range.end,
      end: interaction.range.end,
    });
    // A zero-width marker range is not itself useful, but resolving the anchor
    // verifies any persisted result-entry provenance on the interaction.
    if (!rangeValidation.valid) {
      throw new Error(
        `Protected interaction ${interaction.id} marker anchor is invalid: ${rangeValidation.reasons.join("; ")}`,
      );
    }
    return {
      interaction,
      userOccurrences,
      closureEntryIds: this.resolver
        .computeMinimalProtocolClosure(interaction.markerToolCallId)
        .map((item) => item.entryId),
    };
  }
}

export class InteractionService {
  constructor(
    private readonly runtime: LocalTaskRuntime,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {}

  private index(sessionManager: ReadonlySessionManager): InteractionIndex {
    return new InteractionIndex(
      this.runtime.snapshot,
      sessionManager.getSessionId(),
      sessionManager.getBranch(),
    );
  }

  pendingBeforeMarker(
    taskId: TaskId,
    markerToolCallId: string,
    sessionManager: ReadonlySessionManager,
  ): PendingUserMessage[] {
    const resolver = new SessionProtocolResolver(
      sessionManager.getSessionId(),
      sessionManager.getBranch(),
    );
    const marker = resolver.locateToolCall(markerToolCallId);
    return this.index(sessionManager).pendingForTask(taskId, marker.entryIndex);
  }

  protect(
    markerToolCallId: string,
    sessionManager: ReadonlySessionManager,
    append: TaskEventAppender,
  ): ProtectResponseResult {
    const task = this.runtime.activeTask();
    if (!task) throw new Error("respond_to_user requires an active task");
    if (task.transcript.sessionId !== sessionManager.getSessionId()) {
      throw new Error(`Active task ${task.id} belongs to another session`);
    }
    const resolver = new SessionProtocolResolver(
      sessionManager.getSessionId(),
      sessionManager.getBranch(),
    );
    const marker = resolver.locateToolCall(markerToolCallId);
    const calls = toolCalls(marker.message);
    if (
      calls.length !== 1 ||
      calls[0]?.id !== markerToolCallId ||
      calls[0]?.name !== "respond_to_user"
    ) {
      throw new Error("respond_to_user must be the only tool call in its assistant message");
    }
    const pending = this.index(sessionManager).pendingForTask(task.id, marker.entryIndex);
    if (pending.length === 0) {
      throw new Error("respond_to_user found no unanswered user messages in the active task");
    }
    if (pending.length > 1) {
      throw new Error(
        "respond_to_user cannot bind multiple accumulated user messages because API v2 leaves that binding unsettled; close/replay them or mark responses before another user message accumulates",
      );
    }
    const interaction: ProtectedInteraction = {
      id: this.createId(),
      taskId: task.id,
      range: {
        start: anchorForEntry(sessionManager.getSessionId(), pending[0]!.entryId),
        end: markerEndAnchor(sessionManager.getSessionId(), marker.entryId, markerToolCallId),
      },
      userEntryIds: pending.map((item) => item.entryId),
      assistantEntryId: marker.entryId,
      markerToolCallId,
    };
    this.runtime.protect(interaction, this.now(), append);
    return {
      interaction_id: interaction.id,
      task_id: task.id,
      protected_user_message_count: pending.length,
      protected_user_entry_ids: [...interaction.userEntryIds],
    };
  }
}
