import { createHash } from "node:crypto";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = normalize(value[key]);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(normalize(value));
  if (encoded === undefined) throw new Error("Value cannot be represented as canonical JSON");
  return encoded;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function hashToolCall(call: ToolCall): string {
  return hashJson(call);
}

export function hashToolResult(result: ToolResultMessage): string {
  return hashJson(result);
}

export function hashSessionEntry(entry: SessionEntry): string {
  if (entry.type === "message") return hashJson({ type: entry.type, message: entry.message });
  return hashJson(entry);
}
