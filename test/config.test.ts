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
        shutdown: { worker_drain_ms: 25, worker_term_grace_ms: 6_000, worker_kill_grace_ms: 3_000 },
      }),
    );

    expect(
      resolveConfig({
        cwd,
        getFlag: flags({
          [CONFIG_FLAGS.summaries]: "false",
          [CONFIG_FLAGS.maxTaskDepth]: "2",
          [CONFIG_FLAGS.workerShutdownDrainMs]: "0",
          [CONFIG_FLAGS.workerShutdownTermGraceMs]: "7000",
          [CONFIG_FLAGS.workerShutdownKillGraceMs]: "4000",
        }),
      }),
    ).toEqual({
      features: { tasks: true, summaries: false, compaction: false, agents: false },
      limits: { maxTaskDepth: 2, maxAgentDepth: 3, maxConcurrentAgents: 8 },
      shutdown: { workerDrainMs: 0, workerTermGraceMs: 7_000, workerKillGraceMs: 4_000 },
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

  it("validates shutdown file and CLI values without coercing invalid durations", () => {
    expect(normalizeConfig({
      shutdown: { worker_drain_ms: 0, worker_term_grace_ms: 1, worker_kill_grace_ms: 1 },
    }).shutdown).toEqual({ workerDrainMs: 0, workerTermGraceMs: 1, workerKillGraceMs: 1 });

    for (const value of [-1, 1.5, "", "later"] as const) {
      expect(() => resolveConfig({
        getFlag: flags({ [CONFIG_FLAGS.workerShutdownDrainMs]: String(value) }),
      })).toThrow("non-negative integer");
    }
    for (const flag of [CONFIG_FLAGS.workerShutdownTermGraceMs, CONFIG_FLAGS.workerShutdownKillGraceMs]) {
      for (const value of [0, -1, 1.5, "", "later"] as const) {
        expect(() => resolveConfig({ getFlag: flags({ [flag]: String(value) }) })).toThrow("positive integer");
      }
    }
    expect(() => normalizeConfig({ shutdown: { unexpected_ms: 1 } })).toThrow("shutdown contains unknown key");
  });
});
