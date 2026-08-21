# Coordinator Worker Shutdown Barrier Plan

## Status

**Proposed — implementation not started.**

**Size: L.** The implementation is localized to worker orchestration, registry records, configuration, and extension shutdown wiring, but it changes process-lifecycle guarantees across nested Pi workers. It requires deterministic race tests, a real subprocess cascade test, and runner-side acceptance before agent-enabled SCBench runs.

## Problem statement

`AsyncWorkerCoordinator` launches worker Pi processes asynchronously, but the coordinator does not retain their process handles or monitor promises after `spawn()` returns:

```text
spawn()
  -> acquire lease
  -> pre-create worker session/bootstrap/route
  -> launch child Pi
  -> update route PID
  -> void monitor(handle)
  -> return task ID
```

The monitor eventually waits for process exit, derives the authoritative route status from the worker-owned task stream, updates the route, and releases the run-wide lease. Because the handle and monitor promise are discarded, the parent cannot wait for, terminate, or verify completion of outstanding workers during `session_shutdown`.

The extension currently registers a shutdown handler only when the current process is itself a bootstrapped worker. That handler fails the worker's own open assigned task and finalizes its own route. A coordinator or parent session has no corresponding handler for workers it spawned.

This creates a workspace-integrity race for runners such as SCBench:

1. parent Pi finishes or changes session;
2. SCBench snapshots and evaluates the persistent checkpoint workspace;
3. an unjoined worker remains alive and continues mutating that workspace; and
4. the snapshot or evaluation no longer represents a stable agent result.

The same gap applies to nested workers. Killing only a direct child without allowing that child to shut down its own descendants can leave a grandchild alive.

## Current lifecycle facts

Relevant paths:

- `src/workers/coordinator.ts`
- `src/workers/process.ts`
- `src/store/run-registry.ts`
- `src/model/worker.ts`
- `src/task-framework.ts`
- `src/config.ts`
- `test/worker-orchestration.test.ts`
- `test/worker-routing.test.ts`

Current behavior:

- `AsyncWorkerCoordinator.spawn()` fire-and-forgets `monitor()`.
- `WorkerProcessHandle` exposes `pid`, `wait()`, and `terminate()` but no settled or termination result.
- Registry routes persist process lifecycle and semantic-source location, but a route PID is not a safe process handle because stale PIDs can be reused.
- `monitor()` is the authoritative route/lease finalizer and must be awaited after child exit.
- Pi 0.84.1 awaits `session_shutdown` handlers sequentially for `quit`, `reload`, `new`, `resume`, and `fork`.
- Pi logs and swallows shutdown-handler errors, so throwing alone cannot prove cleanup to a containing runner.
- Print-mode Pi handles `SIGTERM` by killing Pi-tracked detached tool children, awaiting extension shutdown, and then exiting with signal semantics.
- Every worker process loads the same task-framework extension and can therefore recursively shut down only the direct children it owns.

## Goals

1. Prevent any managed direct or nested worker from mutating the workspace after a successful parent shutdown barrier.
2. Reject new spawns as soon as shutdown begins.
3. Account safely for spawn transactions already in progress when shutdown begins.
4. Allow a bounded natural drain, then escalate direct children through `SIGTERM` and `SIGKILL`.
5. Await worker monitor completion so routes and leases are finalized before the barrier succeeds.
6. Preserve single-owner semantic task state: workers finalize their own task streams whenever graceful shutdown is possible.
7. Support nested workers through recursive, ordered shutdown handlers.
8. Be idempotent across repeated shutdown requests.
9. Persist a content-free, machine-readable completion or failure report that SCBench can require before snapshotting.
10. Keep all failure modes bounded and fail closed when workspace quiescence cannot be proven.

## Non-goals

- Do not recover workers after parent process `SIGKILL`, kernel failure, machine failure, or container termination.
- Do not signal arbitrary PIDs reconstructed from registry files.
- Do not make the coordinator append semantic cancellation events into worker-owned session files.
- Do not silently classify forced shutdown as successful task completion.
- Do not implement a general process supervisor outside one task-framework run.
- Do not keep workers alive across Pi session replacement, extension reload, or SCBench checkpoints.
- Do not make runner snapshots proceed after a missing or failed shutdown proof.
- Do not add live combined parent/worker cost accounting as part of this change.

## Required safety invariants

1. **Spawn gate first:** shutdown synchronously closes the coordinator to new `spawn()` calls before its first await.
2. **No untracked launch:** every child handle returned by the launcher is entered into managed state before another await; a handle returned after shutdown starts is immediately managed and terminated.
3. **Handles signal; registry audits:** only retained in-process handles may receive signals. Registry routes are used for verification and anomaly detection, never blind PID killing.
4. **Monitor finality:** a worker is not quiesced merely because `wait()` resolved. Its monitor must also finish route update and lease release.
5. **Direct ownership:** each coordinator signals only workers launched by that coordinator and owned by its current session.
6. **Recursive order:** a bootstrapped worker shuts down its direct descendants before finalizing its own assigned root and route.
7. **Bounded escalation:** natural drain, graceful termination, forced termination, and final verification all have finite deadlines.
8. **No false success:** surviving handles, unsettled spawn transactions, active owned/descendant routes, remaining owned leases, monitor failures, or report-persistence failure make the barrier fail.
9. **Terminal tasks remain authoritative:** naturally completed worker tasks retain normal completion. Gracefully interrupted open tasks are failed by their owning worker session. Hard-killed workers remain registry-derived failures.
10. **Idempotency:** concurrent or repeated `shutdown()` calls share one promise and one report; signal and route-finalization side effects occur at most once per stage.
11. **Observable outcome:** successful agent-enabled shutdown persists exactly one complete report for the owning session within that task-framework run. Missing or failed reports invalidate a runner snapshot.
12. **Bounded diagnostics:** reports contain IDs, statuses, signals, counts, timings, and bounded diagnostics, never prompts, summaries, or tool output.
13. **Session re-arm:** after `new`, `resume`, or `fork`, agent tools use a fresh coordinator, router, and run registry bound to the destination session. A closed coordinator is never reused.

## Proposed design

### 1. Add explicit managed-worker state

Extend `AsyncWorkerCoordinator` with state similar to:

```ts
interface ManagedWorker {
  workerId: string;
  taskId: TaskId;
  sessionId: string;
  handle: WorkerProcessHandle;
  monitorPromise: Promise<WorkerMonitorResult>;
  terminationRequests: NodeJS.Signals[];
}

interface SpawnTransaction {
  id: string;
  abortController: AbortController;
  promise: Promise<void>;
  workerId?: string;
  taskId?: TaskId;
  handle?: WorkerProcessHandle;
}

class AsyncWorkerCoordinator {
  private readonly coordinatorId: string;
  private closing = false;
  private shutdownPromise?: Promise<WorkerShutdownReport>;
  private readonly spawnTransactions = new Map<string, SpawnTransaction>();
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly monitorOutcomes = new Map<string, WorkerMonitorResult>();
}
```

The exact types may be refined, but the coordinator must retain:

- every in-flight spawn from method entry;
- every returned process handle;
- the corresponding monitor promise;
- whether `SIGTERM` or `SIGKILL` was requested; and
- the monitor's route/lease finalization outcome.

Remove a managed worker only after its monitor settles. Preserve its bounded monitor outcome until shutdown reporting is complete.

### 2. Bind each coordinator to one owning session and runtime instance

Add a required `ownerSessionId` field and a generated `coordinatorId` to `AsyncWorkerCoordinator`. Allow tests to inject the coordinator ID, but production must generate a collision-resistant ID when the coordinator is created. The coordinator instance is session-scoped and must reject a spawn or shutdown request whose context session differs from that owner.

Add immutable `spawningCoordinatorId` alongside `spawningSessionId` on newly created worker routes. Use the coordinator ID for exact direct-route ownership and the owner session ID for semantic visibility and descendant traversal. A worker may inspect explicitly visible remote tasks, but it may terminate only direct processes launched by its own coordinator instance. Bump or compatibly extend route schema validation; an active legacy route without a coordinator ID is unmanaged and prevents a successful barrier rather than being guessed into ownership.

Retain bounded history for every worker launched by this coordinator even after its monitor completes, so a later shutdown report can distinguish workers that exited naturally before the barrier from workers terminated during it. Managed handles may be removed after monitor finality; ownership/outcome records remain until the report is persisted.

The current extension constructs `agents`, `WorkerTaskRouter`, and `AsyncWorkerCoordinator` only once even though Pi can emit `session_shutdown` followed by `session_start` for `new`, `resume`, or `fork`. Closing that coordinator permanently and then reusing it would disable later spawns and retain the old router session ID. Refactor agent services into a mutable session-owned runtime: shutdown and discard the old coordinator/router/registry object, then open the destination session's recorded run registry or create one if absent, and install a fresh router and coordinator before agent tools become available. Resuming a prior session may legitimately reopen its existing run ID; the new coordinator ID distinguishes the new runtime instance. A bootstrapped print-mode worker is single-session and does not re-arm into an unrelated session.

Report identity is therefore `{runId, sessionId, coordinatorId}`, not only a session ID. This handles extension reload, session resume, and an outer runner retry that reuses a session file without overwriting an earlier shutdown proof.

### 3. Split `spawn()` into a gated wrapper and tracked transaction

Make the public `spawn()` wrapper perform these operations synchronously before yielding:

1. reject if `closing` is true;
2. allocate a transaction ID and `AbortController`;
3. create the internal spawn transaction promise;
4. insert the transaction into `spawnTransactions`; and
5. remove it only in a `finally` block.

The internal transaction should check its abort signal after every asynchronous preparation stage and before launch. Extend `WorkerProcessLauncher.launch()` to accept an optional `AbortSignal`, or otherwise provide equivalent cancellation semantics.

Cancellation rules:

- If shutdown starts before launch, abort and finalize the lease/route as a launch-transaction failure.
- If the launcher returns a handle after cancellation, register that handle immediately, start its monitor, and request `SIGTERM`; never discard it.
- Insert the handle into managed state before awaiting the route PID update.
- If registry update or later setup fails after launch, keep the handle managed and terminate it before rejecting the spawn.
- A spawn call racing shutdown may reject to its tool caller, but the barrier remains responsible for its process and registry cleanup.

Do not rely on JavaScript method ordering alone once the transaction crosses its first await.

### 4. Strengthen process handles

Change the process abstraction to make termination observable:

```ts
interface WorkerProcessHandle {
  pid: number;
  wait(): Promise<WorkerProcessExit>;
  terminate(signal?: NodeJS.Signals): boolean;
}
```

`NodeWorkerProcessLauncher` should return the boolean from `child.kill(signal)`. A false return or thrown signal request is diagnostic; the barrier must still wait/audit rather than assume the process is dead.

The same `wait()` promise must remain safe to observe from both monitor and barrier code. The barrier should normally await monitor promises instead of separately interpreting process exit.

### 5. Make monitor completion explicit

Refactor `monitor()` to return a bounded result rather than `void`:

```ts
interface WorkerMonitorResult {
  workerId: string;
  taskId: TaskId;
  exit: WorkerProcessExit;
  routeFinalized: boolean;
  leaseReleased: boolean;
  error?: string;
}
```

Monitor responsibilities remain:

1. await child exit;
2. read the worker-owned task stream;
3. derive completed/cancelled/failed route status;
4. record exit code, signal, diagnostics, and exit time;
5. release the lease; and
6. resolve only after route and lease work has settled.

Do not let a failed route update hide a successful lease release or vice versa. Capture each outcome separately, make a best effort at both, and let the final audit decide whether the barrier can succeed.

When termination was requested by shutdown, add bounded route diagnostics such as `Coordinator shutdown requested SIGTERM` without replacing authoritative worker-owned failure evidence.

### 6. Add a public idempotent shutdown API

Extend `WorkerCoordinator` or expose the concrete coordinator API:

```ts
interface WorkerShutdownRequest {
  reason: "quit" | "reload" | "new" | "resume" | "fork";
}

interface WorkerShutdownReport {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  coordinatorId: string;
  reason: WorkerShutdownRequest["reason"];
  startedAt: number;
  endedAt: number;
  status: "complete" | "failed";
  directWorkerCount: number;
  naturalExitCount: number;
  sigtermRequestedCount: number;
  sigkillRequestedCount: number;
  monitorFailureCount: number;
  activeOwnedRouteCount: number;
  activeDescendantRouteCount: number;
  activeUnmanagedRouteCount: number;
  remainingOwnedLeaseCount: number;
  unsettledSpawnCount: number;
  survivingHandleCount: number;
  diagnostics: string[];
}
```

`shutdown(request)` must synchronously set `closing = true` and memoize one internal promise before awaiting anything. Every later call on that coordinator instance returns the same promise/report.

The report's `sessionId` and `coordinatorId` come from the coordinator; neither is accepted from an arbitrary shutdown caller. Report uniqueness is scoped to `{runId, sessionId, coordinatorId}`. An outer retry or resumed session can reuse a Pi session and run registry while still producing a separately attributable report.

A report is `complete` only if all managed handles have exited, all monitor promises have settled successfully enough to finalize route and lease state, and the final registry audit finds no active owned, descendant, or unmanaged route and no remaining owned lease.

### 7. Use staged bounded shutdown

Recommended initial configuration:

```json
{
  "shutdown": {
    "worker_drain_ms": 0,
    "worker_term_grace_ms": 5000,
    "worker_kill_grace_ms": 2000
  }
}
```

Suggested CLI overrides:

```text
--task-framework-worker-shutdown-drain-ms
--task-framework-worker-shutdown-term-grace-ms
--task-framework-worker-shutdown-kill-grace-ms
```

`worker_drain_ms` accepts a non-negative integer. Grace values are positive integers. All values must be forwarded unchanged to worker Pi invocations so nested processes use one policy.

Default drain is zero because model discipline already requires `join_tasks` before finishing. A nonzero drain is available for controlled environments but should not silently turn parent completion into unbounded background work.

Stages:

1. **Close and contain**
   - close the spawn gate;
   - abort in-flight spawn transactions;
   - include every late-arriving handle in managed state.
2. **Natural drain**
   - wait up to `worker_drain_ms` for spawn transactions and monitors to settle naturally.
3. **Graceful cascade**
   - send `SIGTERM` once to every remaining direct managed worker;
   - wait for monitors and in-flight transactions;
   - allow enough depth-aware time for each child Pi to run its own descendant barrier.
4. **Forced termination**
   - send `SIGKILL` once to every remaining direct handle;
   - wait up to `worker_kill_grace_ms` for process close and monitor finalization.
5. **Audit and report**
   - verify managed handles, transactions, routes, descendant routes, and leases;
   - persist the report;
   - return complete or failed.

Compute the graceful-cascade budget from remaining configured agent depth:

```text
remainingLevels = maxAgentDepth - currentAgentDepth
cascadeBudget = (worker_drain_ms + worker_term_grace_ms) * max(1, remainingLevels)
```

The root performs its own drain once, then allows the derived cascade budget after `SIGTERM`. A worker at the maximum depth has no children and skips process stages. Tests should use injected timing rather than wall-clock waits.

The depth formula is an upper-bound policy, not proof by itself. The final transitive registry audit remains authoritative.

### 8. Audit direct and nested ownership without blind PID signaling

Add registry support required for verification, for example:

```ts
listLeaseWorkerIds(): Promise<WorkerId[]>;
writeShutdownReport(report: WorkerShutdownReport): Promise<void>;
readShutdownReport(coordinatorId: string): Promise<WorkerShutdownReport | undefined>;
listShutdownReports(sessionId?: string): Promise<WorkerShutdownReport[]>;
```

Persist reports atomically in a private `shutdowns/` directory under the run registry, keyed by a safe representation of coordinator ID. Validate IDs and reject symlinks. The report body carries run, session, and coordinator identity; reads must verify all three against the registry and requested owner.

At final audit:

- direct owned routes have `spawningCoordinatorId === coordinator.coordinatorId` and the expected spawning session;
- descendant routes are found transitively through each direct route's worker `sessionId` and later `spawningSessionId` links;
- active means `starting` or `running`;
- owned leases are leases for workers in that direct/descendant closure; and
- a root coordinator with no bootstrap treats every other active route in the same run registry as unmanaged, because no worker may remain when the top-level workspace boundary is released.

An active direct route claiming the current coordinator ID without a retained owner handle is an unmanaged anomaly. Do not signal its persisted PID. Mark the barrier failed.

A bootstrapped worker coordinator must not classify its own still-running route, ancestors, or active siblings as unmanaged: those are owned by ancestor coordinators, and its self-finalization handler runs only after its descendant barrier. It verifies only its direct/descendant closure. The root coordinator's later run-wide audit is the final proof that all branches are terminal.

An active descendant after its direct parent exited means recursive cleanup could not be proven. Mark the barrier failed so SCBench tears down the container rather than snapshotting.

### 9. Wire ordered shutdown handlers

Whenever agents are enabled and a coordinator exists, register a coordinator handler before the existing bootstrapped-worker self-finalization handler:

```text
session_shutdown handler 1
  -> coordinator.shutdown({ reason: event.reason })
  -> persist registry report for coordinator.ownerSessionId/coordinatorId
  -> append bounded session telemetry

session_shutdown handler 2, worker processes only
  -> fail own open assigned root if needed
  -> update own route
  -> release own lease
```

This ordering ensures a worker's descendants quiesce before that worker finalizes and exits. Pi awaits handlers sequentially.

If the barrier report is failed:

- persist and append the failed report first;
- surface an explicit error/status afterward;
- do not depend on the thrown error to stop Pi, because Pi logs shutdown-handler failures and continues;
- still allow the bootstrapped-worker self-finalization handler to execute.

The runner must inspect the report. A missing or failed report is not a valid snapshot boundary.

For `new`, `resume`, and `fork`, the following `session_start` must create and install a fresh session-owned agent runtime before accepting `spawn_task`. Tests must prove the old closed coordinator is unreachable and the new router, registry, reports, and ownership checks use the destination session. For `quit` and `reload`, normal runtime teardown may discard the closed services; extension reload creates a new extension runtime.

### 10. Add dedicated shutdown telemetry

Use a dedicated custom entry type, for example:

```text
pi-task-framework/worker-shutdown
```

The custom entry and registry report share schema 1. Persist counts, timing, reason, status, termination stages, active-route/lease audit, and bounded diagnostics. Do not place worker prompts, task summaries, stderr bodies, or tool output in this record.

The registry report is the process-independent proof. The custom session entry makes normal extraction and inspection convenient.

Add extractor metrics later in SCBench and the experiment harness:

- shutdown report count;
- complete/failed/missing count;
- natural/SIGTERM/SIGKILL worker counts;
- barrier elapsed time;
- unmanaged route/survivor count;
- shutdown reason distribution.

### 11. Define runner behavior

For SCBench agent/full checkpoints:

- identify the successful Pi invocation's parent report by `{runId, sessionId, coordinatorId}` from its saved custom session entry;
- require exactly one matching registry report and preserve reports from failed retries or prior coordinator instances separately;
- require `status=complete`;
- require zero active owned, descendant, or unmanaged routes, owned leases, surviving handles, and unsettled spawns;
- copy every report, routes, leases directory state, parent session, and worker sessions before container cleanup;
- reject the checkpoint result and tear down the container if the successful invocation's report is missing, ambiguous, or failed;
- never snapshot or run authoritative tests after a failed barrier.

Non-agent arms do not require a worker-shutdown report unless agents are enabled but unused. Agent-enabled checkpoints with zero spawns should still emit a complete zero-worker report, proving the handler ran.

## Test plan

### Configuration tests

Extend config tests to verify:

1. Defaults are drain `0`, term grace `5000`, and kill grace `2000` milliseconds.
2. Config-file and CLI values resolve correctly.
3. Drain accepts zero; grace values reject zero, negatives, fractions, and invalid strings.
4. Shutdown flags are forwarded exactly to nested worker invocations.
5. Unknown shutdown keys remain rejected.

### Pure coordinator tests

Extend `test/worker-orchestration.test.ts` with a controllable launcher, fake timing, and observable signals:

1. Shutdown with no workers returns one complete zero-worker report.
2. Repeated/concurrent shutdown calls return the same result and do not duplicate signals.
3. Spawn after the gate closes rejects before lease or route creation.
4. A spawn paused before launch is aborted and fully rolls back.
5. A handle returned after shutdown starts is retained and terminated.
6. A natural exit during drain receives no signal.
7. A worker that exits on `SIGTERM` receives one `SIGTERM`, no `SIGKILL`, and its monitor is awaited.
8. A worker that ignores `SIGTERM` receives one `SIGKILL` after the graceful budget.
9. Route update delayed after process exit keeps the barrier pending until monitor finalization.
10. Lease release delayed after route update keeps the barrier pending.
11. Route-update failure, lease-release failure, signal failure, or monitor rejection produces a failed report.
12. A managed process exit without semantic completion remains a derived failure but can still be quiescent.
13. An active owned registry route without a handle is reported as unmanaged and is never signaled by PID.
14. An active descendant route after direct-child exit fails the transitive audit.
15. A completed or failed historical route from the same session does not fail a later idempotent audit.
16. Reports are bounded, content-free, atomically persisted, and reusable after registry reopen.
17. A nested coordinator does not fail because its own route, an ancestor, or a sibling is active, while the root coordinator rejects any active route outside its completed transitive closure.

Enhance `ControlledLauncher` so each fake handle records signals and can resolve on natural exit, `SIGTERM`, or `SIGKILL` independently.

### Spawn-race tests

Add deterministic barriers around each asynchronous spawn stage:

- context preparation;
- lease acquisition;
- worker-source creation;
- route registration;
- launcher start;
- handle return; and
- PID route update.

Begin shutdown at each stage and assert:

- no child handle is lost;
- no lease remains;
- every registered route becomes terminal or makes the barrier explicitly fail;
- the spawn promise settles; and
- shutdown remains bounded.

Use injected deferred promises, not probabilistic sleeps.

### Extension handler tests

Extend `test/worker-routing.test.ts` or add a focused shutdown test:

1. Agent-enabled coordinator sessions register a shutdown handler even with zero workers.
2. Bootstrapped workers register coordinator cleanup before their own root-finalization handler.
3. Handler reason, session ID, and coordinator ID reach the report.
4. A complete report is appended to the parent session and registry.
5. A failed report is persisted before the handler surfaces an error.
6. `quit`, `reload`, `new`, `resume`, and `fork` all close workers.
7. Worker self-finalization still fails an open assigned root after child cleanup.
8. After `new`, `resume`, or `fork`, the old coordinator remains closed and a fresh coordinator/router/registry object accepts work only for the destination session.
9. Resuming the same session/run creates a new coordinator ID and a second non-overwriting report; stale active routes from the older root coordinator fail the new root barrier.

### Real subprocess and nested cascade tests

Build on the existing real Pi 0.84.1 subprocess adoption test.

Add a provider-free wrapper extension that:

1. starts a child worker;
2. has that worker start a grandchild;
3. keeps both processes alive without model/provider work;
4. optionally starts a tracked detached shell command that writes a heartbeat file; and
5. triggers parent shutdown.

Require:

- parent sends `SIGTERM` only to its direct child;
- child recursively shuts down its grandchild;
- Pi terminates the tracked shell heartbeat;
- both monitors finalize routes and release leases;
- the parent report is complete;
- no heartbeat or workspace file changes after the report timestamp; and
- all processes are gone.

A second fixture should make a descendant ignore graceful shutdown, exercise `SIGKILL`, and either prove complete cleanup or emit a failed report that a fake runner refuses to snapshot.

### Registry tests

Add tests for:

- private `shutdowns/` directory creation;
- atomic report writes and schema validation;
- exact run/session/coordinator ownership and non-overwriting reports;
- lease listing;
- direct, transitive, and unmanaged active-route audit;
- malformed/symlink report rejection; and
- reopening and listing reports from another process.

### SCBench integration tests

Before paid work, add provider-free tests in SCBench that:

1. run an agent-enabled Pi checkpoint with zero workers and capture a complete report;
2. run a checkpoint with a short-lived worker and capture parent/worker sessions plus a complete report;
3. refuse snapshot/evaluation on a missing report;
4. refuse snapshot/evaluation on a failed/survivor report;
5. verify no file changes occur between barrier completion and snapshot; and
6. rotate the session and artifact root at the next checkpoint.

## Verification plan

Run in order:

```sh
npm run typecheck
npm test
npm run check
nix build
nix flake check
```

Then run the real provider-free nested process test repeatedly under Linux. Use fake timers only for unit stages; the real test must exercise OS signals and process close events.

Run process-leak checks after the suite and verify the test registry contains no active routes or leases.

For the first live agent-enabled validation, require:

- at least one natural worker completion;
- at least one deliberately unjoined worker at parent completion;
- a complete shutdown report;
- expected `SIGTERM` behavior for the unjoined worker;
- zero active routes/leases after shutdown;
- stable workspace hash before and after a short post-barrier delay;
- complete parent and worker artifacts; and
- no snapshot/evaluation until the barrier passes.

Do not use an unjoined-worker live case as an accepted benchmark trajectory; it is a lifecycle validation.

## Implementation sequence

1. Add failing config, shutdown, spawn-race, monitor-finality, and registry-report tests.
2. Add shutdown config parsing and worker-argument forwarding.
3. Make process termination observable and upgrade controlled launchers.
4. Track spawn transactions, handles, monitors, and outcomes in `AsyncWorkerCoordinator`.
5. Refactor `monitor()` to report route and lease finalization independently.
6. Implement idempotent staged `shutdown()` and transitive registry audit.
7. Refactor agent services to install a fresh coordinator/router/run registry after session replacement.
8. Add atomic registry shutdown reports and dedicated session telemetry.
9. Register coordinator shutdown before bootstrapped-worker self-finalization.
10. Add real child/grandchild signal-cascade and workspace-stability tests.
11. Add task-framework shutdown extraction to SCBench and the experiment harness.
12. Run TypeScript, Vitest, Nix, process-leak, and provider-free SCBench checks.
13. Commit the extension change and pin its exact revision in the SCBench image/config.
14. Run one lifecycle-only container validation before any paid ablation.
15. Begin the paid matrix only after SCBench rejects missing/failed barrier reports.

## Acceptance criteria

The barrier is complete only when all of the following are true:

- New spawns reject immediately after shutdown begins.
- Every launch race either rolls back before process creation or yields a retained, terminated handle.
- Natural exits are not unnecessarily signaled during the configured drain.
- Remaining direct workers receive bounded `SIGTERM` then `SIGKILL` escalation.
- Nested workers recursively stop descendants before their own finalization.
- Pi-tracked detached tool children do not survive graceful worker termination.
- All worker monitors settle and finalize route plus lease state.
- Final registry audit finds no active owned or descendant route and no owned lease.
- No registry PID is signaled without a retained in-process handle.
- Repeated shutdown is idempotent.
- Complete and failed reports are atomically persisted and extractable.
- Active routes from another or legacy coordinator in the same run prevent a successful root barrier and are never signaled by persisted PID.
- SCBench refuses to snapshot on missing or failed reports.
- A successful report is followed by a stable workspace with no later mutation.
- Session replacement discards the closed coordinator and binds fresh agent services to the destination session before allowing new spawns.
- Existing spawn, poll, join, routing, context, projection, and worker tests remain green.
- All typecheck, Vitest, Nix build, and flake checks pass.

## Risks and mitigations

### Child killed before descendant cleanup

A direct child may need time to run its own shutdown handler. Use a depth-aware graceful budget and require a final transitive route audit. If descendants remain active, report failure and let SCBench terminate the container.

### Spawn appears after the barrier's initial snapshot

Track transactions from method entry, abort them on closure, and immediately manage any late handle. The barrier cannot succeed while any transaction remains unsettled.

### PID reuse

Never signal registry PIDs. Only retained `WorkerProcessHandle` objects may receive signals. Treat active routes without handles as an auditable failure.

### Pi swallows shutdown-handler errors

Persist reports before surfacing errors. SCBench must require a complete report; Pi process exit status alone is insufficient.

### Monitor hangs after process exit

Bound finalization, capture route and lease outcomes separately, and fail the report if monitor completion cannot be established. Do not claim quiescence solely from process exit.

### Semantic state after `SIGKILL`

Do not forge worker-owned task events. Let route evidence classify the task as derived failure and preserve the worker session for diagnosis.

### Reload/resume races

Pi emits `session_shutdown` before runtime replacement. Close and quiesce old-session workers before allowing the new runtime to be treated as usable. The next `session_start` must install a fresh session-bound coordinator/router/registry rather than reuse the memoized closed coordinator. Tests must cover all shutdown reasons.

Resuming an existing session may reopen its prior task-framework run registry. Give every coordinator runtime a distinct ID, write non-overwriting reports, and make the new root treat active routes from prior coordinator IDs as unmanaged. A nested coordinator excludes its own route and ancestor/sibling branches from that global check. Never infer process ownership merely because a semantic session ID matches.

### Longer shutdown latency

Default natural drain is zero. Grace periods are bounded and primarily affect model-discipline failures. Record elapsed time so runner overhead remains visible.

### Container escape from hard failures

The barrier cannot recover from parent `SIGKILL`, kernel failure, or a child outside Pi's managed process model. SCBench remains responsible for terminating the whole container when the proof is missing or failed.

## Alternatives rejected

- **Rely on model calls to `join_tasks`:** useful discipline, not a lifecycle guarantee.
- **Poll registry status without handles:** cannot terminate processes and is vulnerable to stale routes/PID reuse.
- **Kill every route PID:** unsafe because persisted PIDs can be stale or reused.
- **Send `SIGKILL` immediately:** bypasses worker semantic finalization, nested cleanup, and Pi's tracked-tool termination.
- **Wait indefinitely for natural completion:** violates bounded benchmark execution and can deadlock shutdown.
- **Let SCBench sleep before snapshot:** timing does not prove quiescence.
- **Use only process exit status:** does not prove monitor, route, lease, descendant, or workspace finalization.
- **Mark open worker tasks cancelled from the parent:** violates worker-session semantic ownership in the initial implementation.
- **Keep workers across checkpoints:** violates SCBench's fresh-context checkpoint semantics.

## Follow-up beyond this patch

1. Add a configurable task-framework artifact root so SCBench can export one private run directory per checkpoint without redirecting all temporary files.
2. Add native SCBench schema-v2 task/shutdown extraction and separate parent/worker accounting.
3. Consider a Pi extension API that lets a shutdown handler communicate fatal cleanup failure to the host process rather than relying on an external report gate.
4. Consider process-group or container-level worker containment as defense in depth, while retaining route and semantic finalization.
5. Revisit explicit semantic cancellation only if worker sessions gain a safe owner-authenticated remote cancellation protocol.
