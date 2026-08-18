export type TranscriptBoundary = "before" | "after";

/** A stable boundary in one Pi session tree. */
export interface TranscriptAnchor {
  sessionId: string;
  entryId: string | null;
  boundary: TranscriptBoundary;
  tool?: {
    toolCallId: string;
    toolName: string;
    assistantEntryId: string | null;
    resultEntryId?: string;
  };
}

export interface TranscriptRange {
  start: TranscriptAnchor;
  end: TranscriptAnchor;
}

export function compareTranscriptPositions(
  left: { position: number },
  right: { position: number },
): number {
  return left.position - right.position;
}
