export interface WorkerProcessSpec {
  sessionFile: string;
  cwd: string;
  environment: Record<string, string>;
  args: string[];
}

export interface WorkerProcessHandle {
  pid: number;
  wait(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  terminate(signal?: NodeJS.Signals): void;
}

export interface WorkerProcessLauncher {
  launch(spec: WorkerProcessSpec): Promise<WorkerProcessHandle>;
}
