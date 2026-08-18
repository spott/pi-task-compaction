import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskId } from "../model/task.js";
import type { ProjectionPlan } from "../projection/planner.js";
import type { LocalTaskRuntime } from "../store/task-runtime.js";
import {
  PrivateTranscriptArtifactWriter,
  locateTranscriptEntry,
  type MaterializeTranscriptOptions,
  type TranscriptArtifact,
  type TranscriptArtifactWriter,
} from "./artifact.js";
import { listTaskTranscript, searchTaskTranscript } from "./search.js";

export type InspectTaskView = "summary" | "list" | "search" | "entry" | "transcript";

export interface InspectTaskRequest {
  task_id: TaskId;
  view?: InspectTaskView;
  query?: string;
  entry?: string;
  cursor?: string;
  max_chars?: number;
}

export interface InspectTaskResult {
  text: string;
  details: Record<string, unknown>;
}

export interface ProjectionInspectionSource {
  lastPlan?: ProjectionPlan;
  rejectionCounts: ReadonlyMap<string, number>;
}

export interface TaskInspector {
  inspect(
    request: InspectTaskRequest,
    sessionManager: ExtensionContext["sessionManager"],
  ): Promise<InspectTaskResult>;
}

export interface LocalTaskInspectorOptions extends MaterializeTranscriptOptions {
  artifactWriter?: TranscriptArtifactWriter;
  projection?: ProjectionInspectionSource;
}

function assertAllowedFields(
  request: InspectTaskRequest,
  view: InspectTaskView,
  allowed: ReadonlySet<keyof InspectTaskRequest>,
): void {
  for (const key of ["query", "entry", "cursor", "max_chars"] as const) {
    if (request[key] !== undefined && !allowed.has(key)) {
      throw new Error(`${key} is not valid for inspect_task view: ${view}`);
    }
  }
}

function formatArtifact(taskId: string, artifact: TranscriptArtifact): string {
  return `Task ${taskId} transcript: ${artifact.path}\n${artifact.entries.toLocaleString("en-US")} entries, ${artifact.bytes.toLocaleString("en-US")} bytes, sha256 ${artifact.sha256}`;
}

function projectionSummary(taskId: TaskId, projection: ProjectionInspectionSource | undefined) {
  if (!projection) return undefined;
  const lastRejection = projection.lastPlan?.rejections.find((item) => item.taskId === taskId);
  let rejectionCount = 0;
  for (const [key, count] of projection.rejectionCounts) {
    if (key.startsWith(`${taskId}: `)) rejectionCount += count;
  }
  return {
    process_local: true,
    last_plan: projection.lastPlan
      ? {
          projected: projection.lastPlan.projectedTaskIds.includes(taskId),
          rejection_reasons: lastRejection?.reasons ?? [],
        }
      : null,
    cumulative_rejection_count: rejectionCount,
  };
}

export class LocalTaskInspector implements TaskInspector {
  private readonly artifactWriter: TranscriptArtifactWriter;

  constructor(
    private readonly runtime: LocalTaskRuntime,
    private readonly options: LocalTaskInspectorOptions = {},
  ) {
    this.artifactWriter =
      options.artifactWriter ??
      new PrivateTranscriptArtifactWriter(
        options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot },
      );
  }

  private summary(taskId: TaskId): InspectTaskResult {
    const task = this.runtime.snapshot.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const listItem = this.runtime.list({ root_task_id: taskId })[0]!;
    const preservedOutputs = task.preservedOutputs.flatMap((outputId) => {
      const output = this.runtime.snapshot.outputs.get(outputId);
      if (!output) return [];
      return [
        {
          output_id: output.id,
          task_id: output.taskId,
          pin: output.pin,
          tool_name: output.source.toolName,
          tool_call_id: output.source.toolCallId,
          assistant_entry_id: output.source.assistantEntryId,
          result_entry_id: output.source.resultEntryId,
          session_id: output.source.sessionId,
          call_sha256: output.source.callHash,
          result_sha256: output.source.resultHash,
          closure_entry_count: output.source.closure?.length ?? 0,
          closure_entries: output.source.closure?.map((entry) => ({
            entry_id: entry.entryId,
            sha256: entry.hash,
          })) ?? [],
        },
      ];
    });
    const protectedInteractions = [...this.runtime.snapshot.interactions.values()]
      .filter((interaction) => interaction.taskId === taskId)
      .map((interaction) => ({
        interaction_id: interaction.id,
        user_entry_ids: [...interaction.userEntryIds],
        assistant_entry_id: interaction.assistantEntryId,
        marker_tool_call_id: interaction.markerToolCallId,
        range: interaction.range,
      }));
    const details = {
      view: "summary",
      task_id: task.id,
      task: task.task,
      status: listItem.status,
      parent_task_id: task.parentId,
      direct_children: listItem.children.map((child) => ({
        task_id: child.taskId,
        task: child.task,
      })),
      summary: task.summary ?? null,
      summary_retained: task.summary !== undefined,
      created_at: task.createdAt,
      completed_at: task.completedAt ?? null,
      local_depth: listItem.localDepth,
      semantic_depth: listItem.semanticDepth,
      agent_depth: listItem.agentDepth,
      execution: task.execution,
      source: task.transcript,
      preserved_outputs: preservedOutputs,
      preserved_output_count: preservedOutputs.length,
      pinned_output_count: preservedOutputs.filter((output) => output.pin).length,
      protected_interactions: protectedInteractions,
      protected_interaction_count: protectedInteractions.length,
      projection: projectionSummary(taskId, this.options.projection),
      reconstruction_issue_count: this.runtime.snapshot.issues.length,
    };
    return {
      text: JSON.stringify(details, null, 2),
      details,
    };
  }

  async inspect(
    request: InspectTaskRequest,
    sessionManager: ExtensionContext["sessionManager"],
  ): Promise<InspectTaskResult> {
    const view = request.view ?? "summary";
    const task = this.runtime.snapshot.tasks.get(request.task_id);
    if (!task) throw new Error(`Unknown task: ${request.task_id}`);

    if (view === "summary") {
      assertAllowedFields(request, view, new Set());
      return this.summary(task.id);
    }

    if (task.transcript.sessionId !== sessionManager.getSessionId()) {
      throw new Error(
        `Task ${task.id} belongs to session ${task.transcript.sessionId}; worker inspection routing is not available yet`,
      );
    }
    const transcript = await this.artifactWriter.materialize(
      task,
      sessionManager.getSessionId(),
      sessionManager.getBranch(),
    );

    if (view === "transcript") {
      assertAllowedFields(request, view, new Set());
      return {
        text: formatArtifact(task.id, transcript.descriptor),
        details: { view, task_id: task.id, artifact: transcript.descriptor },
      };
    }
    if (view === "entry") {
      assertAllowedFields(request, view, new Set(["entry"]));
      if (!request.entry) throw new Error("entry is required for inspect_task view: entry");
      const locator = locateTranscriptEntry(transcript, request.entry);
      return {
        text: `Entry ${locator.entryId} is line ${locator.line.toLocaleString("en-US")} of ${locator.path}. Read that JSONL line for the exact persisted entry.`,
        details: { view, task_id: task.id, artifact: transcript.descriptor, locator },
      };
    }
    if (view === "list") {
      assertAllowedFields(request, view, new Set(["cursor", "max_chars"]));
      const result = listTaskTranscript(task.id, transcript, {
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.max_chars === undefined ? {} : { maxChars: request.max_chars }),
      });
      return {
        text: result.text,
        details: {
          view,
          task_id: task.id,
          artifact: transcript.descriptor,
          ...result.details,
        },
      };
    }
    if (view === "search") {
      assertAllowedFields(request, view, new Set(["query", "cursor", "max_chars"]));
      const result = searchTaskTranscript(task.id, transcript, {
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.max_chars === undefined ? {} : { maxChars: request.max_chars }),
      });
      return {
        text: result.text,
        details: {
          view,
          task_id: task.id,
          artifact: transcript.descriptor,
          ...result.details,
        },
      };
    }

    throw new Error(`Unsupported inspect_task view: ${String(view)}`);
  }
}
