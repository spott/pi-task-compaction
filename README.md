# pi-task-compaction

A provider-agnostic [pi](https://pi.dev) extension for explicit, agent-driven compaction of bounded, tool-heavy tasks.

The agent opens a region with `begin_task`, performs an investigation or experiment, and closes it with a typed `end_task` summary. On later model requests, the extension replaces the complete validated region with one historical `<task-summary>` block. The original session JSONL and TUI transcript are never rewritten.

## Safety model

A region is pruned only when the extension can prove that:

- both boundary calls and results exist and match
- `begin_task` and `end_task` were each called alone
- every assistant tool call has exactly one matching result inside the region
- no user, custom, bash-user, branch-summary, or compaction-summary message occurs inside it
- regions do not overlap or nest

Ambiguous or invalid regions stay in full. State is reconstructed from tool-result details on the active session branch, so resume, fork, reload, and `/tree` navigation are branch-aware.

Pi's built-in manual, threshold, and overflow compaction is intercepted when task state exists. Completed regions are projected as summaries before global summarization. If pi proposes a kept boundary inside a valid task, it is moved backward to the task's begin assistant entry so recovery remains possible. Provider prompt-cache payloads are not modified.

## Install

During development:

```bash
pi install /home/spott/code/pi-task-compaction
```

Or run it for one invocation:

```bash
pi -e /home/spott/code/pi-task-compaction
```

After editing an installed local package, run `/reload` in pi.

## Tools

### `begin_task`

Opens one bounded work phase and returns its task ID. Treat roughly 4k–8k disposable tokens as a target region size and use multiple sequential regions for larger requests, closing at durable milestones or phase changes. Do not fragment single reads, commands, or tiny edits. The call must be alone in its assistant message.

### `end_task`

Closes the current task. It requires the matching ID and a complete typed summary:

- objective and outcome
- execution context: repository or worktree, branch, working directory, and dirty state
- approaches attempted
- durable learnings and decisions
- files read and modified
- surviving artifacts
- verification and outcomes
- unresolved threads and next steps

All arrays are required but may be empty. Each summary should remain self-sufficient while avoiding unchanged detail from the immediately preceding retained summary. Critical execution state, modified files, verification state, open threads, and exact failed experiments must remain explicit. The call must be alone in its assistant message.

Injected `<task-summary>` messages are internal context restoration rather than new requests. The prompt directs the model not to acknowledge them: it should continue the unresolved request, or report completion when that work is finished.

### `expand_task`

Returns a bounded plain-text serialization of the original task transcript. It supports a hard character budget, optional entry IDs, tool-output omission, and filtering tool results by tool name. Truncated output identifies the complete session file.

## Commands

- `/tasks` — list open, closed, cancelled, and rejected regions with compression diagnostics
- `/cancel-task [task-id] [reason]` — abandon the open region and explicitly leave it unpruned

An open task is displayed in pi's footer. If the user sends another message while a task is open, the extension warns that the interruption makes the region ineligible for pruning; it never suppresses or rewrites the input.

## Good uses

- codebase or dependency exploration with many reads/searches
- bounded implementation spikes
- failed experiments with large logs
- benchmark or test investigations
- problem-space probing that ends in concise durable findings

Do not use a region for one command, one file read, user-facing discussion, or work whose exact transcript is the deliverable.

## Development

Requires Node.js 22.19+.

```bash
npm install
npm run check
```

The tests cover whole-region protocol validation, sequential regions, open/corrupt/future markers, user interruptions, sibling boundary calls, branch reconstruction, bounded recovery, provider/model changes, and task-aware global-compaction boundary alignment.

## Compatibility

The package targets pi 0.83's extension API and declares pi core packages plus `typebox` as peer dependencies. Marker and compaction-detail schemas are versioned. The extension works without TUI UI in RPC, JSON, print, and ephemeral session modes; status and notifications are guarded by UI availability.

## Non-goals

- destructive session rewriting
- nested or parallel task regions
- automatic semantic task detection
- guaranteed provider billing savings
- Anthropic/OpenAI request-payload or cache-breakpoint mutation

## License

MIT
