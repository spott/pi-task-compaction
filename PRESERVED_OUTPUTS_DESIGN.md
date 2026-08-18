# Model-selected preserved outputs

Status: design proposal

## Problem

Task summaries are intentionally lossy. Some tool results are not disposable details: they may be expensive to reproduce, nondeterministic, or an exact prior-state snapshot needed by a later task region.

Pi already keeps the original tool result in the append-only session. The missing feature is a model-selected, branch-aware bookmark that survives task projection and can retrieve that one result directly.

The bookmark is only a reference. It does not copy the result body into every future model request.

## Version 1 scope

Version 1 provides:

1. `preserve_output`, called after a tool result that should remain available.
2. An optional `end_task` input that identifies an unbookmarked result by its raw source tool-call ID and supplies preservation metadata.
3. Automatic injection of every region-local preservation into the durable end marker and rendered task summary.
4. `list_preserved_outputs`, which returns compact branch-local metadata.
5. `read_preserved_output`, which re-emits the persisted result body under a new valid tool call/result pair.
6. Branch-local reconstruction from the append-only session, without a sidecar database.

Version 1 deliberately does **not** include expiration, retention classes, release, paging, cursors, redaction, denylists, or cross-session storage. Those are possible version 2 features, after actual usage shows which are needed.

## Goals

1. Let the model explicitly identify outputs that will remain useful after task compaction.
2. Keep preserved bodies out of normal provider context until requested.
3. Preserve the exact result Pi persisted, with provenance and a content hash.
4. Make preserved outputs visible by stable ID and human-readable label in task summaries.
5. Let delayed selection happen at `end_task` without double-tagging an output already selected with `preserve_output`.
6. Reconstruct preservation state from the active session branch without external mutable state.

## Non-goals

- Keeping arbitrary large outputs permanently inline in every model request.
- Recovering bytes that the source tool truncated before Pi persisted its result.
- Replacing the durable typed task summary.
- Caching cheap, stable repository reads instead of reading them again.
- Copying preserved bodies into an extension-owned database or sidecar file in version 1.
- Automatic semantic classification of every tool result.
- Giving preservation IDs meaning outside the session branch that owns their source entries.

## Why there is no expiration in version 1

A preservation record is small. Its body already exists in the append-only session and preservation does not make another copy. Normal projected context contains only a compact reference in the source task's summary; the body enters context only when explicitly read. A potentially long list is also produced only when `list_preserved_outputs` is explicitly called.

Expiration therefore saves little in version 1. It does not reclaim the source result, and it adds lifecycle semantics to branch reconstruction. It is also unclear how expiration should interact with the immutable preservation references already captured in historical end markers: either an expired reference remains visible there, or summary projection must become dependent on later state.

Version 1 keeps preservation records for as long as their marker and source result are ancestors of the active branch. Release, expiry, retention classes, and list scaling can be designed together in version 2 if real sessions show that the metadata becomes burdensome.

## Why references, not uncompacted tool messages

A provider tool-result message is protocol-coupled to its assistant tool call. Injecting the original result without the matching call can produce an invalid conversation. Injecting both call and result permanently consumes the context that task compaction is intended to recover.

A preserved output therefore appears in projected context as a small reference:

```text
Preserved outputs:
- po_a17c9e2b — slow API inventory (mcp, 18,420 chars)
  Reason: nondeterministic response needed by the implementation task
```

The exact persisted body enters context only as the result of an explicit `read_preserved_output` call. That creates a new, valid call/result pair.

## Selection path 1: `preserve_output`

Use `preserve_output` immediately after seeing a result that should survive the current task:

```ts
interface PreserveOutputInput {
  label: string;
  reason?: string;
}
```

Selection rules:

1. Select the most recent completed tool result preceding `preserve_output` on the active branch.
2. Reject the call if there is no preceding completed result.
3. The model should call it in the next assistant turn after the source result. It should avoid placing unrelated or parallel tool calls between the source and `preserve_output`.
4. If the source is inside an open task, record that task ID.
5. The source must remain an ancestor of the preservation marker.

The tool returns a stable preservation ID:

```text
Preserved po_a17c9e2b: slow API inventory
```

The ID identifies the preservation record, not a copy of the body.

### Model guidance

> Use `preserve_output` only when the exact result is likely to be needed after task compaction and rerunning the source would be expensive, slow, nondeterministic, or would lose an important prior state. Do not preserve cheap reads of stable files, routine low-information output, or results that are easy to reproduce. Do not preserve credentials.

## Selection path 2: raw tool-call IDs in `end_task`

`end_task` supports delayed selection for results that were not already bookmarked:

```ts
interface PreserveToolOutputSelector {
  source_tool_call_id: string;
  label: string;
  reason?: string;
}

interface EndTaskInput {
  // existing summary fields
  preserve_tool_outputs?: PreserveToolOutputSelector[];
}
```

This field takes raw **source tool-call IDs**, not preservation IDs. Passing a preservation ID back to `end_task` would double-tag an output and make the API harder to understand.

For each selector, `end_task`:

1. Resolves the call ID to one completed tool result inside the open task's validated branch range.
2. Rejects a missing, incomplete, future, off-branch, or out-of-region source.
3. Creates a preservation record using the supplied label and reason plus derived source metadata.
4. Adds that record to the end marker and rendered summary.

Every explicit `preserve_output` created inside the region is added automatically. The model must not copy preservation IDs or metadata into the `end_task` input, `artifacts`, `learnings`, or `open_threads` fields.

If a raw selector names a source already selected by a region-local `preserve_output`, `end_task` emits only the existing preservation record. The earlier explicit label and reason win. This deduplication is defensive; model guidance should say not to select the same output by both paths.

Invalid raw selectors should fail `end_task` rather than silently close the task without the requested preservation.

## Persistence schema

Store preservation state in tool-result `details`, consistent with Pi's branch-aware state guidance:

```ts
const PRESERVATION_SCHEMA_VERSION = 1;

interface PreservedOutputRecord {
  preservationId: string;
  label: string;
  reason?: string;

  sourceTaskId?: string;
  sourceEntryId: string;
  sourceToolCallId: string;
  sourceToolName: string;
  sourceIsError: boolean;
  sourceChars: number;
  sourceSha256: string;
  sourceReportedTruncation?: boolean;

  selectedBy: "preserve_output" | "end_task";
}

interface PreserveOutputMarker extends PreservedOutputRecord {
  extension: "pi-task-compaction";
  schemaVersion: 1;
  event: "preserve-output";
}
```

A `preserve_output` result stores a `PreserveOutputMarker`. A preservation created through a raw `end_task` selector is stored directly in that end marker's `preservedOutputs` field; the end marker is its creation event. Reconstruction scans both forms and deduplicates by preservation ID.

The record stores provenance and integrity metadata, not a duplicate body. The source tool-result entry in session JSONL remains the body of record.

Hash the canonical JSON representation of the persisted content blocks together with `isError` and the source tool name. This supports text and image blocks without pretending that concatenated text is the complete original result.

Preservation IDs need only be unique and stable once persisted. They are branch-local capabilities, not globally meaningful content IDs.

## Automatic task-summary injection

Extend the durable end marker additively:

```ts
interface EndMarker {
  // existing fields
  preservedOutputs?: PreservedOutputRecord[];
}
```

When `end_task` executes, it collects:

- all valid `preserve_output` records created inside the open region; and
- all new records created from `preserve_tool_outputs` raw selectors.

It writes the complete records to `EndMarker.preservedOutputs`. `formatTaskSummary()` renders the useful model-facing metadata: preservation ID, label, optional reason, source tool, and source size. It never renders the body. Internal source entry IDs and the full hash remain in the typed marker and list/read metadata rather than consuming normal projected context.

This injection is mandatory implementation behavior. It does not depend on the model remembering to mention preserved output in any typed summary array. Old end markers without `preservedOutputs` remain valid.

## Listing preserved outputs

Register:

```ts
interface ListPreservedOutputsInput {}

interface PreservedOutputListItem {
  preservation_id: string;
  label: string;
  reason?: string;
  source_task_id?: string;
  source_tool_call_id: string;
  source_tool_name: string;
  source_chars: number;
  source_sha256: string;
  source_is_error: boolean;
  source_reported_truncation?: boolean;
}
```

`list_preserved_outputs` scans the active branch and returns compact metadata in source order. It does not include bodies or source tool arguments. Version 1 returns the complete list; paging, filtering, release state, and retention state are deferred.

## Viewing a preserved output

Register:

```ts
interface ReadPreservedOutputInput {
  preservation_id: string;
}

interface PreservedOutputReadDetails {
  extension: "pi-task-compaction";
  schemaVersion: 1;
  event: "read-preserved-output";
  preservationId: string;
  sourceEntryId: string;
  sourceToolCallId: string;
  sourceToolName: string;
  sourceChars: number;
  sourceSha256: string;
  sourceIsError: boolean;
  sourceReportedTruncation?: boolean;
}
```

`read_preserved_output`:

1. Resolves the record and source only on the active branch.
2. Recomputes and verifies the source hash.
3. Re-emits all supported persisted content blocks as one new tool result.
4. Returns an explicit error if the source is missing, has changed, or contains a block type the v1 reader cannot reproduce honestly.
5. Reports source-tool truncation when the persisted source metadata makes it detectable.

Version 1 has no extension-level `max_chars`, cursor, or partial-read protocol. The read returns the complete persisted result. Paging and cursors are version 2 work if practical outputs prove too large for a single read. Preservation can only recover what Pi persisted; it cannot recover content omitted or truncated by the original tool.

## Good and bad candidates

Good candidates are defined by reproduction cost or the need for an exact historical value, not by the subject matter of the output.

Good candidates:

- expensive CPU results such as a long benchmark, solver run, or analysis
- expensive or slow network results such as a large site fetch or rate-limited API query
- nondeterministic results such as a live service response or transient diagnostic
- exact prior-state snapshots needed for comparison after files or external state change
- costly research synthesis returned directly by a tool and not stored in a durable artifact

Usually poor candidates:

- cheap reads of repository files that are expected not to change
- requirements, plans, or notes that have a stable path and can be cheaply reread
- routine passing test output or other low-information output
- reproducible command output that is cheap to regenerate
- large generated logs already stored at a durable path
- broad documentation dumps that are cheap to fetch again
- credential-bearing output

A requirements document or Obsidian plan can still be worth preserving when its exact prior state matters, it is mutable or remote, or retrieving it is genuinely expensive. It is not a good candidate merely because it contains requirements.

## Branch behavior

- State is reconstructed from preserve markers and end markers on `ctx.sessionManager.getBranch()`.
- The source body remains in the append-only branch even when task projection replaces it for provider context.
- Pi compaction entries do not become the source of truth for preserved bodies.
- Forking before a preservation record removes that preservation from the new active branch.
- Forking after a preservation record retains it only when the source entry is also an ancestor.
- A record whose source is not an ancestor is invalid and is ignored with a diagnostic.
- Resume and reload require no sidecar recovery.
- With no v1 release or expiry event, reconstruction is monotonic along a branch.

## Future agent-framework integration

Task summaries and preserved outputs make a useful handoff vocabulary for spawned agents. A future agent API could accept selected task IDs and preservation IDs:

```ts
interface SpawnAgentContext {
  task_ids?: string[];
  preserved_output_ids?: string[];
}
```

The framework could inject the selected task summaries directly and give the child a compact list of selected preservation references plus a scoped `read_preserved_output` capability. This keeps large bodies out of the child's initial context while allowing exact retrieval. If a body is certainly needed immediately, the framework could instead materialize that selected result into the handoff context.

This is moderate work when parent and child share a process and a session resolver: most required provenance and lookup machinery already exists, with the main additions being context assembly and capability scoping.

It is substantially harder when the child has an independent session or process. Preservation IDs currently resolve through entries on the parent's active branch, so the framework would need either an explicit handoff bundle containing selected summaries and bodies, or a shared immutable/content-addressed store. Cross-process use also needs lifecycle, access-scope, and context-budget rules. That is a separate, larger design and is not part of preserved outputs version 1.

## Minimal version 1 caution

The source output has already been sent to the model, so preservation does not introduce a new secret into the session. It does make the output easier to rediscover. Version 1 therefore adds only prompt guidance not to preserve credentials; configurable redaction, denylists, export policy, and broader privacy controls are deferred.

For tools that return a temporary path to omitted full output, preserving the tool result does not preserve the temporary file. The model must create a durable artifact separately when the omitted body matters.

## Implementation outline

1. Add preservation record and read/list detail types in `src/types.ts`.
2. Add strict parsers for preserve markers and additive end-marker fields in `src/markers.ts`.
3. Add `src/preserved.ts` for source resolution, canonical hashing, branch reconstruction, deduplication, and full-result reads.
4. Register `preserve_output`, `list_preserved_outputs`, and `read_preserved_output` in `extensions/task-compaction.ts`.
5. Add `preserve_tool_outputs` raw selectors to `end_task` and resolve them during existing region validation.
6. Automatically snapshot all region-local preservation records into `EndMarker.preservedOutputs`.
7. Render compact references in end-task results and projected task summaries.
8. Include preservation diagnostics in `/tasks` without changing region acceptance rules.

Preservation calls are ordinary complete tool protocol units inside a task and therefore do not weaken the existing region validation model.

## Version 1 tests

Add coverage for:

1. `preserve_output` selects the immediately preceding completed tool result.
2. A missing preceding result is rejected.
3. Source provenance and hashes are recorded without body duplication.
4. A raw source tool-call ID passed to `end_task` creates a preservation record.
5. Missing, incomplete, future, off-branch, and out-of-region raw selectors fail `end_task`.
6. A source selected through both paths is deduplicated and keeps the explicit `preserve_output` metadata.
7. End markers and rendered task summaries automatically include all region-local references but not bodies.
8. The model need not copy preservation metadata into any typed summary array.
9. List output contains compact metadata and no bodies or source arguments.
10. Reads reproduce all supported persisted content blocks and verify integrity.
11. A missing or mismatched source fails explicitly.
12. Fork-before and fork-after behavior reconstruct correctly.
13. Old end markers parse unchanged.
14. Global compaction does not make an active preserved result unreadable.
15. Source-tool truncation remains visible when detectable.
16. Unsupported content blocks fail honestly rather than claiming complete recovery.

## Deferred to version 2 or later

- expiration and named retention classes
- explicit release and append-only release markers
- paging, cursors, and partial reads
- list paging and filtering if lists become large in practice
- redaction, denylisted tools or detail paths, and configurable privacy policy
- richer user navigation such as a dedicated `/preserved` browser
- cross-session/global preserved-output storage
- first-class spawned-agent handoff APIs

These features should be justified by observed usage. They are not prerequisites for the minimum useful release.

## Delivery slices

1. **M:** record schema, `preserve_output`, branch reconstruction, list/read tools, hashing, and provenance checks.
2. **M:** `end_task` raw selectors, automatic summary injection, deduplication, rendering, and compatibility tests.
3. **Later:** version 2 lifecycle, paging, privacy controls, and agent-framework integration as separately approved designs.

The minimum useful version is slices 1 and 2 together. It fixes the motivating workflow while keeping the API small and avoiding lifecycle semantics before they are needed.
