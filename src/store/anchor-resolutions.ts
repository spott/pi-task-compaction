import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TaskRuntimeState } from "./task-runtime.js";
import { SessionProtocolResolver } from "../transcript/protocol.js";

export const ANCHOR_RESOLUTION_CUSTOM_TYPE = "pi-task-framework/anchor-resolution";
const SCHEMA_VERSION = 1;

export interface AnchorResolution {
  schemaVersion: typeof SCHEMA_VERSION;
  taskId: string;
  edge: "begin" | "end";
  sessionId: string;
  assistantEntryId: string;
  toolCallId: string;
  toolName: string;
  resultEntryId: string;
}

function isResolution(value: unknown): value is AnchorResolution {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AnchorResolution>;
  return (
    item.schemaVersion === SCHEMA_VERSION &&
    typeof item.taskId === "string" &&
    (item.edge === "begin" || item.edge === "end") &&
    typeof item.sessionId === "string" &&
    typeof item.assistantEntryId === "string" &&
    typeof item.toolCallId === "string" &&
    typeof item.toolName === "string" &&
    typeof item.resultEntryId === "string"
  );
}

function applyResolution(
  state: TaskRuntimeState,
  resolution: AnchorResolution,
  entryId: string,
): void {
  const task = state.tasks.get(resolution.taskId);
  const anchor = resolution.edge === "begin" ? task?.transcript.beginAnchor : task?.transcript.endAnchor;
  if (!task || !anchor?.tool) {
    state.issues.push({
      entryId,
      code: "invalid_transition",
      message: `anchor resolution references missing ${resolution.edge} task boundary ${resolution.taskId}`,
    });
    return;
  }
  if (
    anchor.sessionId !== resolution.sessionId ||
    anchor.tool.assistantEntryId !== resolution.assistantEntryId ||
    anchor.tool.toolCallId !== resolution.toolCallId ||
    anchor.tool.toolName !== resolution.toolName
  ) {
    state.issues.push({
      entryId,
      code: "invalid_transition",
      message: `anchor resolution provenance is inconsistent for task ${resolution.taskId}`,
    });
    return;
  }
  if (anchor.tool.resultEntryId && anchor.tool.resultEntryId !== resolution.resultEntryId) {
    state.issues.push({
      entryId,
      code: "invalid_transition",
      message: `anchor resolution conflicts for task ${resolution.taskId}`,
    });
    return;
  }
  anchor.tool.resultEntryId = resolution.resultEntryId;
}

export function applyPersistedAnchorResolutions(
  state: TaskRuntimeState,
  entries: readonly SessionEntry[],
): void {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ANCHOR_RESOLUTION_CUSTOM_TYPE) continue;
    if (!isResolution(entry.data)) {
      state.issues.push({
        entryId: entry.id,
        code: "invalid_event",
        message: "anchor resolution entry is malformed",
      });
      continue;
    }
    applyResolution(state, entry.data, entry.id);
  }
}

/**
 * Persist result-entry IDs after Pi has written the tool-result messages at
 * turn_end. Semantic task events are still the sole task-status authority.
 */
export function resolveAndPersistTaskAnchors(
  state: TaskRuntimeState,
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: ExtensionContext,
): number {
  const sessionId = ctx.sessionManager.getSessionId();
  const resolver = new SessionProtocolResolver(sessionId, ctx.sessionManager.getBranch());
  let count = 0;
  for (const task of state.tasks.values()) {
    for (const [edge, anchor] of [
      ["begin", task.transcript.beginAnchor],
      ["end", task.transcript.endAnchor],
    ] as const) {
      if (!anchor?.tool || anchor.tool.resultEntryId) continue;
      let unit;
      try {
        unit = resolver.resolveProtocolUnit(anchor.tool.toolCallId);
      } catch {
        continue;
      }
      if (
        unit.assistantEntryId !== anchor.tool.assistantEntryId ||
        unit.toolName !== anchor.tool.toolName
      ) {
        continue;
      }
      const resolution: AnchorResolution = {
        schemaVersion: SCHEMA_VERSION,
        taskId: task.id,
        edge,
        sessionId,
        assistantEntryId: unit.assistantEntryId,
        toolCallId: unit.toolCallId,
        toolName: unit.toolName,
        resultEntryId: unit.resultEntryId,
      };
      pi.appendEntry(ANCHOR_RESOLUTION_CUSTOM_TYPE, resolution);
      const entryId = ctx.sessionManager.getLeafId();
      if (entryId === null) throw new Error("Pi did not expose the persisted anchor-resolution entry ID");
      applyResolution(state, resolution, entryId);
      count += 1;
    }
  }
  return count;
}
