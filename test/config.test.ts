import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FLAGS,
  DEFAULT_CONFIG,
  normalizeConfig,
  resolveConfig,
} from "../src/config.js";

function flags(values: Record<string, boolean | string>) {
  return (name: string) => values[name];
}

describe("task framework config", () => {
  it("uses the full framework defaults", () => {
    expect(normalizeConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("loads snake_case file limits and applies CLI overrides last", () => {
    const cwd = mkdtempSync(join(tmpdir(), "task-framework-config-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "task-framework.json"),
      JSON.stringify({
        features: { tasks: true, summaries: true, compaction: false, agents: false },
        limits: { max_task_depth: 7, max_agent_depth: 3, max_concurrent_agents: 8 },
      }),
    );

    expect(
      resolveConfig({
        cwd,
        getFlag: flags({
          [CONFIG_FLAGS.summaries]: "false",
          [CONFIG_FLAGS.maxTaskDepth]: "2",
        }),
      }),
    ).toEqual({
      features: { tasks: true, summaries: false, compaction: false, agents: false },
      limits: { maxTaskDepth: 2, maxAgentDepth: 3, maxConcurrentAgents: 8 },
    });
  });

  it("rejects invalid dependency combinations", () => {
    expect(() =>
      normalizeConfig({
        features: { tasks: false, summaries: true, compaction: true, agents: false },
      }),
    ).toThrow("features.compaction requires");
    expect(() =>
      normalizeConfig({
        features: { tasks: false, summaries: false, compaction: false, agents: true },
      }),
    ).toThrow("features.agents requires");
  });

  it("rejects malformed and unknown values instead of silently coercing", () => {
    expect(() => normalizeConfig({ features: { tasks: "yes" } })).toThrow("must be true or false");
    expect(() => normalizeConfig({ limits: { max_task_depth: 0 } })).toThrow("positive integer");
    expect(() => normalizeConfig({ surprise: true })).toThrow("unknown key");
  });
});
