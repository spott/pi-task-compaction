import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface WorkerProcessSpec {
  sessionFile: string;
  cwd: string;
  environment: Record<string, string>;
  args: string[];
}

export interface WorkerProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface WorkerProcessHandle {
  pid: number;
  wait(): Promise<WorkerProcessExit>;
  terminate(signal?: NodeJS.Signals): void;
}

export interface WorkerProcessLauncher {
  launch(spec: WorkerProcessSpec): Promise<WorkerProcessHandle>;
}

export interface WorkerPiInvocation {
  command: string;
  prefixArgs: string[];
}

/** Use the exact running Pi script where possible instead of a PATH wrapper that may inject extensions. */
export function resolveWorkerPiInvocation(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): WorkerPiInvocation {
  const currentScript = argv[1];
  const bunVirtual = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !bunVirtual && existsSync(currentScript)) {
    return { command: execPath, prefixArgs: [currentScript] };
  }

  const executable = basename(execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/u.test(executable)) {
    return { command: execPath, prefixArgs: [] };
  }
  return { command: "pi", prefixArgs: [] };
}

export interface NodeWorkerProcessLauncherOptions {
  invocation?: WorkerPiInvocation;
  stderrLimit?: number;
}

/** Production child-process launcher with bounded diagnostic capture. */
export class NodeWorkerProcessLauncher implements WorkerProcessLauncher {
  private readonly invocation: WorkerPiInvocation;
  private readonly stderrLimit: number;

  constructor(options: NodeWorkerProcessLauncherOptions = {}) {
    this.invocation = options.invocation ?? resolveWorkerPiInvocation();
    this.stderrLimit = options.stderrLimit ?? 32 * 1024;
  }

  async launch(spec: WorkerProcessSpec): Promise<WorkerProcessHandle> {
    const child = spawn(
      this.invocation.command,
      [...this.invocation.prefixArgs, ...spec.args],
      {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.environment },
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`;
      if (stderr.length > this.stderrLimit) stderr = stderr.slice(-this.stderrLimit);
    });

    const exitPromise = waitForExit(child, () => stderr);
    void exitPromise.catch(() => undefined);
    await waitForSpawn(child);
    const pid = child.pid;
    if (pid === undefined) throw new Error("Pi worker process started without a PID");

    return {
      pid,
      wait: () => exitPromise,
      terminate: (signal = "SIGTERM") => child.kill(signal),
    };
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForExit(child: ChildProcess, stderr: () => string): Promise<WorkerProcessExit> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ exitCode, signal, stderr: stderr() });
    };
    const cleanup = (): void => {
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}
