# Projection-disabled task-tool shadow — implementation plan

Status: ready for implementation on branch `experiment/projection-disabled`

## 1. Purpose

Build an experimental **shadow** variant of `pi-task-compaction` that keeps the task tools and their workflow guidance unchanged but does not replace completed task regions in provider context.

This supports a three-arm experiment:

1. **baseline** — no task extension;
2. **shadow** — task tools, summaries, markers, and workflow guidance, but no message projection;
3. **full** — the current extension, including task-summary projection.

Baseline→shadow estimates the cost/effect of task decomposition and summary-writing. Shadow→full estimates the incremental effect of projecting completed regions out of context.

The shadow must be a branch-fixed experimental artifact, not a user-facing runtime toggle. Its Git commit and resource content hash are the treatment provenance.

## 2. Experimental contract

### Keep identical to `origin/main`

- All six tools and their schemas:
  - `begin_task`
  - `end_task`
  - `expand_task`
  - `preserve_output`
  - `list_preserved_outputs`
  - `read_preserved_output`
- Every tool description, `promptSnippet`, and `promptGuidelines` bullet.
- Tool execution behavior, marker schemas, task IDs, validation, summaries, preservation, expansion, rendering, and commands.
- `/tasks` and `/cancel-task` behavior.
- Session reconstruction on startup, reload, tree navigation, and compaction events.
- The `end_task` result text, including its statement about later replacement. This is intentionally held constant so the model is blind to the arm. Document the discrepancy for researchers; do not alter the model-visible contract in this branch.
- `EXTENSION_ID`, `SCHEMA_VERSION`, package name/version, and public TypeScript types unless a build system forces a metadata-only distinction.

### Disable

1. Normal per-provider-call task-region projection through Pi's `context` event.
2. Task-aware custom global compaction through `session_before_compact`, because it also projects completed task regions into the global summarizer and adjusts compaction boundaries.

With those hooks absent, Pi receives the raw task transcript on ordinary turns and uses its normal built-in compaction behavior if global compaction occurs.

### Preserve internal validation

Do **not** replace every call to `transformMessages()` with an identity function and do not delete `src/transform.ts` or `src/compaction.ts`.

`reconstructTaskIndex()` deliberately calls `transformMessages()` to validate complete regions and compute raw/summary diagnostic sizes. That internal calculation does not alter provider context and should remain. Existing transform and compaction unit tests should also continue to pass as tests of shared library behavior, even though the shadow entrypoint does not wire projection hooks at runtime.

## 3. Recommended implementation

### 3.1 Add an explicit branch-local mode constant

Create `src/projection-mode.ts`:

```ts
/** Fixed experimental mode for this branch. Not a runtime/user setting. */
export const TASK_PROJECTION_ENABLED: boolean = false;
export const TASK_PROJECTION_MODE = "disabled-shadow" as const;
```

The explicit `boolean` annotation avoids TypeScript treating the guarded branch as an impossible literal comparison. `TASK_PROJECTION_MODE` is researcher-facing metadata for tests/docs; do not inject it into model prompts or tool-result text.

A branch-fixed constant is preferable to an environment variable, CLI flag, settings file, or project config because those create accidental treatment crossover and weaken reproducibility.

### 3.2 Guard only the two provider-context hooks

In `extensions/task-compaction.ts`, import `TASK_PROJECTION_ENABLED` and register the two hooks only when enabled:

```ts
if (TASK_PROJECTION_ENABLED) {
  pi.on("context", (event, ctx) => {
    refresh(ctx);
    const result = transformMessages(event.messages);
    return { messages: result.messages };
  });

  pi.on("session_before_compact", async (event, ctx) =>
    runTaskAwareCompaction(event, ctx)
  );
}
```

Keep these existing hooks unconditionally registered:

- `session_start`
- `session_tree`
- `session_compact`
- `input`

Keep all tool and command registration unchanged.

The imports of `transformMessages` and `runTaskAwareCompaction` may remain in the entrypoint. This deliberately keeps the code delta small and keeps shared code typechecked/tested.

### 3.3 Document the shadow accurately outside model context

Add a prominent README section such as **Experimental projection-disabled branch** explaining:

- the branch has the same model-facing tools/guidance as main;
- completed regions remain in normal provider context;
- Pi's default global compaction remains active;
- `/tasks` compression sizes are hypothetical diagnostics in this branch, not evidence that projection occurred;
- the branch is intended only as an experimental control, not as the preferred product mode.

Do not add an active tool guideline, injected message, or changed tool result announcing shadow mode. That would create another model-visible independent variable.

## 4. Tests

### 4.1 Entrypoint registration test

Add `test/projection-mode.test.ts` with a mock `ExtensionAPI` that records event names and registered tools.

Assert:

- `TASK_PROJECTION_ENABLED === false`;
- `TASK_PROJECTION_MODE === "disabled-shadow"`;
- no `context` handler is registered;
- no `session_before_compact` handler is registered;
- `session_start`, `session_tree`, `session_compact`, and `input` remain registered;
- the registered tool-name set is exactly the main extension's six tools;
- the task-tool descriptions, snippets, and guidelines still contain the expected main-branch text.

Prefer exact event/tool sets over a weak “does not contain one item” assertion, so accidental removal of reconstruction/input behavior is caught.

### 4.2 Raw-context invariant

Use a mock extension API and a valid `closedTaskMessages()` fixture to establish that the shadow entrypoint has no callback capable of replacing those messages. The strongest inexpensive assertion is that the captured handler map has no `context` key.

Do not add an identity `context` handler merely to make this test easier. No handler is closer to baseline Pi behavior and avoids interaction with other extensions' context-handler ordering.

### 4.3 Keep all current tests green

Existing suites must continue to pass unchanged:

- `test/transform.test.ts` still proves what full projection would do.
- `test/compaction.test.ts` still proves task-aware compaction library behavior.
- reconstruction, expansion, and preservation tests still prove the shared protocol.

The distinction is wiring, not deletion of tested functionality.

### 4.4 Optional black-box smoke

Using raw Pi rather than a user wrapper that might inject the full task extension:

```sh
RAW_PI=/path/to/pi-coding-agent/bin/pi
"$RAW_PI" --mode rpc --no-extensions --extension "$PWD"
```

At minimum, verify startup succeeds and all task tools register without name conflicts. If a deterministic fake provider is available, close one task, make another model request, and assert the outgoing context still contains the original begin/tool/end messages rather than a generated `<task-summary>` replacement.

Do not spend real provider tokens merely to prove entrypoint registration.

## 5. Global compaction semantics

This choice is important for causal validity:

- **Shadow:** do not register `session_before_compact`; Pi performs ordinary built-in compaction exactly as the no-extension baseline would.
- **Full:** retain main's task-aware global compaction behavior.

If a future benchmark crosses Pi's global-compaction threshold, the experiment now compares both task projection and the full extension's task-aware global-compaction policy. For a clean projection experiment, keep prompts below that threshold or disable built-in global compaction identically in all three arms.

Do not keep boundary adjustment while disabling summary projection. Boundary protection is itself different behavior and would make shadow unlike baseline.

## 6. Provenance and harness configuration

Load the shadow from a clean checkout of this branch, not from the user's normal `pi` wrapper. The wrapper may inject the full task extension and contaminate baseline/shadow arms.

The harness should record:

- branch commit SHA;
- extension directory content hash;
- Pi executable/version;
- model and thinking level;
- exact prompt and seed revision;
- variant label such as `task-tool-shadow-no-projection`.

Use direct extension paths from clean worktrees so `resource_provenance()` records both the content hash and repository SHA.

Three configurations should differ only in extension source:

```yaml
configuration:
  - name: task-tool-off
    extensions: []

  - name: task-tool-shadow-no-projection
    extensions:
      - source: /home/spott/code/pi-task-compaction-projection-disabled

  - name: task-tool-full
    extensions:
      - source: /home/spott/code/pi-task-compaction-full
```

Create `pi-task-compaction-full` as a separate clean detached worktree at the exact full-extension commit. Do not point this arm at `/home/spott/code/pi-task-compaction` while that checkout contains unrelated untracked design files; although those files do not execute, they pollute resource hashes and weaken provenance.

Do not use `/etc/profiles/per-user/spott/bin/pi` for this comparison if it unconditionally injects full task compaction. Use the raw Pi binary and deny extension discovery, as in the roast-solver A/B experiment.

## 7. Acceptance criteria

Implementation is complete when:

1. The branch differs from `origin/main` only by the plan/docs, fixed mode declaration, narrow entrypoint wiring, and focused tests.
2. No `context` or `session_before_compact` handler is registered by the shadow entrypoint.
3. All six tools, their schemas, descriptions, snippets, and guidelines remain unchanged.
4. Task markers, reconstruction, `/tasks`, expansion, and preserved-output behavior remain functional.
5. Pi default global compaction is not intercepted.
6. `npm run check` passes.
7. `nix flake check` passes on supported local systems.
8. A raw-Pi RPC startup smoke passes without extension conflicts.
9. README clearly labels the branch experimental and explains the blinded model-facing text.
10. The implementation commit is clean and suitable for loading directly by the experiment harness.

## 8. Suggested implementation sequence

1. Read this plan, `README.md`, `extensions/task-compaction.ts`, `src/transform.ts`, `src/compaction.ts`, `src/reconstruct.ts`, and the extension/compaction Pi docs.
2. Capture the current event/tool registration in a focused test fixture.
3. Add the fixed projection-mode constants.
4. Guard only the `context` and `session_before_compact` registrations.
5. Add shadow-specific registration assertions.
6. Update README with the researcher-facing warning.
7. Run `npm run check`, then `nix flake check`.
8. Perform raw-Pi RPC startup smoke.
9. Review `git diff origin/main...HEAD` for accidental prompt/schema/tool changes.
10. Commit the implementation on `experiment/projection-disabled`; do not merge it into main before the experiment.

## 9. Non-goals

- A production runtime toggle for projection.
- Removing task summaries or their generation cost.
- Removing `expand_task` or preserve-output tools because they are less necessary when raw history remains visible.
- Renaming tools, extension IDs, markers, or package identity.
- Changing summary fields or shortening task-boundary prompts.
- Provider-specific request or cache mutation.
- Proving that projection improves quality; this branch only makes the next experiment capable of separating mechanisms.

## 10. Review checklist for experimental validity

Before using the branch, compare it with the full extension and answer yes to each:

- Same six tool definitions and active tool set?
- Same task prompt guidance?
- Same begin/end return text and marker details?
- Same model, prompt, seed, credentials, Pi binary, and timeout in the harness?
- Only shadow lacks provider-context and task-aware compaction handlers?
- No globally injected full extension from a wrapper or settings file?
- Clean branch commit and recorded resource hash/SHA?
- Enough randomized repetitions, with run order varied or recorded?

If any answer is no, record the extra difference as another treatment variable before interpreting results.
