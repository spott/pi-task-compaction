# v2 evaluation fixtures

These checked-in specifications implement the Plan v2 M13 evaluation surface for `pi-experiment-harness`.
They use one extension build and select every framework arm only through explicit CLI flags.
No projection-disabled build or shadow worktree is required.

## What is included

### Ablation matrices

`experiments/primary.yaml` runs the Roast Solver continuity anchor across the six primary arms:

1. vanilla
2. tasks only
3. tasks + summaries
4. tasks + summaries + compaction
5. tasks + summaries + agents
6. tasks + summaries + compaction + agents

`experiments/diagnostic.yaml` contains the three named diagnostic arms. Some are intentionally feature-equivalent to primary arms but retain distinct variant names for separately repeated diagnostic runs.

**Summaries-arm interpretation:** `summaries: false` disables durable retention, not model authorship. The model still fills the normal structured `end_task` fields; the extension removes that summary from subsequent provider context and does not retain it as durable task state. Results must not be described as measuring “tasks without summarization effort.”

### Continuity workloads

The full-framework experiments under `experiments/continuity-*.yaml` cover:

- a deterministic approximately 64k-token raw-context trajectory;
- ordinary output preservation followed by `inspect_task` and exact recovery;
- genuinely parallel, read-only worker branches;
- a protected response followed by an unanswered interruption and replay;
- immutable pinning followed by task and global compaction;
- a normal worker plus a deliberately crashed worker for registry-derived failure;
- a long, repeated-global-compaction source audit.

`workloads.yaml` is the machine-readable workload inventory and records expected metrics and known constraints.

## Reproducibility inputs

- Roast Solver scenarios target sibling repository `../roast-solver-seed` at commit `9c0173ee9b98ec5fe970f6228fc971cc8b04e29c`.
- Framework continuity scenarios target this repository at implementation commit `81d2d35`.
- Experiments load this checkout's exact entrypoint (`../../extensions/task-framework.ts` relative to each experiment).
- Experiments use this checkout’s Pi 0.84.1 binary at `node_modules/.bin/pi`, avoiding user wrappers that may inject another extension.
- `credential_source: environment` is portable but requires the selected provider credentials in the harness environment. Change the model or credential source deliberately if needed; the resolved run provenance records the change.

## Validate without running a model

From the sibling harness checkout:

```sh
cd /home/spott/code/agent_test_harness
uv run python /home/spott/code/pi-task-compaction/evaluation/validate.py
```

The validator loads every scenario and experiment through the real harness parser, expands all matrices, verifies the primary/diagnostic feature tuples, and checks that continuity experiments use the full framework.

## Run

From the harness checkout:

```sh
# Six-arm Roast Solver primary matrix
uv run piexp run /home/spott/code/pi-task-compaction/evaluation/experiments/primary.yaml \
  --invocation-id task-framework-v2-primary-001

# Named diagnostics
uv run piexp run /home/spott/code/pi-task-compaction/evaluation/experiments/diagnostic.yaml \
  --invocation-id task-framework-v2-diagnostic-001

# One continuity workload
uv run piexp run /home/spott/code/pi-task-compaction/evaluation/experiments/continuity-preservation.yaml \
  --invocation-id task-framework-v2-preservation-001
```

Use `--variant` and `--repeat` for bounded subsets. Results include coordinator session data, copied worker routes/bootstraps/sessions, generic metrics, and the `task_framework` M13 namespace.

## Constraints stated rather than hidden

- The near-64k workload creates roughly 260k characters of ordinary tool output (Pi’s `chars / 4` estimate is about 65k tokens). It does **not** override a provider model’s declared context window; use a model with an approximately 64k window when a true capped-context comparison is required.
- API v2 leaves model-visible cancellation unsettled, so no cancellation workload or `cancel_task` arm is fabricated.
- The live worker-failure workload kills a worker after startup and exercises registry-derived failure for an open semantic task. A deterministic never-started worker requires process-launch fault injection; that path is covered by extension and harness unit fixtures rather than a production experiment flag.
- The long workload requests repeated manual global compactions. Threshold and overflow-retry paths are deterministic extension tests; triggering provider overflow in a reproducible paid run depends on the selected model’s actual context limit.
- Workers share one disposable worktree. Agent workloads here are read-only except for the worker’s intentional self-termination, so parallel mutation conflicts are out of scope.
- No live provider run is part of repository verification. Loading/expansion and automated extension/harness tests are the verified states.
