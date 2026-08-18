export interface InspectEntryMetadata {
  entry: string;
  type: string;
  chars: number;
  preview: string;
}

export interface InspectSearchMatch extends InspectEntryMetadata {
  excerpts: string[];
}

export interface BoundedInspectPage<T> {
  items: T[];
  nextCursor?: string;
  truncated: boolean;
}
