import type { CompactionResult, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { ProjectionPlanner } from "../projection/planner.js";

export interface GlobalCompactionDecision {
  cancel?: boolean;
  compaction?: CompactionResult;
}

export interface TaskAwareGlobalCompactor {
  compact(
    event: SessionBeforeCompactEvent,
    planner: ProjectionPlanner,
  ): Promise<GlobalCompactionDecision | undefined>;
}
