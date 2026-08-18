# pi-task-compaction

A hierarchical task framework and task-aware context compaction extension for [pi](https://github.com/badlogic/pi-mono).

This `main` branch is the greenfield v2 implementation. The previous implementation is preserved on `archive/v1`; the tested v1 baseline is tagged `v0.1.0`.

The v2 architecture separates semantic task events, transcript provenance, context projection, inspection artifacts, worker routing, and global compaction. Public behavior follows **API v2** when it differs from the implementation plan.

The semantic foundation currently provides hierarchical `begin_task`, `end_task`, and `list_tasks`, plus `/tasks`. Task state is reconstructed from branch-local Pi custom entries. Later v2 milestones add preservation, projection, inspection, workers, and task-aware global compaction.

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
