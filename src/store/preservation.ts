import { randomUUID } from "node:crypto";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PreservedOutput } from "../model/output.js";
import type { TaskId } from "../model/task.js";
import { SessionProtocolResolver, type ToolProtocolUnit } from "../transcript/protocol.js";
import { canonicalJson, hashToolCall, hashToolResult } from "../transcript/hash.js";
import type { LocalTaskRuntime, TaskEventAppender } from "./task-runtime.js";

const FRAMEWORK_CONTROL_TOOLS = new Set([
  "begin_task",
  "end_task",
  "list_tasks",
  "preserve_output",
  "read_preserved_output",
  "inspect_task",
  "respond_to_user",
  "spawn_task",
  "poll_task",
  "join_tasks",
  "cancel_task",
]);

export interface PreserveOutputRequest {
  tool_call_id: string;
  pin?: boolean;
}

export interface PreserveOutputResult {
  output_id: string;
  task_id: TaskId;
  tool_call_id: string;
  tool_name: string;
  pin: boolean;
  closure_entry_count: number;
  already_preserved: boolean;
}

export interface ReadPreservedOutputResult {
  output: PreservedOutput;
  content: Array<TextContent | ImageContent>;
}

interface PreparedOutput {
  output: PreservedOutput;
  existing: boolean;
}

type ReadonlySessionManager = ExtensionContext["sessionManager"];

function assertPersistedContent(unit: ToolProtocolUnit): void {
  if (!Array.isArray(unit.result.content)) {
    throw new Error(`tool result ${unit.toolCallId} has no persisted content array`);
  }
  for (const [index, block] of unit.result.content.entries()) {
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new Error(`tool result ${unit.toolCallId} text block ${index} is malformed`);
      }
    } else if (block.type === "image") {
      if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
        throw new Error(`tool result ${unit.toolCallId} image block ${index} is malformed`);
      }
    } else {
      throw new Error(`tool result ${unit.toolCallId} contains unsupported content block ${index}`);
    }
  }
}

function resultFor(output: PreservedOutput, alreadyPreserved: boolean): PreserveOutputResult {
  return {
    output_id: output.id,
    task_id: output.taskId,
    tool_call_id: output.source.toolCallId,
    tool_name: output.source.toolName,
    pin: output.pin,
    closure_entry_count: output.source.closure?.length ?? 0,
    already_preserved: alreadyPreserved,
  };
}

export class PreservationService {
  constructor(
    private readonly runtime: LocalTaskRuntime,
    private readonly createId: () => string = randomUUID,
  ) {}

  private resolver(sessionManager: ReadonlySessionManager): SessionProtocolResolver {
    return new SessionProtocolResolver(
      sessionManager.getSessionId(),
      sessionManager.getBranch(),
    );
  }

  private prepare(
    request: PreserveOutputRequest,
    markerToolCallId: string,
    expectedTaskId: TaskId | undefined,
    sessionManager: ReadonlySessionManager,
  ): PreparedOutput {
    const activeTask = this.runtime.activeTask();
    if (!activeTask) throw new Error("preserve_output requires an active task");
    if (expectedTaskId !== undefined && activeTask.id !== expectedTaskId) {
      throw new Error(`preservation target must be the active stack top (${activeTask.id})`);
    }
    if (activeTask.transcript.sessionId !== sessionManager.getSessionId()) {
      throw new Error(`active task ${activeTask.id} belongs to another session`);
    }

    const resolver = this.resolver(sessionManager);
    const marker = resolver.locateToolCall(markerToolCallId);
    const unit = resolver.resolveProtocolUnit(request.tool_call_id);
    if (FRAMEWORK_CONTROL_TOOLS.has(unit.toolName)) {
      throw new Error(`${unit.toolName} is a task-framework control tool and cannot be preserved`);
    }
    const beginPosition = resolver.resolveAnchor(activeTask.transcript.beginAnchor);
    if (unit.assistantEntryIndex < beginPosition || unit.resultEntryIndex >= marker.entryIndex) {
      throw new Error(
        `tool call ${unit.toolCallId} is outside active task ${activeTask.id} or is not complete before the preservation marker`,
      );
    }
    assertPersistedContent(unit);

    const existing = [...this.runtime.snapshot.outputs.values()].find(
      (candidate) =>
        candidate.taskId === activeTask.id &&
        candidate.source.sessionId === sessionManager.getSessionId() &&
        candidate.source.toolCallId === unit.toolCallId,
    );
    if (existing) {
      if (existing.pin !== (request.pin ?? false)) {
        throw new Error(
          `output ${existing.id} already preserves ${unit.toolCallId} with immutable pin=${existing.pin}`,
        );
      }
      this.validate(existing, resolver);
      return { output: existing, existing: true };
    }

    const pin = request.pin ?? false;
    const output: PreservedOutput = {
      id: this.createId(),
      taskId: activeTask.id,
      source: {
        sessionId: sessionManager.getSessionId(),
        toolCallId: unit.toolCallId,
        toolName: unit.toolName,
        assistantEntryId: unit.assistantEntryId,
        resultEntryId: unit.resultEntryId,
        callHash: hashToolCall(unit.toolCallBlock),
        resultHash: hashToolResult(unit.result),
        ...(pin ? { closure: resolver.computeMinimalProtocolClosure(unit.toolCallId) } : {}),
      },
      pin,
    };
    return { output, existing: false };
  }

  private commit(prepared: PreparedOutput, append: TaskEventAppender): PreserveOutputResult {
    if (!prepared.existing) this.runtime.preserve(prepared.output, append);
    return resultFor(prepared.output, prepared.existing);
  }

  preserve(
    request: PreserveOutputRequest,
    markerToolCallId: string,
    sessionManager: ReadonlySessionManager,
    append: TaskEventAppender,
  ): PreserveOutputResult {
    return this.commit(this.prepare(request, markerToolCallId, undefined, sessionManager), append);
  }

  preserveForEnd(
    taskId: TaskId,
    requests: readonly PreserveOutputRequest[],
    markerToolCallId: string,
    sessionManager: ReadonlySessionManager,
    append: TaskEventAppender,
  ): PreserveOutputResult[] {
    const seen = new Map<string, boolean>();
    for (const request of requests) {
      const pin = request.pin ?? false;
      const previous = seen.get(request.tool_call_id);
      if (previous !== undefined && previous !== pin) {
        throw new Error(`end_task.preserve_outputs changes immutable pin state for ${request.tool_call_id}`);
      }
      seen.set(request.tool_call_id, pin);
    }
    const prepared = [...seen].map(([tool_call_id, pin]) =>
      this.prepare({ tool_call_id, pin }, markerToolCallId, taskId, sessionManager),
    );
    return prepared.map((item) => this.commit(item, append));
  }

  private validate(output: PreservedOutput, resolver: SessionProtocolResolver): ToolProtocolUnit {
    const unit = resolver.resolveProtocolUnit(output.source.toolCallId);
    if (FRAMEWORK_CONTROL_TOOLS.has(unit.toolName)) {
      throw new Error(`preserved output ${output.id} references a task-framework control tool`);
    }
    if (
      unit.assistantEntryId !== output.source.assistantEntryId ||
      unit.resultEntryId !== output.source.resultEntryId ||
      unit.toolName !== output.source.toolName
    ) {
      throw new Error(`preserved output ${output.id} failed source provenance validation`);
    }
    if (
      hashToolCall(unit.toolCallBlock) !== output.source.callHash ||
      hashToolResult(unit.result) !== output.source.resultHash
    ) {
      throw new Error(`preserved output ${output.id} failed source integrity validation`);
    }
    assertPersistedContent(unit);
    if (output.pin) {
      if (!output.source.closure || output.source.closure.length === 0) {
        throw new Error(`pinned output ${output.id} has no protocol closure`);
      }
      const validation = resolver.validateClosure(output.source.closure);
      if (!validation.valid) {
        throw new Error(`pinned output ${output.id} has an invalid protocol closure: ${validation.reasons.join("; ")}`);
      }
      const expected = resolver.computeMinimalProtocolClosure(output.source.toolCallId);
      if (canonicalJson(output.source.closure) !== canonicalJson(expected)) {
        throw new Error(`pinned output ${output.id} protocol closure is incomplete or over-broad`);
      }
    } else if (output.source.closure !== undefined) {
      throw new Error(`unpinned output ${output.id} unexpectedly contains a protocol closure`);
    }
    return unit;
  }

  read(outputId: string, sessionManager: ReadonlySessionManager): ReadPreservedOutputResult {
    const output = this.runtime.snapshot.outputs.get(outputId);
    if (!output) throw new Error(`Preserved output not found on the active task tree: ${outputId}`);
    if (output.source.sessionId !== sessionManager.getSessionId()) {
      throw new Error(
        `Preserved output ${outputId} belongs to session ${output.source.sessionId}; read it through its owning task source`,
      );
    }
    const unit = this.validate(output, this.resolver(sessionManager));
    return { output, content: unit.result.content.map((block) => ({ ...block })) };
  }
}
