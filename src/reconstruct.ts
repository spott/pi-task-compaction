import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { getToolCalls, isFutureTaskMarker, parseBeginMarker, parseCancelMarker, parseEndMarker, parseExpansionDetails } from "./markers.js";
import { transformMessages } from "./transform.js";
import { CANCEL_ENTRY, type IndexedTask, type TaskIndex } from "./types.js";

const futureTaskId = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const taskId = (value as Record<string, unknown>).taskId;
  return typeof taskId === "string" ? taskId : undefined;
};

export function reconstructTaskIndex(branch: SessionEntry[]): TaskIndex {
  const tasks = new Map<string, IndexedTask>();
  const ordered: IndexedTask[] = [];
  const assistantCalls = new Map<string, { entryId: string; entryIndex: number }>();
  let active: IndexedTask | undefined;

  for (let entryIndex = 0; entryIndex < branch.length; entryIndex++) {
    const entry = branch[entryIndex]!;
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const call of getToolCalls(entry.message)) {
        if (!assistantCalls.has(call.id)) assistantCalls.set(call.id, { entryId: entry.id, entryIndex });
      }
      continue;
    }

    if (entry.type === "custom" && entry.customType === CANCEL_ENTRY) {
      const cancel = parseCancelMarker(entry.data);
      if (!cancel) continue;
      const task = tasks.get(cancel.taskId);
      if (!task) continue;
      task.cancel = cancel;
      task.status = "cancelled";
      if (active === task) active = undefined;
      continue;
    }

    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const message = entry.message;
    const begin = parseBeginMarker(message.details, message.toolName);
    if (begin) {
      if (tasks.has(begin.taskId)) {
        const duplicate = tasks.get(begin.taskId)!;
        duplicate.status = "invalid";
        duplicate.rejectionReason = "duplicate begin marker for task ID";
        continue;
      }
      const task: IndexedTask = {
        taskId: begin.taskId,
        objective: begin.objective,
        status: active ? "invalid" : "open",
        begin,
        beginResultEntryId: entry.id,
        rejectionReason: active ? `nested begin while ${active.taskId} is open` : undefined,
      };
      const assistant = assistantCalls.get(begin.toolCallId);
      task.beginAssistantEntryId = assistant?.entryId ?? begin.assistantEntryId;
      task.beginEntryIndex = assistant?.entryIndex;
      tasks.set(task.taskId, task);
      ordered.push(task);
      if (!active) active = task;
      continue;
    }

    const expansion = parseExpansionDetails(message.details, message.toolName);
    if (expansion) {
      const task = tasks.get(expansion.taskId);
      if (task) task.expansionCount = (task.expansionCount ?? 0) + 1;
      continue;
    }

    const end = parseEndMarker(message.details, message.toolName);
    if (end) {
      const task = tasks.get(end.taskId);
      if (!task) {
        const orphan: IndexedTask = {
          taskId: end.taskId,
          objective: end.objective,
          status: "invalid",
          end,
          endResultEntryId: entry.id,
          rejectionReason: "end marker has no matching begin marker",
        };
        tasks.set(orphan.taskId, orphan);
        ordered.push(orphan);
        continue;
      }
      if (task.end) {
        task.status = "invalid";
        task.rejectionReason = "duplicate end marker";
        continue;
      }
      task.end = end;
      task.objective = end.objective;
      task.endResultEntryId = entry.id;
      const assistant = assistantCalls.get(end.endToolCallId);
      task.endAssistantEntryId = assistant?.entryId ?? end.assistantEntryId;
      task.endEntryIndex = entryIndex;
      if (task.status !== "invalid" && task.status !== "cancelled") task.status = "closed";
      if (active === task) active = undefined;
      continue;
    }

    if (isFutureTaskMarker(message.details)) {
      const taskId = futureTaskId(message.details) ?? `future-marker-${entry.id}`;
      if (!tasks.has(taskId)) {
        const task: IndexedTask = {
          taskId,
          objective: "Unknown future task marker",
          status: "invalid",
          rejectionReason: "unsupported task marker schema version",
        };
        tasks.set(taskId, task);
        ordered.push(task);
      }
    }
  }

  const rawMessages = branch.flatMap((entry) => entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry));
  const transformed = transformMessages(rawMessages);
  for (const diagnostic of transformed.diagnostics) {
    const task = tasks.get(diagnostic.taskId);
    if (!task || task.status === "cancelled") continue;
    if (diagnostic.accepted) {
      task.rawChars = diagnostic.rawChars;
      task.summaryChars = diagnostic.summaryChars;
      if (task.status !== "invalid") task.status = "closed";
    } else if (task.status === "closed") {
      task.status = "invalid";
      task.rejectionReason = diagnostic.reason;
    } else if (!task.rejectionReason) {
      task.rejectionReason = diagnostic.reason;
    }
  }

  const open = [...ordered].reverse().find((task) => task.status === "open");
  return { tasks, ordered, open };
}
