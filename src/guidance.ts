import type { Config } from "./config.js";

export interface TaskFrameworkGuidance {
  beginTask: string[];
  preserveOutput: string[];
  respondToUser: string[];
  endTask: string[];
  inspectTask: string[];
  spawnTask: string[];
  pollTask: string[];
  joinTasks: string[];
}

/**
 * Generate only the workflow guidance supported by the enabled feature set.
 * Tool registration and these bullets together form the ablation surface.
 */
export function taskFrameworkGuidance(config: Config): TaskFrameworkGuidance {
  const beginTask = [
    "Use begin_task for bounded work whose detailed transcript can later be replaced by a durable task result; avoid nesting trivial mechanical steps.",
    "Close an active child with end_task before closing its parent.",
  ];
  if (config.features.agents) {
    beginTask.push(
      "Local begin_task depth resets inside each spawned worker even though global semantic ancestry can be deeper.",
    );
  }

  const endTask = config.features.summaries
    ? [
        "Use end_task as soon as a task milestone is complete; make its retained summary sufficient to continue without the detailed body.",
        "A parent end_task summary must integrate meaningful conclusions from its direct children rather than merely listing their IDs.",
      ]
    : [
        "Use end_task to close completed work; this ablation authors the normal structured summary but does not retain it after the turn.",
      ];

  return {
    beginTask,
    preserveOutput: [
      "Use preserve_output only for completed ordinary-tool results that will matter after the active task closes.",
      ...(config.features.compaction
        ? [
            "Set preserve_output pin=true only for sparse, immutable references that must remain verbatim in provider context; ordinary preserved outputs remain recoverable by ID.",
          ]
        : []),
    ],
    respondToUser: config.features.compaction
      ? [
          "Use respond_to_user as the only tool call when answering one user interruption that should survive task projection verbatim while the task remains active.",
          "If an unanswered user message does not need a protected response yet, leave it unmarked and task projection will replay it after task closure.",
        ]
      : [],
    endTask,
    inspectTask: [
      "Use summary first with inspect_task and inspect bounded history only when details materially affect the current work.",
      "Use inspect_task list or search to locate entry IDs, then entry for an exact private JSONL locator; transcript artifacts are sensitive private caches, so do not copy them into the repository.",
    ],
    spawnTask: config.features.agents
      ? [
          "Use spawn_task inside or outside an active task only for independent work that is safe in the shared working tree.",
          config.features.summaries
            ? "After spawn_task returns, continue useful parent work while the worker runs; use required_context only for completed retained summaries and available_context for optional references."
            : "After spawn_task returns, continue useful parent work while the worker runs; required_context is unavailable without retained summaries, so use available_context for optional references.",
        ]
      : [],
    pollTask: config.features.agents
      ? ["Use poll_task sparingly for lifecycle checks; use join_tasks when worker results are actually needed."]
      : [],
    joinTasks: config.features.agents
      ? [
          "Use join_tasks only when results are needed; wait=all never cancels siblings after a failure, while wait=any returns at the first terminal result.",
        ]
      : [],
  };
}
