import { convertToLlm, serializeConversation, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { IndexedTask } from "./types.js";

export interface ExpandOptions {
  maxChars: number;
  includeEntryIds: boolean;
  includeToolOutput: boolean;
  toolNames?: string[] | undefined;
  sessionFile?: string | undefined;
}

export interface ExpandedTranscript {
  text: string;
  truncated: boolean;
  returnedChars: number;
}

export function expandTaskTranscript(
  branch: SessionEntry[],
  task: IndexedTask,
  options: ExpandOptions,
): ExpandedTranscript {
  if (task.beginEntryIndex === undefined || task.endEntryIndex === undefined) {
    throw new Error(`Task ${task.taskId} does not have recoverable raw boundaries on this branch`);
  }
  const selectedTools = options.toolNames?.length ? new Set(options.toolNames) : undefined;
  const chunks: string[] = [];

  for (let index = task.beginEntryIndex; index <= task.endEntryIndex; index++) {
    const entry = branch[index]!;
    if (entry.type === "compaction") continue;
    const messages = sessionEntryToContextMessages(entry);
    for (const message of messages) {
      if (message.role === "toolResult") {
        if (selectedTools && !selectedTools.has(message.toolName)) continue;
        if (!options.includeToolOutput) {
          chunks.push(`${options.includeEntryIds ? `[Entry ${entry.id}] ` : ""}[Tool result ${message.toolName} omitted]`);
          continue;
        }
      }
      const serialized = serializeConversation(convertToLlm([message]));
      if (serialized) chunks.push(`${options.includeEntryIds ? `[Entry ${entry.id}]\n` : ""}${serialized}`);
    }
  }

  const header = `<expanded-task id="${task.taskId}">\n`;
  const footer = `\n</expanded-task>`;
  const source = options.sessionFile
    ? `\n\nComplete raw session: ${options.sessionFile}`
    : "\n\nThe complete transcript is available in the current pi session file.";
  const full = `${header}${chunks.join("\n\n")}${footer}${source}`;
  if (full.length <= options.maxChars) {
    return { text: full, truncated: false, returnedChars: full.length };
  }

  const notice = `\n\n[Expansion truncated at ${options.maxChars.toLocaleString()} characters.]${source}`;
  const keep = Math.max(0, options.maxChars - notice.length);
  const text = `${full.slice(0, keep)}${notice}`;
  return { text, truncated: true, returnedChars: text.length };
}
