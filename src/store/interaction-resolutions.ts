import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionProtocolResolver } from "../transcript/protocol.js";
import type { TaskRuntimeState } from "./task-runtime.js";

export const INTERACTION_RESOLUTION_CUSTOM_TYPE = "pi-task-framework/interaction-resolution";
const SCHEMA_VERSION = 1;

interface InteractionResolution {
  schemaVersion: typeof SCHEMA_VERSION;
  interactionId: string;
  taskId: string;
  sessionId: string;
  assistantEntryId: string;
  toolCallId: string;
  resultEntryId: string;
}

function isResolution(value: unknown): value is InteractionResolution {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<InteractionResolution>;
  return (
    item.schemaVersion === SCHEMA_VERSION &&
    typeof item.interactionId === "string" &&
    typeof item.taskId === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.assistantEntryId === "string" &&
    typeof item.toolCallId === "string" &&
    typeof item.resultEntryId === "string"
  );
}

function applyResolution(
  state: TaskRuntimeState,
  resolution: InteractionResolution,
  entryId: string,
): void {
  const interaction = state.interactions.get(resolution.interactionId);
  const anchor = interaction?.range.end;
  if (!interaction || !anchor?.tool || interaction.taskId !== resolution.taskId) {
    state.issues.push({
      entryId,
      code: "invalid_transition",
      message: `interaction resolution references missing interaction ${resolution.interactionId}`,
    });
    return;
  }
  if (
    anchor.sessionId !== resolution.sessionId ||
    interaction.assistantEntryId !== resolution.assistantEntryId ||
    anchor.tool.assistantEntryId !== resolution.assistantEntryId ||
    interaction.markerToolCallId !== resolution.toolCallId ||
    anchor.tool.toolCallId !== resolution.toolCallId ||
    anchor.tool.toolName !== "respond_to_user"
  ) {
    state.issues.push({
      entryId,
      code: "invalid_transition",
      message: `interaction resolution provenance is inconsistent for ${resolution.interactionId}`,
    });
    return;
  }
  if (anchor.tool.resultEntryId && anchor.tool.resultEntryId !== resolution.resultEntryId) {
    state.issues.push({
      entryId,
      code: "invalid_transition",
      message: `interaction resolution conflicts for ${resolution.interactionId}`,
    });
    return;
  }
  anchor.tool.resultEntryId = resolution.resultEntryId;
}

export function applyPersistedInteractionResolutions(
  state: TaskRuntimeState,
  entries: readonly SessionEntry[],
): void {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== INTERACTION_RESOLUTION_CUSTOM_TYPE) continue;
    if (!isResolution(entry.data)) {
      state.issues.push({
        entryId: entry.id,
        code: "invalid_event",
        message: "interaction resolution entry is malformed",
      });
      continue;
    }
    applyResolution(state, entry.data, entry.id);
  }
}

/** Persist stable result-entry IDs once Pi has written respond_to_user results. */
export function resolveAndPersistInteractionAnchors(
  state: TaskRuntimeState,
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: ExtensionContext,
): number {
  const sessionId = ctx.sessionManager.getSessionId();
  const resolver = new SessionProtocolResolver(sessionId, ctx.sessionManager.getBranch());
  let count = 0;
  for (const interaction of state.interactions.values()) {
    const anchor = interaction.range.end;
    if (!anchor.tool || anchor.tool.resultEntryId) continue;
    let unit;
    try {
      unit = resolver.resolveProtocolUnit(interaction.markerToolCallId);
    } catch {
      continue;
    }
    if (
      unit.assistantEntryId !== interaction.assistantEntryId ||
      unit.toolName !== "respond_to_user"
    ) {
      continue;
    }
    const resolution: InteractionResolution = {
      schemaVersion: SCHEMA_VERSION,
      interactionId: interaction.id,
      taskId: interaction.taskId,
      sessionId,
      assistantEntryId: interaction.assistantEntryId,
      toolCallId: interaction.markerToolCallId,
      resultEntryId: unit.resultEntryId,
    };
    pi.appendEntry(INTERACTION_RESOLUTION_CUSTOM_TYPE, resolution);
    const entryId = ctx.sessionManager.getLeafId();
    if (entryId === null) throw new Error("Pi did not expose the interaction-resolution entry ID");
    applyResolution(state, resolution, entryId);
    count += 1;
  }
  return count;
}
