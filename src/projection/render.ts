import type { Task } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";

export function renderTaskSummary(task: Pick<Task, "id" | "task">, summary: TaskSummary): string {
  const lines = [
    `<task-summary id="${task.id}">`,
    `Task: ${task.task}`,
    `Objective: ${summary.objective}`,
    `Outcome: ${summary.outcome}`,
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
  for (const [label, values] of sections) {
    lines.push(`${label}:`);
    lines.push(...(values.length > 0 ? values.map((value) => `- ${value}`) : ["- None"]));
  }
  lines.push("</task-summary>");
  return lines.join("\n");
}
