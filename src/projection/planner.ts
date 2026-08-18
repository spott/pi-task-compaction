import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PreservedOutput, ProtectedInteraction } from "../model/output.js";
import type { SemanticTaskStatus, TaskId } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";
import type { TranscriptRange } from "../transcript/anchors.js";

export interface ProjectionNode {
  taskId: TaskId;
  range: TranscriptRange;
  status: SemanticTaskStatus;
  children: ProjectionNode[];
  survivors: Survivor[];
  summary?: TaskSummary;
}

interface PositionedSurvivor {
  position: number;
  range: TranscriptRange;
}

export interface PinnedProtocolClosure extends PositionedSurvivor {
  kind: "pinned_protocol_closure";
  output: PreservedOutput;
}

export interface ProtectedInteractionSurvivor extends PositionedSurvivor {
  kind: "protected_interaction";
  interaction: ProtectedInteraction;
}

export type Survivor = PinnedProtocolClosure | ProtectedInteractionSurvivor;

export interface ProjectionRejection {
  taskId: TaskId;
  reasons: string[];
}

export interface ProjectionPlan {
  messages: AgentMessage[];
  projectedTaskIds: TaskId[];
  rejections: ProjectionRejection[];
}

export interface ProjectionPlanner {
  plan(messages: AgentMessage[], roots: ProjectionNode[]): ProjectionPlan;
}

export function chronologicalSurvivors(survivors: readonly Survivor[]): Survivor[] {
  return [...survivors].sort((left, right) => left.position - right.position);
}

/**
 * M1 contract implementation: no region is removed until the M3–M6 resolvers can
 * prove protocol correctness. Retaining the input is the required safe fallback.
 */
export class RetainingProjectionPlanner implements ProjectionPlanner {
  plan(messages: AgentMessage[], roots: ProjectionNode[]): ProjectionPlan {
    return {
      messages,
      projectedTaskIds: [],
      rejections: roots.map((root) => ({
        taskId: root.taskId,
        reasons: ["projection resolver not yet available; retained subtree"],
      })),
    };
  }
}
