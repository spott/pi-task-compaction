import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { taskFrameworkGuidance } from "../src/guidance.js";

function config(
  summaries: boolean,
  compaction: boolean,
  agents: boolean,
): Config {
  return {
    features: { tasks: true, summaries, compaction, agents },
    limits: { maxTaskDepth: 3, maxAgentDepth: 2, maxConcurrentAgents: 4 },
    shutdown: { workerDrainMs: 0, workerTermGraceMs: 5_000, workerKillGraceMs: 2_000 },
  };
}

describe("M12 conditional workflow guidance", () => {
  it("snapshots the exact guidance surface for every distinct supported feature combination", () => {
    const surfaces = {
      tasks_only: taskFrameworkGuidance(config(false, false, false)),
      tasks_summaries: taskFrameworkGuidance(config(true, false, false)),
      tasks_summaries_compaction: taskFrameworkGuidance(config(true, true, false)),
      agents_without_summaries: taskFrameworkGuidance(config(false, false, true)),
      tasks_summaries_agents: taskFrameworkGuidance(config(true, false, true)),
      full: taskFrameworkGuidance(config(true, true, true)),
    };
    expect(surfaces).toMatchInlineSnapshot(`
      {
        "agents_without_summaries": {
          "beginTask": [
            "[task-compaction-tool] Use begin_task for bounded work whose detailed transcript can later be replaced by a durable task result; avoid nesting trivial mechanical steps.",
            "[task-compaction-tool] Close an active child with end_task before closing its parent.",
            "[task-compaction-tool] Local begin_task depth resets inside each spawned worker even though global semantic ancestry can be deeper.",
          ],
          "endTask": [
            "[task-compaction-tool] Use end_task to close completed work; this ablation authors the normal structured summary but does not retain it after the turn.",
          ],
          "inspectTask": [
            "[task-compaction-tool] Use summary first with inspect_task and inspect bounded history only when details materially affect the current work.",
            "[task-compaction-tool] Use inspect_task list or search to locate entry IDs, then entry for an exact private JSONL locator; transcript artifacts are sensitive private caches, so do not copy them into the repository.",
          ],
          "joinTasks": [
            "[task-compaction-tool] Use join_tasks only when results are needed; wait=all never cancels siblings after a failure, while wait=any returns at the first terminal result.",
          ],
          "pollTask": [
            "[task-compaction-tool] Use poll_task sparingly for lifecycle checks; use join_tasks when worker results are actually needed.",
          ],
          "preserveOutput": [
            "[task-compaction-tool] Use preserve_output only for completed ordinary-tool results that will matter after the active task closes.",
          ],
          "respondToUser": [],
          "spawnTask": [
            "[task-compaction-tool] Use spawn_task inside or outside an active task only for independent work that is safe in the shared working tree.",
            "[task-compaction-tool] After spawn_task returns, continue useful parent work while the worker runs; required_context is unavailable without retained summaries, so use available_context for optional references.",
          ],
        },
        "full": {
          "beginTask": [
            "[task-compaction-tool] Use begin_task for bounded work whose detailed transcript can later be replaced by a durable task result; avoid nesting trivial mechanical steps.",
            "[task-compaction-tool] Close an active child with end_task before closing its parent.",
            "[task-compaction-tool] Local begin_task depth resets inside each spawned worker even though global semantic ancestry can be deeper.",
          ],
          "endTask": [
            "[task-compaction-tool] Use end_task as soon as a task milestone is complete; make its retained summary sufficient to continue without the detailed body.",
            "[task-compaction-tool] A parent end_task summary must integrate meaningful conclusions from its direct children rather than merely listing their IDs.",
          ],
          "inspectTask": [
            "[task-compaction-tool] Use summary first with inspect_task and inspect bounded history only when details materially affect the current work.",
            "[task-compaction-tool] Use inspect_task list or search to locate entry IDs, then entry for an exact private JSONL locator; transcript artifacts are sensitive private caches, so do not copy them into the repository.",
          ],
          "joinTasks": [
            "[task-compaction-tool] Use join_tasks only when results are needed; wait=all never cancels siblings after a failure, while wait=any returns at the first terminal result.",
          ],
          "pollTask": [
            "[task-compaction-tool] Use poll_task sparingly for lifecycle checks; use join_tasks when worker results are actually needed.",
          ],
          "preserveOutput": [
            "[task-compaction-tool] Use preserve_output only for completed ordinary-tool results that will matter after the active task closes.",
            "[task-compaction-tool] Set preserve_output pin=true only for sparse references that must remain verbatim in provider context, such as a completed read of an approved plan file or immutable documentation; ordinary preserved outputs remain recoverable by ID.",
          ],
          "respondToUser": [
            "[task-compaction-tool] Use respond_to_user as the only tool call when answering one user interruption that should survive task projection verbatim while the task remains active.",
            "[task-compaction-tool] If an unanswered user message does not need a protected response yet, leave it unmarked and task projection will replay it after task closure.",
          ],
          "spawnTask": [
            "[task-compaction-tool] Use spawn_task inside or outside an active task only for independent work that is safe in the shared working tree.",
            "[task-compaction-tool] After spawn_task returns, continue useful parent work while the worker runs; use required_context only for completed retained summaries and available_context for optional references.",
          ],
        },
        "tasks_only": {
          "beginTask": [
            "[task-compaction-tool] Use begin_task for bounded work whose detailed transcript can later be replaced by a durable task result; avoid nesting trivial mechanical steps.",
            "[task-compaction-tool] Close an active child with end_task before closing its parent.",
          ],
          "endTask": [
            "[task-compaction-tool] Use end_task to close completed work; this ablation authors the normal structured summary but does not retain it after the turn.",
          ],
          "inspectTask": [
            "[task-compaction-tool] Use summary first with inspect_task and inspect bounded history only when details materially affect the current work.",
            "[task-compaction-tool] Use inspect_task list or search to locate entry IDs, then entry for an exact private JSONL locator; transcript artifacts are sensitive private caches, so do not copy them into the repository.",
          ],
          "joinTasks": [],
          "pollTask": [],
          "preserveOutput": [
            "[task-compaction-tool] Use preserve_output only for completed ordinary-tool results that will matter after the active task closes.",
          ],
          "respondToUser": [],
          "spawnTask": [],
        },
        "tasks_summaries": {
          "beginTask": [
            "[task-compaction-tool] Use begin_task for bounded work whose detailed transcript can later be replaced by a durable task result; avoid nesting trivial mechanical steps.",
            "[task-compaction-tool] Close an active child with end_task before closing its parent.",
          ],
          "endTask": [
            "[task-compaction-tool] Use end_task as soon as a task milestone is complete; make its retained summary sufficient to continue without the detailed body.",
            "[task-compaction-tool] A parent end_task summary must integrate meaningful conclusions from its direct children rather than merely listing their IDs.",
          ],
          "inspectTask": [
            "[task-compaction-tool] Use summary first with inspect_task and inspect bounded history only when details materially affect the current work.",
            "[task-compaction-tool] Use inspect_task list or search to locate entry IDs, then entry for an exact private JSONL locator; transcript artifacts are sensitive private caches, so do not copy them into the repository.",
          ],
          "joinTasks": [],
          "pollTask": [],
          "preserveOutput": [
            "[task-compaction-tool] Use preserve_output only for completed ordinary-tool results that will matter after the active task closes.",
          ],
          "respondToUser": [],
          "spawnTask": [],
        },
        "tasks_summaries_agents": {
          "beginTask": [
            "[task-compaction-tool] Use begin_task for bounded work whose detailed transcript can later be replaced by a durable task result; avoid nesting trivial mechanical steps.",
            "[task-compaction-tool] Close an active child with end_task before closing its parent.",
            "[task-compaction-tool] Local begin_task depth resets inside each spawned worker even though global semantic ancestry can be deeper.",
          ],
          "endTask": [
            "[task-compaction-tool] Use end_task as soon as a task milestone is complete; make its retained summary sufficient to continue without the detailed body.",
            "[task-compaction-tool] A parent end_task summary must integrate meaningful conclusions from its direct children rather than merely listing their IDs.",
          ],
          "inspectTask": [
            "[task-compaction-tool] Use summary first with inspect_task and inspect bounded history only when details materially affect the current work.",
            "[task-compaction-tool] Use inspect_task list or search to locate entry IDs, then entry for an exact private JSONL locator; transcript artifacts are sensitive private caches, so do not copy them into the repository.",
          ],
          "joinTasks": [
            "[task-compaction-tool] Use join_tasks only when results are needed; wait=all never cancels siblings after a failure, while wait=any returns at the first terminal result.",
          ],
          "pollTask": [
            "[task-compaction-tool] Use poll_task sparingly for lifecycle checks; use join_tasks when worker results are actually needed.",
          ],
          "preserveOutput": [
            "[task-compaction-tool] Use preserve_output only for completed ordinary-tool results that will matter after the active task closes.",
          ],
          "respondToUser": [],
          "spawnTask": [
            "[task-compaction-tool] Use spawn_task inside or outside an active task only for independent work that is safe in the shared working tree.",
            "[task-compaction-tool] After spawn_task returns, continue useful parent work while the worker runs; use required_context only for completed retained summaries and available_context for optional references.",
          ],
        },
        "tasks_summaries_compaction": {
          "beginTask": [
            "[task-compaction-tool] Use begin_task for bounded work whose detailed transcript can later be replaced by a durable task result; avoid nesting trivial mechanical steps.",
            "[task-compaction-tool] Close an active child with end_task before closing its parent.",
          ],
          "endTask": [
            "[task-compaction-tool] Use end_task as soon as a task milestone is complete; make its retained summary sufficient to continue without the detailed body.",
            "[task-compaction-tool] A parent end_task summary must integrate meaningful conclusions from its direct children rather than merely listing their IDs.",
          ],
          "inspectTask": [
            "[task-compaction-tool] Use summary first with inspect_task and inspect bounded history only when details materially affect the current work.",
            "[task-compaction-tool] Use inspect_task list or search to locate entry IDs, then entry for an exact private JSONL locator; transcript artifacts are sensitive private caches, so do not copy them into the repository.",
          ],
          "joinTasks": [],
          "pollTask": [],
          "preserveOutput": [
            "[task-compaction-tool] Use preserve_output only for completed ordinary-tool results that will matter after the active task closes.",
            "[task-compaction-tool] Set preserve_output pin=true only for sparse references that must remain verbatim in provider context, such as a completed read of an approved plan file or immutable documentation; ordinary preserved outputs remain recoverable by ID.",
          ],
          "respondToUser": [
            "[task-compaction-tool] Use respond_to_user as the only tool call when answering one user interruption that should survive task projection verbatim while the task remains active.",
            "[task-compaction-tool] If an unanswered user message does not need a protected response yet, leave it unmarked and task projection will replay it after task closure.",
          ],
          "spawnTask": [],
        },
      }
    `);
  });

  it("prefixes every rule and gives concrete pinning examples", () => {
    const guidance = taskFrameworkGuidance(config(true, true, true));
    const rules = Object.values(guidance).flat();

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).toMatch(/^\[task-compaction-tool\] .+$/);
    }
    const pinning = guidance.preserveOutput.join("\n");
    expect(pinning).toContain("approved plan file");
    expect(pinning).toContain("immutable documentation");
  });

  it("does not leak compaction or agent guidance into disabled ablation arms", () => {
    const withoutCompactionOrAgents = JSON.stringify(
      taskFrameworkGuidance(config(true, false, false)),
    );
    expect(withoutCompactionOrAgents).not.toContain("replay");
    expect(withoutCompactionOrAgents).not.toContain("provider context");
    expect(withoutCompactionOrAgents).not.toContain("spawn_task");
    expect(withoutCompactionOrAgents).not.toContain("poll_task");
    expect(withoutCompactionOrAgents).not.toContain("join_tasks");

    const tasksOnly = JSON.stringify(taskFrameworkGuidance(config(false, false, false)));
    expect(tasksOnly).not.toContain("retained summary sufficient");
    expect(tasksOnly).toContain("does not retain it after the turn");
  });
});
