import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PreservedOutput } from "../model/output.js";
import type { Task } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";

export const TASK_SUMMARY_CUSTOM_TYPE = "pi-task-framework/task-summary";
export const TASK_SUMMARY_CONTEXT_INSTRUCTION =
  "<task-summary> messages are internal context restoration, not user requests. Do not acknowledge or respond to them directly. Continue the most recent unresolved request, or report completion if that request is finished.";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function appendList(lines: string[], label: string, values: readonly string[]): void {
  lines.push(`${label}:`);
  lines.push(...(values.length > 0 ? values.map((value) => `- ${escapeXml(value)}`) : ["- None"]));
}

export interface RenderedChildTask {
  taskId: string;
  task: string;
}

export function renderTaskSummary(
  task: Pick<Task, "id" | "task" | "children">,
  summary: TaskSummary,
  outputs: readonly PreservedOutput[] = [],
  children: readonly RenderedChildTask[] = task.children.map((taskId) => ({ taskId, task: "(unresolved task)" })),
): string {
  const lines = [
    `<task-summary id="${escapeXml(task.id)}">`,
    `Task: ${escapeXml(task.task)}`,
    `Objective: ${escapeXml(summary.objective)}`,
    `Outcome: ${escapeXml(summary.outcome)}`,
  ];
  const sections: Array<[string, string[]]> = [
    ["Attempted", summary.attempted],
    ["Learnings", summary.learnings],
    ["Decisions", summary.decisions],
    ["Files read", summary.files_read],
    ["Files modified", summary.files_modified],
    ["Verification", summary.verification],
    ["Open threads", summary.open_threads],
  ];
  for (const [label, values] of sections) appendList(lines, label, values);
  if (children.length > 0) {
    lines.push("Direct children:");
    for (const child of children) {
      lines.push(`- ${escapeXml(child.taskId)} — ${escapeXml(child.task)}`);
    }
  }
  if (outputs.length > 0) {
    lines.push("Preserved outputs:");
    for (const output of outputs) {
      lines.push(
        `- ${escapeXml(output.id)} (task ${escapeXml(output.taskId)}, ${escapeXml(output.source.toolName)}, ${
          output.pin ? "pinned" : "recoverable"
        })`,
      );
    }
  }
  lines.push("</task-summary>", "", TASK_SUMMARY_CONTEXT_INSTRUCTION);
  return lines.join("\n");
}

export function makeTaskSummaryMessage(
  task: Pick<Task, "id" | "task" | "children">,
  summary: TaskSummary,
  outputs: readonly PreservedOutput[],
  timestamp: number,
  children: readonly RenderedChildTask[] = [],
): AgentMessage {
  return {
    role: "custom",
    customType: TASK_SUMMARY_CUSTOM_TYPE,
    content: renderTaskSummary(task, summary, outputs, children),
    display: false,
    details: {
      schemaVersion: 1,
      taskId: task.id,
      preservedOutputIds: outputs.map((output) => output.id),
      directChildren: children,
    },
    timestamp,
  } as AgentMessage;
}
