import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type {
  GlobalCompactionDecision,
  GlobalCompactionDetails,
} from "../compaction/global.js";
import type { ProjectionPlan } from "../projection/planner.js";

export const EVALUATION_TELEMETRY_CUSTOM_TYPE = "pi-task-framework/evaluation";
export const EVALUATION_TELEMETRY_SCHEMA_VERSION = 2;

interface EvaluationRecordBase {
  schemaVersion: typeof EVALUATION_TELEMETRY_SCHEMA_VERSION;
  at: number;
  sessionId: string;
}

export interface ContextProjectionRecord extends EvaluationRecordBase {
  kind: "context_projection";
  projectedTaskIds: string[];
  projectionRejections: Array<{ taskId: string; reasons: string[] }>;
  metrics: ProjectionPlan["metrics"];
}

export interface GlobalCompactionRecord extends EvaluationRecordBase {
  kind: "global_compaction";
  reason: SessionBeforeCompactEvent["reason"];
  willRetry: boolean;
  cancelled: boolean;
  cancelledReason?: string;
  requestedFirstKeptEntryId: string;
  alignedFirstKeptEntryId?: string;
  alignment?: GlobalCompactionDetails["alignment"];
  projectedTaskIds: string[];
  projectionRejections: Array<{ taskId: string; reasons: string[] }>;
  summarizedMessageCount?: number;
  tokensBefore: number;
}

export type EvaluationTelemetryRecord = ContextProjectionRecord | GlobalCompactionRecord;

function append(pi: Pick<ExtensionAPI, "appendEntry">, record: EvaluationTelemetryRecord): void {
  pi.appendEntry(EVALUATION_TELEMETRY_CUSTOM_TYPE, record);
}

/** Persist bounded, content-free provider-context measurements for M13 extraction. */
export function recordContextProjection(
  pi: Pick<ExtensionAPI, "appendEntry">,
  sessionId: string,
  plan: ProjectionPlan,
  at = Date.now(),
): ContextProjectionRecord {
  const record: ContextProjectionRecord = {
    schemaVersion: EVALUATION_TELEMETRY_SCHEMA_VERSION,
    kind: "context_projection",
    at,
    sessionId,
    projectedTaskIds: [...plan.projectedTaskIds],
    projectionRejections: plan.rejections.map((rejection) => ({
      taskId: rejection.taskId,
      reasons: [...rejection.reasons],
    })),
    metrics: { ...plan.metrics },
  };
  append(pi, record);
  return record;
}

/** Persist successful and cancelled global-compaction decisions alike. */
export function recordGlobalCompaction(
  pi: Pick<ExtensionAPI, "appendEntry">,
  sessionId: string,
  event: SessionBeforeCompactEvent,
  decision: GlobalCompactionDecision,
  at = Date.now(),
): GlobalCompactionRecord {
  const details = decision.compaction?.details;
  const record: GlobalCompactionRecord = {
    schemaVersion: EVALUATION_TELEMETRY_SCHEMA_VERSION,
    kind: "global_compaction",
    at,
    sessionId,
    reason: event.reason,
    willRetry: event.willRetry,
    cancelled: decision.cancel === true,
    ...(decision.diagnostics.cancelledReason
      ? { cancelledReason: decision.diagnostics.cancelledReason }
      : {}),
    requestedFirstKeptEntryId: decision.diagnostics.requestedFirstKeptEntryId,
    ...(decision.diagnostics.alignedFirstKeptEntryId
      ? { alignedFirstKeptEntryId: decision.diagnostics.alignedFirstKeptEntryId }
      : {}),
    ...(decision.diagnostics.alignment
      ? { alignment: decision.diagnostics.alignment }
      : {}),
    projectedTaskIds: [...decision.diagnostics.projectedTaskIds],
    projectionRejections: decision.diagnostics.projectionRejections.map((rejection) => ({
      taskId: rejection.taskId,
      reasons: [...rejection.reasons],
    })),
    ...(details ? { summarizedMessageCount: details.summarizedMessageCount } : {}),
    tokensBefore: event.preparation.tokensBefore,
  };
  append(pi, record);
  return record;
}
