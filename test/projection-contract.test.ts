import { describe, expect, it } from "vitest";
import {
  assertProjectionFixtureCorpus,
  PROJECTION_FIXTURE_CORPUS,
} from "../src/projection/fixtures.js";
import { chronologicalSurvivors, RetainingProjectionPlanner } from "../src/projection/planner.js";

describe("M1 projection contract", () => {
  it("defines every required safety fixture with a unique invariant", () => {
    expect(() => assertProjectionFixtureCorpus()).not.toThrow();
    expect(PROJECTION_FIXTURE_CORPUS).toHaveLength(27);
    expect(PROJECTION_FIXTURE_CORPUS.map((fixture) => fixture.name)).toEqual(
      expect.arrayContaining([
        "interleaved pin protection pin",
        "multi-call assistant selected pin",
        "two-level replay cascade",
        "unknown framework event",
        "provider switch within session",
      ]),
    );
  });

  it("orders all survivor types by transcript position rather than grouping by kind", () => {
    const survivors = [
      { kind: "pinned_protocol_closure" as const, position: 30 },
      { kind: "protected_interaction" as const, position: 20 },
      { kind: "pinned_protocol_closure" as const, position: 10 },
    ] as any;
    expect(chronologicalSurvivors(survivors).map((survivor) => survivor.position)).toEqual([
      10, 20, 30,
    ]);
  });

  it("retains ambiguous regions until protocol resolvers can prove safe projection", () => {
    const messages = [{ role: "user", content: "keep me", timestamp: 1 }] as any;
    const result = new RetainingProjectionPlanner().plan(messages, []);
    expect(result.messages).toBe(messages);
    expect(result.projectedTaskIds).toEqual([]);
  });
});
