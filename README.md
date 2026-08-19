# pi-task-compaction

A hierarchical task framework and task-aware context compaction extension for [pi](https://github.com/badlogic/pi-mono).

This `main` branch is the greenfield v2 implementation. The previous implementation is preserved on `archive/v1`; the tested v1 baseline is tagged `v0.1.0`.

The v2 architecture separates semantic task events, transcript provenance, context projection, inspection artifacts, worker routing, and global compaction. Public behavior follows **API v2** when it differs from the implementation plan.

The current v2 implementation provides hierarchical `begin_task`, `end_task`, `list_tasks`, and `inspect_task`, plus `/tasks`. Task state is reconstructed from branch-local Pi custom entries. `preserve_output` can preserve any eligible completed ordinary tool result in the active task; immutable `pin: true` records the full original multi-call protocol closure. `end_task.preserve_outputs` uses the same path, and `read_preserved_output` integrity-checks and re-emits persisted text/image blocks.

`inspect_task` defaults to compact durable summary/provenance metadata. Its bounded `list` and literal `search` views use hash-bound continuation cursors; `entry` returns an exact JSONL locator; `transcript` materializes the complete task-owned Pi session range as an atomically written private artifact outside the repository (`0700` directories and `0600` files). These artifacts may contain sensitive raw history and are intended only as ephemeral inputs to `read`, `jq`, or shell tooling.

With task compaction enabled, completed task bodies are replaced in provider context by chronological pinned/protected survivors, a structured task summary, and any unanswered user messages whose original occurrence was removed. `respond_to_user` protects one user message and its marked assistant response verbatim while leaving the task open. API v2 leaves binding across several accumulated user messages unsettled, so that ambiguous marker case hard-errors instead of choosing a policy. Projection never rewrites the raw Pi session and retains any subtree whose protocol or provenance cannot be proven safe.

Agent mode adds asynchronous `spawn_task`, `poll_task`, and `join_tasks`. A spawn pre-creates a private Pi session with the assigned root's `TaskCreated` event, persists parent/root spawn provenance, and then launches a worker that adopts that source with a fresh local task-depth budget. Required completed summaries and compact available-task references are validated against the worker's visibility grants. Run-wide private lease files enforce concurrency and agent depth; joins return stream-verified summaries or explicit semantic/registry-derived failure evidence without cancelling siblings. `inspect_task`, `list_tasks`, and `read_preserved_output` route across visible worker-owned sessions. Workers share the current working tree, so callers remain responsible for avoiding conflicting edits. API v2 leaves model-visible cancellation unsettled, so no `cancel_task` tool is registered.

Global Pi compaction now runs the same projection planner used for routine provider context before asking the active Pi model for a structured checkpoint. Pi's requested raw cut point is aligned to task boundaries: completed, protocol-valid projected subtrees can be summarized as summaries/survivors, while open or ambiguous task regions remain wholly on the kept side. This applies to manual, threshold, overflow-retry, and repeated compaction. If an open task already spans the current Pi boundary and no safe prefix remains, compaction cancels rather than cutting through it.

Workflow guidance is generated from the enabled feature set, with every rule prefixed by `[task-compaction-tool]` so these transcript-compaction instructions remain distinct from todo or other task guidance. Core task guidance covers bounded/non-trivial nesting, close-child-before-parent discipline, durable summaries, preservation, and inspection. Compaction guidance alone teaches pin/protection/replay behavior; its pinning rule uses approved plan files and immutable documentation as concrete examples. Agent guidance alone teaches independent shared-tree spawning, worker-local depth reset, useful parent overlap, sparse polling, and result-time joins. Disabled feature guidance is absent from ablation arms.

For evaluation, compaction-enabled context passes persist bounded, content-free `pi-task-framework/evaluation` records with raw/projected message, byte, and estimated-token counts; accepted pin/protection/replay counts; replay cascade depth; and rejection reasons. Successful and cancelled global-compaction decisions use the same telemetry stream. Semantic task/output/interaction records and private worker routing artifacts supply the remaining M13 measurements without exposing transcript bodies in telemetry.

The checked-in [`evaluation/`](evaluation/README.md) suite defines the six primary and three diagnostic config-only ablation arms plus continuity workloads for near-64k context pressure, preservation/inspection, parallel agents, interruption replay, immutable pinning, worker-derived failure, and repeated global compaction. The sibling `pi-experiment-harness` captures coordinator and worker artifacts and emits the `task_framework` metric namespace. The summaries-disabled arm is retention-level: models still author the normal `end_task` schema.

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

Alternatively, the Nix flake provides Node.js 22, `nixfmt`, and the npm dependency hash tool:

```sh
nix develop
npm install
npm run check
```

Build the tested Pi-loadable package directory with:

```sh
nix build
pi -e ./result
```

Run all flake checks with `nix flake check`. The flake also exposes `packages.<system>.pi-task-compaction`, `packages.<system>.default`, `overlays.default`, and a default formatter. Package outputs place `package.json` and `extensions/task-framework.ts` directly at the derivation root, matching Pi and the dotfiles flake consumer contract.

The package entrypoint is `extensions/task-framework.ts`.
