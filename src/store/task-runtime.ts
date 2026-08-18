import { randomUUID } from "node:crypto";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import type {
  TaskEvent,
  TaskCompleted,
  TaskCreated,
  TaskFailed,
  TaskCancelled,
  WorkerSpawnRequested,
} from "../model/events.js";
import type { PreservedOutput, ProtectedInteraction } from "../model/output.js";
import type { Task, TaskId, TaskListItem } from "../model/task.js";
import type { TaskSummary } from "../model/summary.js";
import type { TranscriptAnchor } from "../transcript/anchors.js";
import { applyPersistedAnchorResolutions } from "./anchor-resolutions.js";
import { applyPersistedInteractionResolutions } from "./interaction-resolutions.js";
import { readTaskEventLog, type TaskEventIssue, type TaskEventLog, type TaskEventStore } from "./task-events.js";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export interface TaskRuntimeState {
  tasks: Map<TaskId, Task>;
  roots: TaskId[];
  activeStack: TaskId[];
  startedTaskIds: Set<TaskId>;
  childDescriptions: Map<TaskId, string>;
  outputs: Map<string, PreservedOutput>;
  interactions: Map<string, ProtectedInteraction>;
  workerSpawns: Map<TaskId, WorkerSpawnRequested>;
  issues: TaskEventIssue[];
}

export interface TaskBoundaryContext {
  sessionId: string;
  assistantEntryId: string | null;
  toolCallId: string;
}

export interface BeginTaskResult {
  task_id: TaskId;
  parent_task_id: TaskId | null;
  depth: number;
}

export interface EndTaskResult {
  task_id: TaskId;
  status: "completed";
  restored_parent_task_id: TaskId | null;
  direct_children: Array<{ task_id: TaskId; task: string }>;
  unanswered_message_count: number;
}

export interface ListTasksQuery {
  root_task_id?: TaskId;
  status?: "open" | "completed" | "failed" | "cancelled" | "all";
}

export type TaskEventAppender = (event: TaskEvent) => string;

function emptyState(issues: TaskEventIssue[] = []): TaskRuntimeState {
  return {
    tasks: new Map(),
    roots: [],
    activeStack: [],
    startedTaskIds: new Set(),
    childDescriptions: new Map(),
    outputs: new Map(),
    interactions: new Map(),
    workerSpawns: new Map(),
    issues: [...issues],
  };
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function assertTaskId(value: unknown, label: string): asserts value is TaskId {
  if (!isUuid(value)) throw new Error(`${label} must be a full UUID`);
}

function assertAnchor(value: unknown, label: string): asserts value is TranscriptAnchor {
  if (typeof value !== "object" || value === null) throw new Error(`${label} must be an object`);
  const anchor = value as Partial<TranscriptAnchor>;
  if (typeof anchor.sessionId !== "string" || anchor.sessionId === "") {
    throw new Error(`${label}.sessionId must be non-empty`);
  }
  if (anchor.entryId !== null && typeof anchor.entryId !== "string") {
    throw new Error(`${label}.entryId must be a string or null`);
  }
  if (anchor.boundary !== "before" && anchor.boundary !== "after") {
    throw new Error(`${label}.boundary is invalid`);
  }
}

function assertSummary(value: unknown, label: string): asserts value is TaskSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const summary = value as Record<string, unknown>;
  for (const field of ["objective", "outcome"] as const) {
    if (typeof summary[field] !== "string") throw new Error(`${label}.${field} must be a string`);
  }
  for (const field of [
    "attempted",
    "learnings",
    "decisions",
    "files_read",
    "files_modified",
    "verification",
    "open_threads",
  ] as const) {
    if (!Array.isArray(summary[field]) || !summary[field].every((item) => typeof item === "string")) {
      throw new Error(`${label}.${field} must be an array of strings`);
    }
  }
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function currentTaskId(state: TaskRuntimeState): TaskId | null {
  return state.activeStack.at(-1) ?? null;
}

function invalidTransition(entryId: string, message: string): TaskEventIssue {
  return { entryId, code: "invalid_transition", message };
}

function invalidEvent(entryId: string, error: unknown): TaskEventIssue {
  return {
    entryId,
    code: "invalid_event",
    message: error instanceof Error ? error.message : String(error),
  };
}

function applyTaskCreated(state: TaskRuntimeState, event: TaskCreated, entryId: string): void {
  assertTaskId(event.taskId, "task_created.taskId");
  if (typeof event.task !== "string" || event.task.trim() === "") {
    throw new Error("task_created.task must be non-empty");
  }
  if (event.parentTaskId !== null) assertTaskId(event.parentTaskId, "task_created.parentTaskId");
  if (!Number.isSafeInteger(event.localDepth) || event.localDepth < 0) {
    throw new Error("task_created.localDepth must be a non-negative integer");
  }
  if (typeof event.execution !== "object" || event.execution === null) {
    throw new Error("task_created.execution must be an object");
  }
  if (event.execution.kind !== "local" && event.execution.kind !== "worker") {
    throw new Error("task_created.execution.kind is invalid");
  }
  if (
    typeof event.execution.processId !== "string" ||
    event.execution.processId === "" ||
    typeof event.execution.sessionId !== "string" ||
    event.execution.sessionId === ""
  ) {
    throw new Error("task_created.execution provenance is invalid");
  }
  if (
    event.execution.kind === "worker" &&
    (typeof event.execution.workerId !== "string" ||
      event.execution.workerId === "" ||
      !Number.isSafeInteger(event.execution.agentDepth) ||
      event.execution.agentDepth < 1)
  ) {
    throw new Error("task_created worker execution provenance is invalid");
  }
  if (typeof event.transcript !== "object" || event.transcript === null) {
    throw new Error("task_created.transcript must be an object");
  }
  if (event.transcript.sessionId !== event.execution.sessionId) {
    throw new Error("task_created transcript and execution session IDs differ");
  }
  assertAnchor(event.transcript.beginAnchor, "task_created.transcript.beginAnchor");
  if (event.transcript.beginAnchor.sessionId !== event.transcript.sessionId) {
    throw new Error("task_created begin anchor belongs to a different session");
  }

  if (state.tasks.has(event.taskId)) {
    state.issues.push(invalidTransition(entryId, `duplicate task_created for ${event.taskId}`));
    return;
  }

  const assignedWorkerRoot = event.execution.kind === "worker" && event.localDepth === 0;
  const activeParentId = currentTaskId(state);
  if (!assignedWorkerRoot) {
    if (event.localDepth < 1) {
      state.issues.push(invalidTransition(entryId, "local task depth must start at 1"));
      return;
    }
    if (event.parentTaskId !== activeParentId) {
      state.issues.push(
        invalidTransition(
          entryId,
          `task parent ${String(event.parentTaskId)} does not match active task ${String(activeParentId)}`,
        ),
      );
      return;
    }
    const expectedDepth = activeParentId === null ? 1 : (state.tasks.get(activeParentId)?.localDepth ?? 0) + 1;
    if (event.localDepth !== expectedDepth) {
      state.issues.push(
        invalidTransition(entryId, `task local depth ${event.localDepth} does not match expected ${expectedDepth}`),
      );
      return;
    }
  }

  const task: Task = {
    id: event.taskId,
    task: event.task,
    parentId: event.parentTaskId,
    localDepth: event.localDepth,
    status: "open",
    createdAt: event.at,
    children: [],
    preservedOutputs: [],
    execution: event.execution,
    transcript: event.transcript,
  };
  state.tasks.set(task.id, task);
  state.childDescriptions.set(task.id, task.task);
  if (task.parentId === null || !state.tasks.has(task.parentId)) {
    state.roots.push(task.id);
  } else {
    appendUnique(state.tasks.get(task.parentId)!.children, task.id);
  }
  state.activeStack.push(task.id);
}

function applyTerminalEvent(
  state: TaskRuntimeState,
  event: TaskCompleted | TaskFailed | TaskCancelled,
  entryId: string,
): void {
  assertTaskId(event.taskId, `${event.type}.taskId`);
  assertAnchor(event.endAnchor, `${event.type}.endAnchor`);
  const task = state.tasks.get(event.taskId);
  if (!task) {
    state.issues.push(invalidTransition(entryId, `${event.type} references unknown task ${event.taskId}`));
    return;
  }
  if (task.status !== "open") {
    state.issues.push(invalidTransition(entryId, `${event.type} references terminal task ${event.taskId}`));
    return;
  }
  if (currentTaskId(state) !== task.id) {
    state.issues.push(invalidTransition(entryId, `${event.type} must close the active stack top`));
    return;
  }
  if (event.endAnchor.sessionId !== task.transcript.sessionId) {
    throw new Error(`${event.type}.endAnchor belongs to a different session`);
  }

  if (event.type !== "task_cancelled" && event.summary !== undefined) {
    assertSummary(event.summary, `${event.type}.summary`);
  }
  task.status =
    event.type === "task_completed"
      ? "completed"
      : event.type === "task_failed"
        ? "failed"
        : "cancelled";
  task.completedAt = event.at;
  task.transcript.endAnchor = event.endAnchor;
  if (event.type !== "task_cancelled" && event.summary !== undefined) {
    task.summary = event.summary;
  }
  state.activeStack.pop();
}

function applyWorkerSpawn(state: TaskRuntimeState, event: WorkerSpawnRequested, entryId: string): void {
  assertTaskId(event.spawnedTaskId, "worker_spawn_requested.spawnedTaskId");
  if (event.parentTaskId !== null) assertTaskId(event.parentTaskId, "worker_spawn_requested.parentTaskId");
  if (typeof event.task !== "string" || event.task.trim() === "") {
    throw new Error("worker_spawn_requested.task must be non-empty");
  }
  if (event.parentTaskId !== currentTaskId(state)) {
    state.issues.push(invalidTransition(entryId, "worker spawn parent does not match the active task"));
    return;
  }
  if (state.workerSpawns.has(event.spawnedTaskId)) {
    state.issues.push(invalidTransition(entryId, `duplicate worker spawn for ${event.spawnedTaskId}`));
    return;
  }
  state.workerSpawns.set(event.spawnedTaskId, event);
  state.childDescriptions.set(event.spawnedTaskId, event.task);
  if (event.parentTaskId !== null) {
    const parent = state.tasks.get(event.parentTaskId);
    if (!parent) {
      state.issues.push(invalidTransition(entryId, "worker spawn references an unknown parent"));
      return;
    }
    appendUnique(parent.children, event.spawnedTaskId);
  } else {
    appendUnique(state.roots, event.spawnedTaskId);
  }
}

export function applyTaskEvent(
  state: TaskRuntimeState,
  event: TaskEvent,
  entryId: string,
): void {
  try {
    switch (event.type) {
      case "task_created":
        applyTaskCreated(state, event, entryId);
        return;
      case "task_started": {
        assertTaskId(event.taskId, "task_started.taskId");
        const task = state.tasks.get(event.taskId);
        if (!task) {
          state.issues.push(invalidTransition(entryId, `task_started references unknown task ${event.taskId}`));
        } else if (task.status !== "open") {
          state.issues.push(invalidTransition(entryId, `task_started references terminal task ${event.taskId}`));
        } else if (state.startedTaskIds.has(event.taskId)) {
          state.issues.push(invalidTransition(entryId, `duplicate task_started for ${event.taskId}`));
        } else {
          state.startedTaskIds.add(event.taskId);
        }
        return;
      }
      case "task_completed":
      case "task_failed":
      case "task_cancelled":
        applyTerminalEvent(state, event, entryId);
        return;
      case "output_preserved": {
        assertTaskId(event.taskId, "output_preserved.taskId");
        const task = state.tasks.get(event.taskId);
        const output = event.output;
        if (!task) {
          state.issues.push(invalidTransition(entryId, "output preservation references an unknown task"));
        } else if (task.status !== "open") {
          state.issues.push(invalidTransition(entryId, "output preservation references a terminal task"));
        } else if (
          output.taskId !== event.taskId ||
          typeof output.id !== "string" ||
          output.id === "" ||
          typeof output.pin !== "boolean" ||
          typeof output.source !== "object" ||
          output.source === null ||
          typeof output.source.sessionId !== "string" ||
          output.source.sessionId !== task.transcript.sessionId ||
          typeof output.source.toolCallId !== "string" ||
          typeof output.source.toolName !== "string" ||
          typeof output.source.assistantEntryId !== "string" ||
          typeof output.source.resultEntryId !== "string" ||
          typeof output.source.callHash !== "string" ||
          typeof output.source.resultHash !== "string" ||
          (output.pin && (!Array.isArray(output.source.closure) || output.source.closure.length === 0)) ||
          (!output.pin && output.source.closure !== undefined) ||
          (output.source.closure !== undefined &&
            !output.source.closure.every(
              (item) =>
                typeof item === "object" &&
                item !== null &&
                typeof item.entryId === "string" &&
                typeof item.hash === "string",
            ))
        ) {
          state.issues.push(invalidTransition(entryId, "output preservation provenance is inconsistent"));
        } else if (state.outputs.has(output.id)) {
          state.issues.push(invalidTransition(entryId, `duplicate preserved output ${output.id}`));
        } else if (
          [...state.outputs.values()].some(
            (candidate) =>
              candidate.taskId === output.taskId &&
              candidate.source.sessionId === output.source.sessionId &&
              candidate.source.toolCallId === output.source.toolCallId,
          )
        ) {
          state.issues.push(
            invalidTransition(entryId, `tool call ${output.source.toolCallId} was already preserved for this task`),
          );
        } else {
          state.outputs.set(output.id, output);
          appendUnique(task.preservedOutputs, output.id);
        }
        return;
      }
      case "user_response_protected": {
        assertTaskId(event.taskId, "user_response_protected.taskId");
        const task = state.tasks.get(event.taskId);
        const interaction = event.interaction;
        if (!task) {
          state.issues.push(invalidTransition(entryId, "protected response references an unknown task"));
        } else if (task.status !== "open" || currentTaskId(state) !== task.id) {
          state.issues.push(invalidTransition(entryId, "protected response must belong to the active stack top"));
        } else if (
          interaction.taskId !== event.taskId ||
          !isUuid(interaction.id) ||
          !Array.isArray(interaction.userEntryIds) ||
          interaction.userEntryIds.length === 0 ||
          !interaction.userEntryIds.every((id) => typeof id === "string" && id !== "") ||
          new Set(interaction.userEntryIds).size !== interaction.userEntryIds.length ||
          typeof interaction.assistantEntryId !== "string" ||
          interaction.assistantEntryId === "" ||
          typeof interaction.markerToolCallId !== "string" ||
          interaction.markerToolCallId === ""
        ) {
          state.issues.push(invalidTransition(entryId, "protected response provenance is inconsistent"));
        } else if (state.interactions.has(interaction.id)) {
          state.issues.push(invalidTransition(entryId, `duplicate protected interaction ${interaction.id}`));
        } else {
          assertAnchor(interaction.range.start, "user_response_protected.interaction.range.start");
          assertAnchor(interaction.range.end, "user_response_protected.interaction.range.end");
          if (
            interaction.range.start.sessionId !== task.transcript.sessionId ||
            interaction.range.end.sessionId !== task.transcript.sessionId
          ) {
            throw new Error("protected response range belongs to a different session");
          }
          state.interactions.set(interaction.id, interaction);
        }
        return;
      }
      case "worker_spawn_requested":
        applyWorkerSpawn(state, event, entryId);
        return;
    }
  } catch (error) {
    state.issues.push(invalidEvent(entryId, error));
  }
}

export function reconstructTaskState(log: TaskEventLog): TaskRuntimeState {
  const state = emptyState(log.issues);
  for (const record of log.records) {
    applyTaskEvent(state, record.envelope.event, record.entryId);
  }
  return state;
}

/** Reconstruct one owning session without requiring a live extension context. */
export function reconstructTaskStateFromEntries(entries: readonly SessionEntry[]): TaskRuntimeState {
  const state = reconstructTaskState(readTaskEventLog(entries));
  applyPersistedAnchorResolutions(state, entries);
  applyPersistedInteractionResolutions(state, entries);
  return state;
}

function makeToolAnchor(
  context: TaskBoundaryContext,
  toolName: "begin_task" | "end_task",
  boundary: "before" | "after",
): TranscriptAnchor {
  return {
    sessionId: context.sessionId,
    entryId: context.assistantEntryId,
    boundary,
    tool: {
      toolCallId: context.toolCallId,
      toolName,
      assistantEntryId: context.assistantEntryId,
    },
  };
}

export class LocalTaskRuntime {
  private state: TaskRuntimeState = emptyState();

  constructor(
    private readonly config: Config,
    private readonly processId: string = randomUUID(),
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {}

  get snapshot(): TaskRuntimeState {
    return this.state;
  }

  reconstruct(log: TaskEventLog): void {
    this.state = reconstructTaskState(log);
  }

  reconstructFrom(store: TaskEventStore, sessionManager: ReadonlySessionManager): void {
    this.reconstruct(store.read(sessionManager));
    const branch = sessionManager.getBranch();
    applyPersistedAnchorResolutions(this.state, branch);
    applyPersistedInteractionResolutions(this.state, branch);
  }

  private persist(event: TaskEvent, append: TaskEventAppender): void {
    const entryId = append(event);
    applyTaskEvent(this.state, event, entryId);
    const issue = this.state.issues.at(-1);
    if (issue?.entryId === entryId) {
      throw new Error(`Persisted invalid task event: ${issue.message}`);
    }
  }

  begin(taskText: string, context: TaskBoundaryContext, append: TaskEventAppender): BeginTaskResult {
    const task = taskText.trim();
    if (task === "") throw new Error("begin_task.task must be non-empty");
    const parentTaskId = currentTaskId(this.state);
    const depth = parentTaskId === null ? 1 : this.state.tasks.get(parentTaskId)!.localDepth + 1;
    if (depth > this.config.limits.maxTaskDepth) {
      throw new Error(
        `begin_task would exceed max_task_depth ${this.config.limits.maxTaskDepth}; close the active child first`,
      );
    }

    const taskId = this.createId();
    assertTaskId(taskId, "generated task ID");
    const at = this.now();
    const created: TaskCreated = {
      type: "task_created",
      at,
      taskId,
      task,
      parentTaskId,
      localDepth: depth,
      execution: { kind: "local", processId: this.processId, sessionId: context.sessionId },
      transcript: {
        sessionId: context.sessionId,
        beginAnchor: makeToolAnchor(context, "begin_task", "before"),
      },
    };
    this.persist(created, append);
    this.persist({ type: "task_started", at, taskId }, append);
    return { task_id: taskId, parent_task_id: parentTaskId, depth };
  }

  end(
    taskId: TaskId,
    summary: TaskSummary,
    retainSummary: boolean,
    context: TaskBoundaryContext,
    append: TaskEventAppender,
    unansweredMessageCount = 0,
  ): EndTaskResult {
    assertTaskId(taskId, "end_task.task_id");
    const activeTaskId = currentTaskId(this.state);
    if (activeTaskId === null) throw new Error("end_task requires an active task");
    if (taskId !== activeTaskId) {
      throw new Error(`end_task.task_id must be the active stack top (${activeTaskId})`);
    }
    const task = this.state.tasks.get(taskId)!;
    const directChildren = task.children.map((childId) => ({
      task_id: childId,
      task: this.state.childDescriptions.get(childId) ?? "(unresolved task)",
    }));
    const event: TaskCompleted = {
      type: "task_completed",
      at: this.now(),
      taskId,
      endAnchor: makeToolAnchor(context, "end_task", "after"),
      ...(retainSummary ? { summary } : {}),
    };
    this.persist(event, append);
    return {
      task_id: taskId,
      status: "completed",
      restored_parent_task_id: currentTaskId(this.state),
      direct_children: directChildren,
      unanswered_message_count: unansweredMessageCount,
    };
  }

  preserve(output: PreservedOutput, append: TaskEventAppender): void {
    const activeTask = this.activeTask();
    if (!activeTask || activeTask.id !== output.taskId) {
      throw new Error("preserved output must belong to the active stack top");
    }
    this.persist(
      { type: "output_preserved", at: this.now(), taskId: output.taskId, output },
      append,
    );
  }

  adoptAssignedRoot(taskId: TaskId, append: TaskEventAppender): void {
    assertTaskId(taskId, "worker bootstrap task ID");
    const task = this.state.tasks.get(taskId);
    if (!task || task.execution.kind !== "worker" || task.localDepth !== 0) {
      throw new Error(`Worker bootstrap cannot adopt assigned root ${taskId}`);
    }
    if (this.state.activeStack.length !== 1 || currentTaskId(this.state) !== taskId) {
      throw new Error(`Assigned worker root ${taskId} is not the sole active execution root`);
    }
    if (this.state.startedTaskIds.has(taskId)) return;
    this.persist({ type: "task_started", at: this.now(), taskId }, append);
  }

  recordWorkerSpawn(
    event: Omit<WorkerSpawnRequested, "type" | "at" | "parentTaskId">,
    append: TaskEventAppender,
  ): WorkerSpawnRequested {
    const spawn: WorkerSpawnRequested = {
      type: "worker_spawn_requested",
      at: this.now(),
      parentTaskId: currentTaskId(this.state),
      ...event,
    };
    this.persist(spawn, append);
    return spawn;
  }

  failOpenTasks(
    error: string,
    sessionId: string,
    currentLeafId: () => string | null,
    append: TaskEventAppender,
  ): TaskId[] {
    const failed: TaskId[] = [];
    while (this.activeTask()) {
      const task = this.activeTask()!;
      if (task.transcript.sessionId !== sessionId) {
        throw new Error(`Cannot fail task ${task.id} from non-owning session ${sessionId}`);
      }
      const event: TaskFailed = {
        type: "task_failed",
        at: this.now(),
        taskId: task.id,
        endAnchor: { sessionId, entryId: currentLeafId(), boundary: "after" },
        error,
      };
      this.persist(event, append);
      failed.push(task.id);
    }
    return failed;
  }

  protect(interaction: ProtectedInteraction, at: number, append: TaskEventAppender): void {
    const activeTask = this.activeTask();
    if (!activeTask || activeTask.id !== interaction.taskId) {
      throw new Error("protected interaction must belong to the active stack top");
    }
    this.persist(
      {
        type: "user_response_protected",
        at,
        taskId: interaction.taskId,
        interaction,
      },
      append,
    );
  }

  activeTask(): Task | undefined {
    const id = currentTaskId(this.state);
    return id === null ? undefined : this.state.tasks.get(id);
  }

  activeTasks(): Task[] {
    return this.state.activeStack.flatMap((id) => {
      const task = this.state.tasks.get(id);
      return task ? [task] : [];
    });
  }

  list(query: ListTasksQuery = {}): TaskListItem[] {
    const status = query.status ?? "all";
    let selectedIds: TaskId[];
    if (query.root_task_id !== undefined) {
      assertTaskId(query.root_task_id, "list_tasks.root_task_id");
      if (!this.state.tasks.has(query.root_task_id)) {
        throw new Error(`Unknown root task: ${query.root_task_id}`);
      }
      selectedIds = [];
      const visit = (id: TaskId): void => {
        const task = this.state.tasks.get(id);
        if (!task) return;
        selectedIds.push(id);
        for (const childId of task.children) visit(childId);
      };
      visit(query.root_task_id);
    } else {
      selectedIds = [...this.state.tasks.keys()];
    }

    const semanticDepth = (task: Task): number => {
      let depth = 1;
      let parentId = task.parentId;
      const seen = new Set<TaskId>([task.id]);
      while (parentId !== null) {
        if (seen.has(parentId)) break;
        seen.add(parentId);
        depth += 1;
        parentId = this.state.tasks.get(parentId)?.parentId ?? null;
      }
      return depth;
    };

    return selectedIds.flatMap((id) => {
      const task = this.state.tasks.get(id)!;
      if (status !== "all" && task.status !== status) return [];
      const children = task.children.map((childId) => ({
        taskId: childId,
        task: this.state.childDescriptions.get(childId) ?? "(unresolved task)",
      }));
      const pinnedOutputCount = task.preservedOutputs.reduce(
        (count, outputId) => count + (this.state.outputs.get(outputId)?.pin ? 1 : 0),
        0,
      );
      return [
        {
          id: task.id,
          parentId: task.parentId,
          task: task.task,
          status: task.status,
          localDepth: task.localDepth,
          semanticDepth: semanticDepth(task),
          agentDepth: task.execution.kind === "worker" ? task.execution.agentDepth : 0,
          children,
          preservedOutputCount: task.preservedOutputs.length,
          pinnedOutputCount,
          execution: task.execution,
        },
      ];
    });
  }
}
