# Long-Run Task Compaction Retrospective

## Context

The greenfield v2 implementation was built during the longest run yet performed with the task-compaction workflow. The run crossed many compaction boundaries and covered repository archival, the semantic task foundation, transcript projection, preservation, inspection, workers, global compaction, evaluation telemetry, a sibling harness integration, fixtures, and final verification.

One important limitation applies to these observations: the run itself was managed by the previously installed task-compaction framework while v2 was the implementation target. It therefore provides strong evidence about long-running workflow and handoff quality, but it was not direct live dogfooding of v2's projection, pinning, inspection, or worker APIs.

## Overall assessment

The workflow was reliable. No material state loss was observed across the compaction boundaries. Each restored region retained the active repository and branch, commit and dirty state, verification status, important decisions, and the next todo. A partially completed worker milestone also resumed correctly instead of being incorrectly marked complete.

The primary weakness was not correctness but context efficiency. End-of-task summaries were comprehensive enough to resume safely, but they accumulated repeated audit information that was rarely needed by subsequent work.

## What worked well

### Reliable continuation

The summaries consistently preserved the facts needed to resume work:

- current repository, branch, commit, and dirty state;
- files changed and durable artifacts created;
- checks run and their outcomes;
- decisions that were not obvious from the code;
- unresolved constraints and the next todo item.

This remained reliable over many sequential implementation regions.

### Separation of todos from compaction tasks

The todo ledger remained the authority for deliverables and dependencies, while task summaries carried historical facts and recovery context. This prevented a compaction boundary from being mistaken for completion of a project milestone.

The distinction was especially useful when the worker implementation was split into a durable foundation and a later orchestration slice: the compaction region closed, but the todo correctly remained in progress.

### Adaptive task sizing

The work split naturally at coherent milestones instead of treating the whole project as one region. Useful splits included:

- worker routing/bootstrap foundation versus public process orchestration;
- extension telemetry versus sibling harness support;
- harness support versus checked-in evaluation matrices and workloads.

These boundaries made the summaries meaningful and limited the amount of disposable transcript retained at any one time.

### Honest verification state

The handoffs generally distinguished among:

- unit and integration tests that passed;
- real subprocess behavior that was verified without a provider;
- provider payload construction tested through interception;
- behavior verified only with fakes;
- live paid evaluation that was not run.

That distinction is critical after compaction because the restored model otherwise has only its own prior summary as evidence.

### Appropriate restraint around preservation

No output was preserved during this run. That was the correct choice: most important outputs were reproducible file reads, test results that could be rerun, or durable commits and artifacts. Preserving or pinning them would have added context and protocol complexity without improving recovery.

## What could be improved

### End-of-task summaries were too repetitive

The most obvious issue was repetition across summaries. The following information was often restated even when unchanged:

- exhaustive lists of files read;
- routine implementation steps under `attempted`;
- archive branches and tags;
- dependency and runtime versions;
- linked worktree state;
- remaining work already represented by the todo ledger.

The valuable continuation packet was usually much smaller: outcome, current commit/state, changed files, verification, non-obvious decisions, and the next todo.

### Root summaries accumulated linearly

Each milestone was represented as a separate root task. Even if every root body is compacted correctly, its summary remains part of the continuing history. A sufficiently long project can therefore accumulate many root summaries.

For large projects, an optional umbrella task with milestone children may work better. Completed children can be projected while the parent remains active, and the final parent closure can eventually replace the whole project with one summary. This should be guidance rather than a requirement: an umbrella task that is too broad or whose body cannot be projected safely can create its own retention problems.

### Manual continuation nudges were needed

The user sent `continue` during the run. Unfinished work should resume automatically after task restoration, or the interface should display a non-model progress state showing that work is still active. User-authored continuation messages are unnecessary context and may interact poorly with unanswered-message replay semantics.

### The term “task” is overloaded

Several different objects are called tasks:

- semantic compaction tasks;
- todo items and deliverables;
- worker assignments;
- the user's overall request.

The workflow prompt successfully kept them separate, but the tool names alone do not. Tool descriptions should explicitly say that a semantic task is a context-retention boundary and is not necessarily one-to-one with a todo item or user request.

### Pinning was not ergonomically tested

The v2 pinning implementation has extensive protocol and provider-builder tests, but this run gives no evidence about whether a model will choose preservation versus pinning appropriately during ordinary work. That needs deliberate dogfooding.

## Recommended `end_task` prompt

The prompt should frame the summary as a continuation packet rather than an audit report:

> Write a continuation packet, not a transcript or changelog. Include only:
>
> 1. the outcome and current repository state;
> 2. changed paths and commits;
> 3. checks run, their results, and anything still unverified;
> 4. decisions or invariants not obvious from the code;
> 5. blockers and remaining todo IDs.
>
> Omit exhaustive files-read lists, routine attempts, unchanged facts, and repeated plan text. Prefer verified facts over narrative.

Additional recommendations:

- Give the projected summary a soft target of roughly 2,500–4,000 characters.
- Put verification status near the top and distinguish **verified**, **unverified**, and **failed** claims.
- Require `open_threads` to reference todo IDs rather than duplicate the remaining plan.
- Keep detailed audit data durable and available through `inspect_task`, but do not automatically inject all of it into future provider context.
- Avoid repeating repository facts unless they changed or are necessary to resume safely.

The v2 API's removal of some v1-only summary fields is already directionally consistent with this recommendation.

## Recommended preservation and pinning guidance

The distinction between preservation and pinning should be explicit in the tool description:

- **Preserve:** store the exact output for explicit retrieval later; it has no ongoing projected-context cost.
- **Pin:** preserve the output and retain its provider-valid original call/result closure in projected context.

The description should also warn that:

- pinning one call from a multi-call assistant message may retain all sibling calls and results needed for a valid provider closure;
- pin state is immutable, so the choice cannot silently change later;
- pinning is appropriate only when the model must retain the content automatically;
- `read_preserved_output` re-emits the complete body and may consume substantial context;
- preserved-output references can be discovered through `inspect_task` summary metadata.

A successful pin result should report its actual footprint, for example:

```text
Preserved output abc123.
Pinned closure: 4 session entries, approximately 3,800 estimated tokens.
Included sibling calls: bash, read.
```

Reporting the closure size and included siblings would teach appropriate use more effectively than guidance alone.

The delayed `end_task.preserve_outputs` path is a good ergonomic complement to immediate preservation because it allows a task to validate all requested sources atomically before closing.

## Recommended tool-description changes

### `begin_task`

State that it opens one coherent context-retention region, not a todo item. Recommend milestone children under an umbrella parent when a large project would otherwise create many unrelated root summaries. Encourage the task text to include both the objective and its completion condition.

### `end_task`

Use the phrase “continuation packet.” Remind the model to update the todo ledger before closure and not to restate the todo plan in the summary.

### `inspect_task`

Describe the cost ladder:

1. `summary` is the cheap default;
2. `list` and `search` are bounded navigation;
3. `entry` and `transcript` materialize exact private artifacts and should be used only when the summary is insufficient.

### `respond_to_user`

Prominently state that it must be the only tool call in its assistant message and currently binds exactly one pending user message. Multiple accumulated messages remain an API-level unsettled case and therefore hard-error.

### `spawn_task`, `poll_task`, and `join_tasks`

Clarify that spawning is asynchronous, sparse polling is preferred, and `wait: "any"` does not cancel siblings. Explain the difference between required summary context and available reference-only context.

### Task status surfaces

Explain that `derived_failed` is operational evidence from worker/process state and does not rewrite the task's durable semantic status.

## Suggested live v2 dogfood exercise

A useful next evaluation would run one real, long project under v2 and deliberately exercise:

1. an umbrella task with several milestone children;
2. one preserved but unpinned output;
3. one pinned output from a multi-call assistant message;
4. inspection after several local projections;
5. a successful worker and a registry-derived worker failure;
6. global compaction while a parent task remains open;
7. resumption after enough completed roots or children to measure summary accumulation.

That run should record:

- projected context size after every task closure;
- summary size and repeated-fact ratio;
- pinned closure entry and token footprint;
- whether the model selected preserve versus pin correctly;
- how often `inspect_task` or `read_preserved_output` was needed;
- whether any manual continuation message was required;
- whether restored verification claims remained accurate.

## Prioritized follow-up

1. **S — Rewrite the `end_task` summary guidance.** This is the clearest improvement supported by the run.
2. **S — Clarify preserve-versus-pin costs and return closure metrics.** The protocol is sound, but the choice needs better feedback.
3. **S — Clarify task/todo/worker terminology in tool descriptions.** This reduces dependence on large external workflow prompts.
4. **M — Add automatic continuation or non-model progress signaling.** This should eliminate user-authored `continue` messages.
5. **M — Perform a deliberate live v2 dogfood run.** This is necessary before drawing conclusions about v2 projection and pinning ergonomics.
6. **M — Consider two-tier summary storage/rendering.** Keep a complete durable record for inspection while projecting only the compact continuation packet.

The storage, provenance, and conservative projection architecture do not need an immediate redesign based on this run. The highest-value changes are in summary discipline, user-visible continuation, and tool ergonomics.