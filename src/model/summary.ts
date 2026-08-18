export interface TaskSummary {
  objective: string;
  outcome: string;
  attempted: string[];
  learnings: string[];
  decisions: string[];
  files_read: string[];
  files_modified: string[];
  verification: string[];
  open_threads: string[];
}

export const TASK_SUMMARY_FIELDS = [
  "objective",
  "outcome",
  "attempted",
  "learnings",
  "decisions",
  "files_read",
  "files_modified",
  "verification",
  "open_threads",
] as const satisfies readonly (keyof TaskSummary)[];
