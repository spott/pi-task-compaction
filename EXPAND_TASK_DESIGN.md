# Better `expand_task`

Status: design proposal

## Problem

The current `expand_task` serializes a completed task from its first entry forward and then hard-caps the resulting string. It can omit all tool output or filter tool results by tool name, but it cannot navigate to a particular event or continue after truncation.

That makes recovery proportional to the size of the task rather than the size of the missing fact. In the motivating session, the model wanted the exact result of one Obsidian note read. It requested 20,000 characters with tool output enabled, received the beginning of the research task plus unrelated Pi documentation, hit the cap, and then reread the note directly.

The raw transcript was recoverable; it was not conveniently addressable. Pi already runs in an environment with normal file tools, so `expand_task` should expose a branch-validated task transcript as a file rather than implementing another bespoke paging and text-navigation protocol.

## Goals

1. Materialize the complete persisted task transcript as a JSONL file.
2. Let normal tools such as `rg`, `grep`, `head`, `tail`, `read`, and `jq` inspect that file.
3. List compact entry metadata without exposing complete arguments or bodies.
4. Search calls, arguments, reasoning, responses, and full persisted tool-result text.
5. Resolve an entry ID to its exact line in the transcript artifact.
6. Keep list and search responses bounded and resumable.
7. Keep every operation branch-aware and avoid exposing unrelated session entries.
8. Make artifact provenance, source truncation, and continuation state explicit in tool details.

## Non-goals

- Semantic or embedding search in the first version.
- Rewriting session JSONL.
- Restoring a compacted task wholesale to every later provider request.
- Bypassing truncation already applied by the original tool. `expand_task` can expose only what Pi persisted.
- Returning the complete raw session file, which may contain unrelated tasks and branches.
- Maintaining the old bounded inline transcript interface. There are no legacy users requiring compatibility.
- Creating a separate copy of an entry body when the transcript artifact already contains it.
- Treating generated transcript artifacts as durable user-authored project files.

## Proposed interface

Use a required view selector. `transcript` and `entry` return file metadata or locators; `list` and `search` return bounded inline navigation results.

```ts
interface ExpandTaskInput {
  task_id: string;
  view: "transcript" | "list" | "search" | "entry";

  // search
  query?: string;
  context_entries?: number; // default 1, maximum 10

  // direct lookup
  entry_id?: string;

  // bounded list/search continuation
  cursor?: string;
  direction?: "forward" | "backward"; // default forward
  max_chars?: number; // 1,000..50,000; default 30,000
}
```

Validation rules:

- `query` is required only for `view: "search"`.
- `entry_id` is required only for `view: "entry"`.
- `cursor` is valid only for `list` and `search`.
- `cursor` is mutually exclusive with `query`; it resumes the original request encoded by the cursor.
- `max_chars` applies only to inline `list` and `search` output. It does not limit transcript artifacts or entry bodies.
- `context_entries` applies only to `search`.
- Unknown fields from the removed inline interface, including `include_entry_ids`, `include_tool_output`, and `tool_names`, fail validation rather than silently changing the artifact.

Recommended model guidance:

> Use `expand_task` with `view: "list"` or `view: "search"` to locate relevant entries. Use `view: "entry"` to obtain an exact JSONL locator. Use `view: "transcript"` when normal file tools are more efficient than inline inspection. Generated files contain complete persisted task data and may contain sensitive arguments or results; do not copy them into the repository.

## Transcript artifact

`view: "transcript"` materializes the validated task range as UTF-8 JSONL. Each line is one complete `SessionEntry`, serialized without extension-level clipping. JSON strings escape embedded newlines, so every artifact line corresponds to exactly one session entry.

The artifact includes every persisted branch entry between the validated begin and end boundaries. It does not include entries elsewhere in the session or on inactive branches.

Example result text:

```text
Task 7664a8c3 transcript: /tmp/pi-task-compaction/4e13.../7664a8c3-a91f....jsonl
47 entries, 384,201 bytes, sha256 a91f...
```

The same data is returned in typed details:

```ts
interface TranscriptArtifact {
  path: string;
  format: "pi-session-entry-jsonl";
  entries: number;
  bytes: number;
  sha256: string;
  beginEntryId: string;
  endEntryId: string;
}
```

Typical inspection commands are ordinary file operations:

```bash
rg -n 'Pi Experiment Harness/Plan.md' <path>
head -n 5 <path>
tail -n 5 <path>
jq 'select(.id == "fc6d92a3")' <path>
jq -r 'select(.id == "fc6d92a3") | .message.content[]? | select(.type == "text") | .text' <path>
```

The artifact is a task-specific projection, not a pointer to the complete Pi session file. It is also not injected into future model requests automatically; only the small tool result containing its descriptor enters context.

### Artifact safety and lifecycle

- Write artifacts outside the working repository under a session-specific private directory.
- Create directories with mode `0700` and files with mode `0600`.
- Write to a new temporary file and atomically rename it into place.
- Derive the artifact identity from the task boundaries and exact emitted bytes, not from a user-controlled task ID alone.
- Sanitize any human-readable filename component and do not follow attacker-controlled symlinks.
- Reuse an existing artifact only after verifying its hash and provenance.
- Regenerate or revalidate the artifact on every `expand_task` call against the active branch.
- Treat artifacts as ephemeral caches. They may be removed when the session ends or the cache is cleaned and can always be regenerated from the session.
- Never create or modify files under the project working tree.

A transcript artifact may remain readable after the caller later changes branches, just as a previously returned tool result remains in history. A new expansion call must nevertheless validate the requested task against the then-active branch and must not return a stale artifact for a task that is no longer an ancestor.

## Views

### `list`

Return one compact line per session entry in the task artifact:

```text
<task-list id="7664a8c3" entries="47" path="/tmp/.../7664a8c3-a91f.jsonl">
[1 fc6d92a3] toolResult mcp call=call_... 18,420 chars
[2 fec50763] assistant tools=bash,bash,bash
[3 50729a81] toolResult bash call=call_... 312 chars
...
</task-list>
```

Each line contains only navigation metadata:

- one-based artifact line number
- session entry ID
- entry or message role
- tool name and tool call ID for calls and results
- persisted text size
- error and recognized source-truncation flags
- a short, sanitized label when one can be derived safely

Do not dump complete arguments into the list. Arguments can contain prompts, credentials, or large inline data. Safe labels may include a read path, MCP tool name, or command prefix only after applying strict length caps and redaction rules.

If the complete list exceeds `max_chars`, return a cursor that continues at the next whole list record. The response reports the total entry count separately from the returned count.

### `search`

Version 1 uses case-insensitive literal matching. Search these decoded persisted sources:

- assistant text and thinking
- tool names and serialized arguments
- complete text blocks in persisted tool results
- custom messages inside the task

Search must inspect complete persisted values, not the 2,000-character tool-result serialization used by `serializeConversation()`. Returned excerpts remain bounded and identify the artifact path, entry ID, and one-based line number.

```text
<task-search id="7664a8c3" query="Pi Experiment Harness/Plan.md" matches="2" path="/tmp/.../7664a8c3-a91f.jsonl">
[12 3b2ebb97] assistant tool call mcp
... "path":"Programming/Pi Experiment Harness/Plan.md" ...

[13 fc6d92a3] toolResult mcp call=call_...
... # Pi Experiment Harness ...
</task-search>
```

Overlapping context-entry windows must be merged. The response reports total matches separately from returned matches. When bounded output omits later matches, the cursor continues at the next complete merged result window.

Search is intentionally retained even though the artifact can be searched with `rg` or `jq`. It provides a low-context discovery path, understands decoded entry fields, and works for callers that have a file-reading tool but no shell pipeline.

### `entry`

Validate that `entry_id` belongs to the selected task on the active branch, materialize or reuse the task transcript artifact, and return a locator rather than the entry body:

```text
Entry fc6d92a3 is line 13 of /tmp/.../7664a8c3-a91f.jsonl
```

```ts
interface EntryLocator {
  path: string;
  format: "pi-session-entry-jsonl";
  entryId: string;
  line: number; // one-based
  entryBytes: number;
  artifactSha256: string;
}
```

The caller can use the line number or entry ID:

```bash
sed -n '13p' <path>
jq 'select(.id == "fc6d92a3")' <path>
```

`entry` works even if `transcript` was not called first; it creates the same transcript artifact on demand. It does not create a standalone per-entry file. There is no entry-level `max_chars` or cursor because the extension does not inline the body.

### `transcript`

Return the transcript artifact descriptor described above. The tool result never contains the artifact body, has no `max_chars`, and has no continuation cursor.

## Cursor contract

Cursors exist only for bounded `list` and `search` responses. A cursor is an opaque, versioned token. Its decoded payload may resemble:

```ts
interface ExpansionCursorV1 {
  version: 1;
  taskId: string;
  beginEntryId: string;
  endEntryId: string;
  artifactSha256: string;
  requestFingerprint: string;
  resultIndex: number;
  direction: "forward" | "backward";
}
```

The caller must not construct or edit cursors. The extension validates every field against the current branch, task boundaries, artifact hash, view, query, context size, and direction. Stale or mismatched cursors fail explicitly.

Using boundary IDs and the artifact hash keeps the cursor stable when unrelated entries are appended after a closed task. A cursor remains valid on a descendant branch when the exact task range is still present and unchanged.

## Result details

All views share base expansion details:

```ts
interface ExpansionDetailsBase {
  extension: "pi-task-compaction";
  schemaVersion: 1;
  event: "expand";
  taskId: string;
  view: "transcript" | "list" | "search" | "entry";
  artifact: TranscriptArtifact;
}
```

`transcript` adds no paging fields. `entry` adds `locator: EntryLocator`. `list` and `search` add bounded-result details:

```ts
interface BoundedExpansionDetails extends ExpansionDetailsBase {
  view: "list" | "search";
  truncated: boolean;
  truncationReason?: "max_chars";
  returnedChars: number;
  returnedRecords: number;
  totalRecords: number;
  nextCursor?: string;
  previousCursor?: string;
}
```

Search details also report `totalMatches`. Recognized source-tool truncation belongs to entry/list metadata rather than expansion-level truncation: the artifact contains the complete body Pi persisted even when the producing tool had already omitted data.

The text result ends with a concise continuation instruction when `nextCursor` exists. It always identifies the transcript artifact so the caller can switch from inline navigation to normal file tools.

## Extraction and artifact model

Keep raw artifact generation separate from derived list/search metadata:

```ts
interface MaterializedTranscript {
  descriptor: TranscriptArtifact;
  entries: MaterializedEntry[];
}

interface MaterializedEntry {
  entry: SessionEntry;
  entryId: string;
  branchIndex: number;
  line: number;
  byteOffset: number;
  byteLength: number;
  searchText: string; // full decoded persisted text used only for matching
}
```

Pipeline:

1. Validate that the task has recoverable begin and end boundaries on the active branch.
2. Select every branch entry in that inclusive range.
3. Serialize each entry deterministically as one JSON object followed by `\n`.
4. Hash and atomically materialize the exact bytes in a private cache location.
5. Build entry locators and bounded list metadata from those same selected entries.
6. Build complete decoded `searchText` values without display truncation.
7. Select and page inline records only for `list` or `search`.
8. Return artifact and continuation metadata without mutating session history.

The artifact is the source of truth for line numbers and locators. Search extraction may decode structured fields for better matching, but every result must point back to an exact artifact entry.

## Interaction with preserved outputs

`expand_task` remains the general recovery and discovery mechanism. Preserved outputs solve a narrower problem: the model already knows at task close that one exact result will be needed later and wants it re-emitted as a valid tool result.

A productive flow is:

1. List or search a historical task.
2. Identify a result entry and obtain its artifact locator.
3. Inspect it with normal file tools.
4. Use a preserved-output reference instead when the exact body needs to re-enter model context repeatedly or includes non-text content that ordinary text inspection does not render usefully.

The two features should share branch validation, persisted-content extraction, hashing, and source-truncation detection. Transcript artifacts do not replace preservation IDs and are not automatically recorded in task summaries.

## Compatibility and migration

- The old bounded inline transcript behavior is removed rather than maintained behind a compatibility mode.
- `view` is required; calls using only the old fields fail validation with guidance to use `transcript`, `list`, `search`, or `entry`.
- Existing task begin/end markers do not change.
- Expansion result details adopt the view-specific schema above. No parser compatibility for old development-only expansion details is required.
- Expansion counts in `/tasks` continue to count calls, independent of view or list/search page.
- Session branches remain the authority; generated artifacts are derived caches, not an external state index.

## Tests

Add coverage for:

1. Transcript view returns a descriptor and does not inline transcript content.
2. The JSONL artifact contains exactly the validated inclusive task range in branch order.
3. Every artifact line parses as one complete `SessionEntry` and line numbers match entry locators.
4. Persisted tool-result text beyond 2,000 characters appears completely in the artifact.
5. Unrelated entries before, after, or on another branch do not appear in the artifact.
6. Artifact directories and files use private permissions and writes are atomic.
7. Artifact reuse verifies provenance and SHA-256 rather than trusting a filename.
8. List view exposes entry IDs and safe metadata without leaking full arguments.
9. List cursors cover all records without gaps or duplication.
10. Search finds calls, reasoning, arguments, custom messages, and result text beyond display serialization limits.
11. Search context windows merge without duplicate entries.
12. Search cursors cover all merged result windows without gaps or duplication.
13. Entry view resolves the exact one-based line and works without a preceding transcript call.
14. Entry view rejects an ID outside the selected task or inactive branch.
15. Cursor/task, cursor/query, cursor/artifact, and cursor/branch mismatches fail explicitly.
16. Appending entries after a closed task does not invalidate its artifact or cursor unnecessarily.
17. Inline list and search output never exceeds `max_chars`; transcript and entry reject that field.
18. Recognized source-tool truncation is reported without incorrectly marking the artifact itself truncated.
19. No expansion view writes into the project working tree.
20. Old inline-only invocations fail with actionable migration guidance.

## Delivery slices

1. **M:** deterministic private JSONL artifact generation, transcript descriptors, entry locators, and branch/provenance validation.
2. **M:** bounded list view with safe labels and resumable cursors.
3. **M:** literal search over complete decoded persisted text with merged context windows and resumable cursors.
4. **S:** prompt guidance, rendering, README updates, migration errors, and integration tests.

The first useful release should include slices 1 and 2 together: the artifact makes complete recovery possible, while the list gives the model a cheap way to discover exact entry IDs and line numbers before invoking normal file tools.
