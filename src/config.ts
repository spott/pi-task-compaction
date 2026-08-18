import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Config {
  features: {
    tasks: boolean;
    summaries: boolean;
    compaction: boolean;
    agents: boolean;
  };
  limits: {
    maxTaskDepth: number;
    maxAgentDepth: number;
    maxConcurrentAgents: number;
  };
}

export interface ConfigFile {
  features?: Partial<Config["features"]>;
  limits?: {
    max_task_depth?: number;
    max_agent_depth?: number;
    max_concurrent_agents?: number;
  };
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  features: Object.freeze({
    tasks: true,
    summaries: true,
    compaction: true,
    agents: true,
  }),
  limits: Object.freeze({
    maxTaskDepth: 3,
    maxAgentDepth: 2,
    maxConcurrentAgents: 4,
  }),
});

export const CONFIG_FLAGS = {
  path: "task-framework-config",
  tasks: "task-framework-tasks",
  summaries: "task-framework-summaries",
  compaction: "task-framework-compaction",
  agents: "task-framework-agents",
  maxTaskDepth: "task-framework-max-task-depth",
  maxAgentDepth: "task-framework-max-agent-depth",
  maxConcurrentAgents: "task-framework-max-concurrent-agents",
} as const;

export type ConfigFlagReader = (name: string) => boolean | string | undefined;

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown key(s): ${unknown.join(", ")}`);
  }
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  throw new Error(`${label} must be true or false`);
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function normalizeConfig(input: unknown = {}): Config {
  assertPlainObject(input, "task framework config");
  assertKnownKeys(input, ["features", "limits"], "task framework config");

  const config: Config = {
    features: { ...DEFAULT_CONFIG.features },
    limits: { ...DEFAULT_CONFIG.limits },
  };

  if (input.features !== undefined) {
    assertPlainObject(input.features, "features");
    assertKnownKeys(input.features, ["tasks", "summaries", "compaction", "agents"], "features");
    for (const key of ["tasks", "summaries", "compaction", "agents"] as const) {
      if (input.features[key] !== undefined) {
        config.features[key] = parseBoolean(input.features[key], `features.${key}`);
      }
    }
  }

  if (input.limits !== undefined) {
    assertPlainObject(input.limits, "limits");
    assertKnownKeys(
      input.limits,
      ["max_task_depth", "max_agent_depth", "max_concurrent_agents"],
      "limits",
    );
    if (input.limits.max_task_depth !== undefined) {
      config.limits.maxTaskDepth = parsePositiveInteger(input.limits.max_task_depth, "limits.max_task_depth");
    }
    if (input.limits.max_agent_depth !== undefined) {
      config.limits.maxAgentDepth = parsePositiveInteger(input.limits.max_agent_depth, "limits.max_agent_depth");
    }
    if (input.limits.max_concurrent_agents !== undefined) {
      config.limits.maxConcurrentAgents = parsePositiveInteger(
        input.limits.max_concurrent_agents,
        "limits.max_concurrent_agents",
      );
    }
  }

  validateConfig(config);
  return config;
}

export function validateConfig(config: Config): void {
  if (config.features.compaction && (!config.features.tasks || !config.features.summaries)) {
    throw new Error("features.compaction requires features.tasks and features.summaries");
  }
  if (config.features.agents && !config.features.tasks) {
    throw new Error("features.agents requires features.tasks");
  }
  parsePositiveInteger(config.limits.maxTaskDepth, "limits.maxTaskDepth");
  parsePositiveInteger(config.limits.maxAgentDepth, "limits.maxAgentDepth");
  parsePositiveInteger(config.limits.maxConcurrentAgents, "limits.maxConcurrentAgents");
}

function loadConfigFile(path: string, explicit: boolean): unknown {
  if (!existsSync(path)) {
    if (explicit) throw new Error(`Task framework config file not found: ${path}`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse task framework config ${path}: ${message}`);
  }
  return parsed;
}

export interface ResolveConfigOptions {
  cwd?: string;
  getFlag?: ConfigFlagReader;
}

export function resolveConfig(options: ResolveConfigOptions = {}): Config {
  const cwd = options.cwd ?? process.cwd();
  const getFlag = options.getFlag ?? (() => undefined);
  const configuredPath = getFlag(CONFIG_FLAGS.path);
  if (configuredPath !== undefined && typeof configuredPath !== "string") {
    throw new Error(`--${CONFIG_FLAGS.path} must be a path`);
  }
  const explicitPath = configuredPath !== undefined;
  const path = configuredPath
    ? isAbsolute(configuredPath)
      ? configuredPath
      : resolve(cwd, configuredPath)
    : resolve(cwd, ".pi", "task-framework.json");
  const config = normalizeConfig(loadConfigFile(path, explicitPath));

  const featureFlags = [
    [CONFIG_FLAGS.tasks, "tasks"],
    [CONFIG_FLAGS.summaries, "summaries"],
    [CONFIG_FLAGS.compaction, "compaction"],
    [CONFIG_FLAGS.agents, "agents"],
  ] as const;
  for (const [flag, key] of featureFlags) {
    const value = getFlag(flag);
    if (value !== undefined) config.features[key] = parseBoolean(value, `--${flag}`);
  }

  const limitFlags = [
    [CONFIG_FLAGS.maxTaskDepth, "maxTaskDepth"],
    [CONFIG_FLAGS.maxAgentDepth, "maxAgentDepth"],
    [CONFIG_FLAGS.maxConcurrentAgents, "maxConcurrentAgents"],
  ] as const;
  for (const [flag, key] of limitFlags) {
    const value = getFlag(flag);
    if (value !== undefined) config.limits[key] = parsePositiveInteger(value, `--${flag}`);
  }

  validateConfig(config);
  return config;
}

export function registerConfigFlags(pi: Pick<ExtensionAPI, "registerFlag">): void {
  pi.registerFlag(CONFIG_FLAGS.path, {
    type: "string",
    description: "Path to a task-framework JSON config file (default: .pi/task-framework.json)",
  });
  for (const [name, feature] of [
    [CONFIG_FLAGS.tasks, "tasks"],
    [CONFIG_FLAGS.summaries, "summary retention"],
    [CONFIG_FLAGS.compaction, "task-aware compaction"],
    [CONFIG_FLAGS.agents, "worker agents"],
  ] as const) {
    pi.registerFlag(name, {
      type: "string",
      description: `Override ${feature}: true or false`,
    });
  }
  for (const [name, limit] of [
    [CONFIG_FLAGS.maxTaskDepth, "local task depth"],
    [CONFIG_FLAGS.maxAgentDepth, "agent spawn depth"],
    [CONFIG_FLAGS.maxConcurrentAgents, "concurrent agents"],
  ] as const) {
    pi.registerFlag(name, {
      type: "string",
      description: `Override maximum ${limit} with a positive integer`,
    });
  }
}
