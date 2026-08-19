# pi-task-compaction

A hierarchical task framework and task-aware context compaction extension for [pi](https://github.com/badlogic/pi-mono).

This `main` branch is the greenfield v2 implementation. The previous implementation is preserved on `archive/v1`; the tested v1 baseline is tagged `v0.1.0`.

The v2 architecture separates semantic task events, transcript provenance, context projection, inspection artifacts, worker routing, and global compaction. Public behavior follows **API v2** when it differs from the implementation plan.

The current v2 implementation provides hierarchical `begin_task`, `end_task`, `list_tasks`, and `inspect_task`, plus `/tasks`. Task state is reconstructed from branch-local Pi custom entries. `preserve_output` can preserve any eligible completed ordinary tool result in the active task; immutable `pin: true` records the full original multi-call protocol closure. `end_task.preserve_outputs` uses the same path, and `read_preserved_output` integrity-checks and re-emits persisted text/image blocks.

`inspect_task` defaults to compact durable summary/provenance metadata. Its bounded `list` and literal `search` views use hash-bound continuation cursors; `entry` returns an exact JSONL locator; `transcript` materializes the complete task-owned Pi session range as an atomically written private artifact outside the repository (`0700` directories and `0600` files). These artifacts may contain sensitive raw history and are intended only as ephemeral inputs to `read`, `jq`, or shell tooling.

With task compaction enabled, completed task bodies are replaced in provider context by chronological pinned/protected survivors, a structured task summary, and any unanswered user messages whose original occurrence was removed. `respond_to_user` protects one user message and its marked assistant response verbatim while leaving the task open. API v2 leaves binding across several accumulated user messages unsettled, so that ambiguous marker case hard-errors instead of choosing a policy. Projection never rewrites the raw Pi session and retains any subtree whose protocol or provenance cannot be proven safe.

Agent mode adds asynchronous `spawn_task`, `poll_task`, and `join_tasks`. A spawn pre-creates a private Pi session with the assigned root's `TaskCreated` event, persists parent/root spawn provenance, and then launches a worker that adopts that source with a fresh local task-depth budget. Required completed summaries and compact available-task references are validated against the worker's visibility grants. Run-wide private lease files enforce concurrency and agent depth; joins return stream-verified summaries or explicit semantic/registry-derived failure evidence without cancelling siblings. `inspect_task`, `list_tasks`, and `read_preserved_output` route across visible worker-owned sessions. Workers share the current working tree, so callers remain responsible for avoiding conflicting edits. API v2 leaves model-visible cancellation unsettled, so no `cancel_task` tool is registered.

Task-aware global Pi compaction remains the next implementation milestone.

## Configuration

The extension reads `.pi/task-framework.json` by default. The full framework is enabled by default:

```json
{
  "features": {
    "tasks": true,
    "summaries": true,
    "compaction": true,
    "agents": true
  },
  "limits": {
    "max_task_depth": 3,
    "max_agent_depth": 2,
    "max_concurrent_agents": 4
  }
}
```

CLI overrides use `--task-framework-tasks`, `--task-framework-summaries`, `--task-framework-compaction`, and `--task-framework-agents` with `true` or `false`. `--task-framework-config` selects another JSON file. Invalid dependencies fail at startup: compaction requires tasks and summaries; agents require tasks.

## Development

Requires Node.js 22.19 or newer.

```sh
npm install
npm run check
```

The package entrypoint is `extensions/task-framework.ts`.
