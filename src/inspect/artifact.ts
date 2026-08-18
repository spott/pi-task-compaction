export interface TranscriptArtifact {
  path: string;
  taskId: string;
  sessionId: string;
  entryCount: number;
  sha256: string;
}

export interface TranscriptArtifactWriter {
  materialize(taskId: string): Promise<TranscriptArtifact>;
}
