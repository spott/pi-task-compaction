# Auto-Retry Context Alignment Fix Plan

## Status

**Proposed — implementation not started.**

**Size: M.** The fix is localized to context alignment and projection telemetry, but the safety review must cover task transcript ranges, partial tool-call errors, workers, and global compaction before a live campaign retry.

## Problem statement

Routine task projection currently assumes that the provider messages passed to Pi's `context` extension hook are byte-for-byte equivalent, after canonical serialization, to the messages reconstructed from `SessionManager.buildContextEntries()`:

```text
context event.messages == context entries -> provider messages
```

That invariant is false after Pi automatically retries a transient provider error. Pi intentionally:

1. persists the failed assistant message in session history;
2. emits `auto_retry_start`;
3. removes the failed assistant message from `agent.state.messages`; and
4. retries with the remaining live messages.

The persisted entry has `role: "assistant"` and `stopReason: "error"`; it can also contain partial thinking or tool-call content. The provider does not receive that entry on the retry, but `buildContextEntries()` continues to include it. The two representations therefore differ for the rest of the session.

`LocalProjectionPlanner.plan()` currently responds to any difference by retaining every candidate subtree. This is safe, but one root-session retry can silently disable task projection for all subsequent requests. In the observed long-run failure, seven rewrites succeeded before a WebSocket retry; the following 73 eligible context checks rejected 165 task candidates and allowed the raw context to grow to approximately 98k estimated tokens.

The same mechanism explains every observed alignment rejection. Sessions without an auto-retry had no such rejection; a worker retry near completion produced one isolated rejection, while a coordinator retry early in the run caused persistent treatment degradation.

## Current code path

The affected path is:

```text
src/task-framework.ts context handler
  -> LocalProjectionPlanner.plan({
       messages: event.messages,
       contextEntries: ctx.sessionManager.buildContextEntries(),
     })
  -> contextMessageRecords(contextEntries)
  -> sameMessages(messages, reconstructedMessages)
  -> retain every candidate on mismatch
```

Relevant files:

- `src/projection/planner.ts`
- `src/task-framework.ts`
- `src/evaluation/telemetry.ts`
- `test/interaction-projection.test.ts`
- `test/projection-contract.test.ts`
- `test/protocol-preservation.test.ts`
- `test/global-compaction.test.ts`

Pi's retry behavior is currently implemented by `AgentSession._prepareRetry()` in `@earendil-works/pi-coding-agent`: it removes the final error assistant message from agent state while retaining it in session history.

## Goals

1. Restore projection after a Pi auto-retry when the only difference is one or more persisted assistant error entries omitted from live provider context.
2. Preserve exact entry-to-provider-message provenance for every message that may be replaced.
3. Keep the current fail-closed behavior for all unexplained differences.
4. Never reinsert a failed assistant message into provider context.
5. Never project or fabricate a partial tool-call protocol closure.
6. Make exact alignment, retry reconciliation, actual rewrites, and rejected alignment distinguishable in telemetry.
7. Cover coordinator and worker sessions with deterministic, provider-free regression tests.

## Non-goals

- Do not change Pi's retry or session-history policy.
- Do not mutate raw Pi session entries or `event.messages` in place.
- Do not use a general fuzzy match or longest-common-subsequence algorithm.
- Do not ignore arbitrary assistant, user, tool-result, custom, branch-summary, or compaction messages.
- Do not automatically project a task range that contains an omitted partial error entry; that requires a separate proof of protocol safety.
- Do not treat `projection_count` as a count of successful rewrites. The sibling harness metric correction is a reporting follow-up, not the core extension fix.

## Required safety invariants

1. **Exact-first:** if reconstructed and live messages match exactly, behavior and output remain unchanged.
2. **One-sided omission only:** reconciliation may omit records from persistent context; it may not discard or invent a live provider message.
3. **Narrow eligibility:** an omitted record must come from a single message entry whose message has `role: "assistant"` and `stopReason: "error"`.
4. **Exact remainder:** after eligible omissions, every live message must canonically equal the corresponding reconstructed message in the same order.
5. **No fabricated provenance:** omitted entries receive no provider message index and cannot be selected as visible survivors.
6. **Partial ranges stay raw:** a task range containing an omitted provider-visible entry remains rejected as only partially visible unless a later design proves that range safe.
7. **Protocol validation remains authoritative:** existing tool-call/result closure, pin, protected-interaction, replay, and transcript-anchor checks are not relaxed.
8. **Ambiguity retains input:** any extra, reordered, changed, or otherwise unexplained message causes the current whole-plan alignment rejection.
9. **Multiple retries are deterministic:** any number of eligible persisted error entries can be reconciled, but each must independently satisfy the same rules.
10. **Content-free diagnostics:** telemetry may record mode, counts, roles, and bounded indexes/entry IDs, but not message bodies.

## Proposed design

### 1. Extract a pure context aligner

Add a small projection-layer module, preferably `src/projection/context-alignment.ts`, instead of expanding the planner's existing all-or-nothing comparison.

Suggested result shape:

```ts
interface ContextAlignment {
  status: "exact" | "retry_error_omissions" | "mismatch";
  records: ContextMessageRecord[];
  omittedRetryErrorEntryIds: string[];
  mismatch?: {
    liveMessageIndex: number;
    contextRecordIndex: number;
    reason: string;
  };
}
```

`ContextMessageRecord` should retain the session entry ID, actual provider message, and actual live-message index. The planner must not infer indexes from the unfiltered reconstructed array after an omission.

Use a deterministic two-pointer walk:

1. Compare the current live message and reconstructed record by `canonicalJson`.
2. If equal, emit an aligned record using the live-message index and advance both pointers.
3. If unequal and the reconstructed record is an eligible retry-error entry, omit that record, record its entry ID, and advance only the reconstructed pointer.
4. Otherwise return `mismatch`.
5. After live messages are exhausted, allow only trailing eligible retry-error records to be omitted.
6. Succeed only if both sequences are exhausted.

Always prefer an exact match over omission. This preserves a terminal error message when it is genuinely present in live provider context.

The omission predicate must operate on the originating `SessionEntry`, not merely on message shape detached from provenance. It should require:

```text
entry.type == "message"
entry.message.role == "assistant"
entry.message.stopReason == "error"
sessionEntryToContextMessages(entry).length == 1
```

Do not initially require a particular `errorMessage` string such as `WebSocket error`; Pi applies the same state/history policy to every retryable assistant error, and transport wording is provider-specific.

### 2. Integrate alignment without weakening candidate checks

Replace the planner's `sameMessages()` gate with the pure aligner.

- On `mismatch`, retain the existing whole-plan safe fallback and produce a bounded reason that distinguishes arbitrary mismatch from recognized retry reconciliation.
- On `exact` or `retry_error_omissions`, build `contextByEntry` from aligned records only.
- Use actual live-message indexes from the alignment result when computing splice ranges.
- Do not create a `ContextMessageRecord` for an omitted error entry.
- Refuse to reinsert an omitted error entry through pin or protected-interaction survivor handling; if `addSurvivor()` encounters an omitted entry ID, reject that candidate rather than reconstructing the entry from branch history.
- Leave `SessionProtocolResolver` and all existing candidate validation unchanged.

This means completed tasks entirely before or after the retry error can project normally. A candidate range spanning the omitted entry will have fewer aligned visible records than provider-visible session entries and will continue to fail with `task transcript is only partially visible after Pi context construction` or a stricter protocol error. That conservative limitation is intentional for the first fix.

Add assertions or tests showing that `plan()` never mutates `input.messages`, `contextEntries`, or `branchEntries`.

### 3. Add explicit alignment telemetry

Extend `ProjectionPlan` or `ProjectionPlanMetrics` with bounded alignment diagnostics:

```ts
contextAlignment: "exact" | "retry_error_omissions" | "mismatch";
omittedRetryErrorEntryCount: number;
```

Entry IDs may remain in planner-local diagnostics if useful for inspection, but evaluation telemetry should normally persist only the count. Increment the evaluation telemetry schema if the project treats additive fields as a schema change.

The telemetry must support these separate campaign measures:

- context-hook check count;
- exact alignment count;
- retry-reconciled alignment count;
- arbitrary mismatch count;
- actual rewrite count (`projectedTaskIds.length > 0` or changed output metrics);
- unique projected task IDs;
- omitted retry-error entry count;
- rejection reasons.

The sibling experiment harness currently reports `projection_count` as the number of `context_projection` records, including no-ops. Preserve it for compatibility if necessary, but add correctly named derived metrics rather than using it as successful-rewrite count.

### 4. Preserve global-compaction behavior

`DefaultTaskAwareGlobalCompactor` currently supplies both messages and entries reconstructed from the same persistent branch, so its planner call should remain `exact`. Add a regression proving the new aligner does not filter a retry-error entry when that entry is present in both inputs.

Do not silently remove error entries from Pi's global-compaction summarization input as part of this patch. That is a separate product-policy decision.

## Test plan

### Pure alignment tests

Add focused tests, preferably in `test/context-alignment.test.ts`:

1. Exact context produces `exact`, identical records, and no omissions.
2. One trailing persisted retry error omitted from live context reconciles.
3. One mid-sequence retry error reconciles when every later message matches exactly.
4. Multiple retry errors reconcile in order.
5. A retry-error message present in both sequences is matched, not omitted.
6. A missing non-error assistant message rejects.
7. A missing user, tool-result, custom, branch-summary, or compaction message rejects.
8. An extra live message rejects.
9. Changed content, changed tool-call arguments, reordering, or duplicate ambiguity rejects.
10. A retry-error entry followed by a different unexplained mismatch rejects the entire alignment.
11. Actual message indexes remain correct after one and several omissions.
12. Inputs remain unchanged.

### Planner regressions

Extend `test/interaction-projection.test.ts`:

1. Reproduce Pi's retry state: retain an assistant `stopReason: "error"` entry in `SessionManager`, remove it from the supplied live messages, and verify an eligible completed task before the error projects.
2. Verify a completed task after the error projects with correct live indexes.
3. Verify a task range spanning an omitted error remains raw.
4. Include partial thinking and a partial tool call in the omitted error message; verify it is neither emitted nor fabricated and a spanning task is rejected.
5. Verify an arbitrary foreign message still triggers the existing whole-plan rejection.
6. Verify repeated context calls after reconciliation continue projecting instead of becoming permanently disabled.

Add a stable fixture such as `retry error persisted but absent from live context` to `src/projection/fixtures.ts`, with the invariant: `recognized retry history may be absent without weakening protocol validation`.

### Worker and extension integration

Extend `test/extension.test.ts` or a focused integration fixture to exercise the real `context` handler with:

- a coordinator session after one retry omission;
- a worker-owned session after one retry omission;
- telemetry showing `retry_error_omissions` and a successful rewrite;
- a non-error mismatch showing `mismatch` and unchanged output.

The worker path must use the same aligner; do not add worker-specific reconciliation logic.

### Global-compaction and protocol regressions

Extend `test/global-compaction.test.ts` and protocol tests to prove:

- persistent error messages still match exactly when supplied in both inputs;
- a task-aware global-compaction decision remains unchanged on exact inputs;
- skipped error entries cannot satisfy a pin closure or protected interaction;
- partial tool-call error content cannot create an unmatched result or fabricated closure;
- branch, compaction, and provider-switch fixtures retain their existing behavior.

## Verification plan

Run, in order:

```sh
npm run typecheck
npm test
npm run check
nix build
nix flake check
```

Before live paid work, add or run a deterministic provider-free retry integration that follows Pi's exact state transition:

```text
persist assistant stopReason=error
remove it from live agent messages
invoke context projection again
```

Capture and compare the exact-path test corpus before and after the patch. Exact-alignment fixtures should produce byte-equivalent projected messages and unchanged projection/rejection decisions.

For a live validation, use a fresh invocation ID and require:

- at least one deliberately or naturally triggered auto-retry;
- `contextAlignment=retry_error_omissions` after the retry;
- subsequent actual context rewrites;
- no arbitrary mismatch;
- zero parser, worker, process, or artifact failures;
- exact clean materialization of the final output.

## Implementation sequence

1. Add failing pure and planner regressions for the observed retry shape.
2. Implement the pure aligner and omission predicate.
3. Replace the planner's strict whole-array gate with aligned records.
4. Add alignment diagnostics and evaluation telemetry.
5. Add worker, global-compaction, and protocol safety regressions.
6. Run all TypeScript, Vitest, Nix build, and flake checks.
7. Commit the extension fix and record the extension commit/content hash in campaign provenance.
8. Run one focused live retry validation before resuming the remaining matrix.
9. Audit actual rewrites, reconciliation counts, and arbitrary mismatches from raw telemetry rather than relying on `projection_count`.

## Campaign rollout

Preserve every existing run bundle. Do not overwrite or relabel the held round-3 compaction result.

Recommended main-analysis policy:

1. Keep compaction round 1, compaction round 2, and full round 1: they had no retries or alignment rejections, and the proposed exact path is required to remain behaviorally identical.
2. Rerun the held compaction round 3 under a fresh invocation after the fix.
3. Run the final tasks+summaries+agents example unchanged; that arm does not enable projection.
4. Run the final full example with the fixed extension.
5. Treat the existing full round-2 run with one late worker fallback as a documented sensitivity case. For strict treatment uniformity, replace it with a fixed-extension run and report the original only diagnostically.
6. Keep the heavily degraded held compaction run and both harness-failed full attempts outside accepted counts.

The report must identify the extension commit for every accepted run and distinguish:

- exact-path pre-fix runs unaffected by retries;
- retry-affected pre-fix diagnostics;
- fixed-extension retry-reconciled runs.

## Acceptance criteria

The bug is fixed only when all of the following are true:

- A deterministic reproduction fails under the old strict alignment and projects eligible tasks under the new alignment.
- Exact inputs preserve previous outputs byte-for-byte.
- Only persisted assistant `stopReason: "error"` records can be omitted.
- Every non-eligible mismatch still returns the original provider messages unchanged.
- Tasks before and after an omitted retry error can project.
- A task spanning an omitted partial error remains unprojected.
- Repeated calls after retry continue to compact instead of failing permanently.
- Coordinator and worker integration tests pass.
- Global compaction, pinning, interaction protection, replay, and provider-protocol suites pass.
- Telemetry distinguishes checks, reconciliations, actual rewrites, and rejections.
- The focused live validation demonstrates a post-retry rewrite with complete artifacts.

## Risks and mitigations

### Treating every assistant error as a retried omission

A terminal error may remain in both representations. Exact-first matching preserves it. Omission is allowed only when the live sequence cannot match without skipping that persisted error and the entire remaining sequence then matches exactly.

### Partial tool calls in failed messages

A failed assistant entry can contain incomplete protocol content. The fix does not copy that entry into provider context or use it as a visible record. Candidate ranges spanning it remain rejected, and existing protocol checks stay unchanged.

### Hiding an unrelated mismatch after an error

The aligner is not fuzzy. It may skip only eligible persisted error records; any remaining difference rejects the whole alignment.

### Pi API or retry-policy drift

Pin tests to the public message/session types and add one integration test that reproduces Pi 0.84.1 behavior. Open an upstream request for Pi to expose the exact active entry-to-provider-message mapping, which would eventually remove the need to infer omissions.

### Mid-campaign extension revision

Require exact-path equivalence tests, record both extension commits, retain all prior artifacts, and separate retry-affected diagnostics from accepted results. Do not pool the held degraded run into the primary matrix.

## Alternatives rejected

- **Filter all error messages before projection:** too broad; it could remove a live terminal error or alter global-compaction input.
- **Use longest-common-subsequence alignment:** too permissive; it could hide arbitrary provider/session divergence.
- **Patch Pi to delete retry errors from session history:** loses intentional diagnostic history and changes Pi behavior for every extension.
- **Accept permanent no-op fallback after retry:** safe for content, but silently violates the compaction treatment and defeats the feature in long sessions.
- **Project ranges spanning omitted partial errors immediately:** not justified until tool-call and interaction protocol safety is proven separately.

## Follow-up beyond this patch

Propose a Pi extension API that supplies the exact active `SessionEntry` provenance for each `ContextEvent.messages` item. With that mapping, task-compaction would not need to reconcile two independently constructed context views. Until such an API exists, the narrow retry-error omission algorithm above preserves fail-closed behavior while addressing the observed bug.
