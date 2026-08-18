import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { PreservedOutput, ProtectedInteraction } from "../model/output.js";
import type { SemanticTaskStatus, Task, TaskId } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";
import type { TaskRuntimeState } from "../store/task-runtime.js";
import { InteractionIndex, type PendingUserMessage } from "../store/interactions.js";
import type { TranscriptRange } from "../transcript/anchors.js";
import { canonicalJson, hashToolCall, hashToolResult } from "../transcript/hash.js";
import { SessionProtocolResolver } from "../transcript/protocol.js";
import { makeTaskSummaryMessage } from "./render.js";

export interface ProjectionNode {
  taskId: TaskId;
  range: TranscriptRange;
  status: SemanticTaskStatus;
  children: ProjectionNode[];
  survivors: Survivor[];
  summary?: TaskSummary;
}

interface PositionedSurvivor {
  position: number;
  range: TranscriptRange;
}

export interface PinnedProtocolClosure extends PositionedSurvivor {
  kind: "pinned_protocol_closure";
  output: PreservedOutput;
}

export interface ProtectedInteractionSurvivor extends PositionedSurvivor {
  kind: "protected_interaction";
  interaction: ProtectedInteraction;
}

export type Survivor = PinnedProtocolClosure | ProtectedInteractionSurvivor;

export interface ProjectionRejection {
  taskId: TaskId;
  reasons: string[];
}

export interface ProjectionPlan {
  messages: AgentMessage[];
  projectedTaskIds: TaskId[];
  rejections: ProjectionRejection[];
}

export interface ProjectionInput {
  messages: AgentMessage[];
  sessionId: string;
  branchEntries: readonly SessionEntry[];
  contextEntries: readonly SessionEntry[];
  state: TaskRuntimeState;
}

export interface ProjectionPlanner {
  plan(input: ProjectionInput): ProjectionPlan;
}

interface ContextMessageRecord {
  entryId: string;
  message: AgentMessage;
  messageIndex: number;
}

interface SurvivorMessage {
  entryId: string;
  position: number;
  order: number;
  message: AgentMessage;
}

interface CandidateProjection {
  task: Task;
  startMessageIndex: number;
  endMessageIndex: number;
  replacement: AgentMessage[];
  projectedTaskIds: TaskId[];
}

export function chronologicalSurvivors(survivors: readonly Survivor[]): Survivor[] {
  return [...survivors].sort((left, right) => left.position - right.position);
}

function contextMessageRecords(entries: readonly SessionEntry[]): ContextMessageRecord[] {
  const records: ContextMessageRecord[] = [];
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      records.push({ entryId: entry.id, message, messageIndex: records.length });
    }
  }
  return records;
}

function sameMessages(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => canonicalJson(message) === canonicalJson(right[index]));
}

function subtreeIds(state: TaskRuntimeState, taskId: TaskId): TaskId[] {
  const ids: TaskId[] = [];
  const seen = new Set<TaskId>();
  const visit = (id: TaskId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const task = state.tasks.get(id);
    if (!task) return;
    ids.push(id);
    for (const childId of task.children) visit(childId);
  };
  visit(taskId);
  return ids;
}

function projectionCandidates(state: TaskRuntimeState): Task[] {
  const selected: Task[] = [];
  const visited = new Set<TaskId>();
  const visit = (task: Task): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    if (task.status === "completed") {
      selected.push(task);
      return;
    }
    for (const childId of task.children) {
      const child = state.tasks.get(childId);
      if (child) visit(child);
    }
  };
  for (const rootId of state.roots) {
    const root = state.tasks.get(rootId);
    if (root) visit(root);
  }
  for (const task of state.tasks.values()) {
    if (!visited.has(task.id) && (!task.parentId || !state.tasks.has(task.parentId))) visit(task);
  }
  return selected;
}

function messageFromEntry(entry: SessionEntry, label: string): AgentMessage {
  const messages = sessionEntryToContextMessages(entry);
  if (messages.length !== 1) throw new Error(`${label} does not identify exactly one provider-context message`);
  return messages[0]!;
}

function containsSpecialSummary(entries: readonly SessionEntry[]): string | undefined {
  const special = entries.find((entry) => entry.type === "compaction" || entry.type === "branch_summary");
  return special ? `task range crosses Pi ${special.type.replace("_", " ")} entry ${special.id}` : undefined;
}

function replayMessages(messages: readonly PendingUserMessage[]): AgentMessage[] {
  return messages.map((item) => ({ ...item.message }));
}

/**
 * Final M6 projection engine. It only replaces complete, fully visible,
 * protocol-valid task subtrees. Every ambiguity retains the original region.
 */
export class LocalProjectionPlanner implements ProjectionPlanner {
  plan(input: ProjectionInput): ProjectionPlan {
    const candidates = projectionCandidates(input.state);
    if (candidates.length === 0) {
      return { messages: input.messages, projectedTaskIds: [], rejections: [] };
    }

    const records = contextMessageRecords(input.contextEntries);
    if (!sameMessages(input.messages, records.map((record) => record.message))) {
      return {
        messages: input.messages,
        projectedTaskIds: [],
        rejections: candidates.map((task) => ({
          taskId: task.id,
          reasons: ["incoming provider context does not align with active Pi context entries; retained subtree"],
        })),
      };
    }

    const resolver = new SessionProtocolResolver(input.sessionId, input.branchEntries);
    const interactions = new InteractionIndex(input.state, input.sessionId, input.branchEntries);
    const branchPosition = new Map(input.branchEntries.map((entry, index) => [entry.id, index]));
    const contextByEntry = new Map(records.map((record) => [record.entryId, record]));
    const projections: CandidateProjection[] = [];
    const rejections: ProjectionRejection[] = [];

    for (const task of candidates) {
      const reasons: string[] = [];
      const range: TranscriptRange | undefined = task.transcript.endAnchor
        ? { start: task.transcript.beginAnchor, end: task.transcript.endAnchor }
        : undefined;
      if (!task.summary) reasons.push("completed task has no retained summary");
      if (!range) reasons.push("completed task has no terminal transcript anchor");
      if (task.transcript.sessionId !== input.sessionId) {
        reasons.push(`task is owned by another session (${task.transcript.sessionId})`);
      }
      if (!range || reasons.length > 0) {
        rejections.push({ taskId: task.id, reasons });
        continue;
      }

      let resolved;
      try {
        resolved = resolver.resolveRange(range);
      } catch (error) {
        rejections.push({
          taskId: task.id,
          reasons: [error instanceof Error ? error.message : String(error)],
        });
        continue;
      }

      const protocol = resolver.validateProtocolRange(range);
      if (!protocol.valid) reasons.push(...protocol.reasons);
      const specialSummary = containsSpecialSummary(resolved.entries);
      if (specialSummary) reasons.push(specialSummary);

      const descendants = subtreeIds(input.state, task.id);
      const descendantSet = new Set(descendants);
      for (const descendantId of descendants) {
        const descendant = input.state.tasks.get(descendantId)!;
        if (descendant.status !== "completed") {
          reasons.push(`descendant task ${descendantId} is not completed`);
          continue;
        }
        if (!descendant.transcript.endAnchor) {
          reasons.push(`descendant task ${descendantId} has no terminal transcript anchor`);
          continue;
        }
        try {
          const childRange = resolver.resolveRange({
            start: descendant.transcript.beginAnchor,
            end: descendant.transcript.endAnchor,
          });
          if (childRange.start < resolved.start || childRange.end > resolved.end) {
            reasons.push(`descendant task ${descendantId} falls outside ancestor transcript range`);
          }
        } catch (error) {
          reasons.push(
            `descendant task ${descendantId} range is ambiguous: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      for (const issue of input.state.issues) {
        const position = branchPosition.get(issue.entryId);
        if (position !== undefined && position >= resolved.start && position < resolved.end) {
          reasons.push(`task event issue at ${issue.entryId}: ${issue.message}`);
        }
      }
      reasons.push(...interactions.issuesForTask(task.id, true));

      const rangeMessageEntries = resolved.entries.filter(
        (entry) => sessionEntryToContextMessages(entry).length > 0,
      );
      const visible = rangeMessageEntries.flatMap((entry) => {
        const record = contextByEntry.get(entry.id);
        return record ? [record] : [];
      });
      if (visible.length === 0 && rangeMessageEntries.length > 0) {
        // A prior global Pi compaction already removed this entire task range.
        // Nothing task-local remains to replace.
        continue;
      }
      if (visible.length !== rangeMessageEntries.length) {
        reasons.push("task transcript is only partially visible after Pi context construction");
      }
      const messageIndexes = visible.map((item) => item.messageIndex);
      if (
        messageIndexes.length > 0 &&
        messageIndexes.some((value, index) => index > 0 && value !== messageIndexes[index - 1]! + 1)
      ) {
        reasons.push("task transcript messages are not contiguous in provider context");
      }

      const survivorMessages: SurvivorMessage[] = [];
      let survivorOrder = 0;
      const addSurvivor = (entryId: string, position: number): void => {
        const entryPosition = branchPosition.get(entryId);
        const entry = entryPosition === undefined ? undefined : input.branchEntries[entryPosition];
        if (!entry) {
          reasons.push(`survivor entry ${entryId} is not on the active branch`);
          return;
        }
        try {
          survivorMessages.push({
            entryId,
            position,
            order: survivorOrder++,
            message: messageFromEntry(entry, `survivor entry ${entryId}`),
          });
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : String(error));
        }
      };

      const subtreeOutputs = [...input.state.outputs.values()].filter((output) =>
        descendantSet.has(output.taskId),
      );
      for (const output of subtreeOutputs.filter((item) => item.pin)) {
        const closure = output.source.closure;
        if (!closure || closure.length === 0) {
          reasons.push(`pinned output ${output.id} has no protocol closure`);
          continue;
        }
        const validation = resolver.validateClosure(closure);
        if (!validation.valid) reasons.push(...validation.reasons.map((reason) => `pinned output ${output.id}: ${reason}`));
        try {
          const unit = resolver.resolveProtocolUnit(output.source.toolCallId);
          if (
            unit.assistantEntryId !== output.source.assistantEntryId ||
            unit.resultEntryId !== output.source.resultEntryId ||
            unit.toolName !== output.source.toolName
          ) {
            reasons.push(`pinned output ${output.id} failed source provenance validation`);
          }
          if (
            hashToolCall(unit.toolCallBlock) !== output.source.callHash ||
            hashToolResult(unit.result) !== output.source.resultHash
          ) {
            reasons.push(`pinned output ${output.id} failed source integrity validation`);
          }
          const expected = resolver.computeMinimalProtocolClosure(output.source.toolCallId);
          if (canonicalJson(closure) !== canonicalJson(expected)) {
            reasons.push(`pinned output ${output.id} closure is incomplete or over-broad`);
          }
        } catch (error) {
          reasons.push(`pinned output ${output.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const item of closure) {
          const position = branchPosition.get(item.entryId);
          if (position === undefined || position < resolved.start || position >= resolved.end) {
            reasons.push(`pinned output ${output.id} closure escapes the candidate task range`);
            continue;
          }
          addSurvivor(item.entryId, position);
        }
      }

      for (const interaction of input.state.interactions.values()) {
        if (!descendantSet.has(interaction.taskId)) continue;
        try {
          const protectedInteraction = interactions.resolveInteraction(interaction);
          for (const occurrence of protectedInteraction.userOccurrences) {
            addSurvivor(occurrence.entryId, occurrence.occurrencePosition);
          }
          for (const entryId of protectedInteraction.closureEntryIds) {
            const position = branchPosition.get(entryId);
            if (position === undefined || position < resolved.start || position >= resolved.end) {
              reasons.push(`protected interaction ${interaction.id} closure escapes the candidate task range`);
              continue;
            }
            addSurvivor(entryId, position);
          }
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : String(error));
        }
      }

      let unanswered: PendingUserMessage[] = [];
      try {
        unanswered = interactions.pendingForTask(task.id, resolved.end);
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
      reasons.push(...interactions.issuesForTask(task.id, true));

      if (reasons.length > 0 || messageIndexes.length === 0 || !task.summary) {
        rejections.push({ taskId: task.id, reasons: [...new Set(reasons)] });
        continue;
      }

      const deduplicated = new Map<string, SurvivorMessage>();
      for (const survivor of survivorMessages.sort(
        (left, right) => left.position - right.position || left.order - right.order,
      )) {
        if (!deduplicated.has(survivor.entryId)) deduplicated.set(survivor.entryId, survivor);
      }
      const replacement: AgentMessage[] = [
        ...[...deduplicated.values()].map((item) => item.message),
        makeTaskSummaryMessage(
          task,
          task.summary,
          subtreeOutputs,
          task.completedAt ?? Date.now(),
          task.children.map((taskId) => ({
            taskId,
            task: input.state.childDescriptions.get(taskId) ?? "(unresolved task)",
          })),
        ),
        ...replayMessages(unanswered),
      ];
      projections.push({
        task,
        startMessageIndex: messageIndexes[0]!,
        endMessageIndex: messageIndexes.at(-1)! + 1,
        replacement,
        projectedTaskIds: descendants,
      });
    }

    projections.sort((left, right) => right.startMessageIndex - left.startMessageIndex);
    const messages = [...input.messages];
    const projectedTaskIds: TaskId[] = [];
    let previousStart = Number.POSITIVE_INFINITY;
    for (const projection of projections) {
      if (projection.endMessageIndex > previousStart) {
        rejections.push({
          taskId: projection.task.id,
          reasons: ["candidate projection overlaps another accepted task region"],
        });
        continue;
      }
      messages.splice(
        projection.startMessageIndex,
        projection.endMessageIndex - projection.startMessageIndex,
        ...projection.replacement,
      );
      projectedTaskIds.push(...projection.projectedTaskIds);
      previousStart = projection.startMessageIndex;
    }

    return {
      messages,
      projectedTaskIds: [...new Set(projectedTaskIds)],
      rejections,
    };
  }
}

/** Explicit safe fallback used by tests and non-production diagnostic callers. */
export class RetainingProjectionPlanner implements ProjectionPlanner {
  plan(input: ProjectionInput): ProjectionPlan {
    return {
      messages: input.messages,
      projectedTaskIds: [],
      rejections: projectionCandidates(input.state).map((task) => ({
        taskId: task.id,
        reasons: ["retaining projection planner selected; retained subtree"],
      })),
    };
  }
}
