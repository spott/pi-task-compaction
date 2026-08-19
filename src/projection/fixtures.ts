export type ProjectionFixtureCapability =
  | "hierarchy"
  | "depth"
  | "workers"
  | "siblings"
  | "ambiguity"
  | "pinning"
  | "protection"
  | "replay"
  | "ablation"
  | "retries"
  | "compatibility";

export interface ProjectionFixtureContract {
  name: string;
  capabilities: readonly ProjectionFixtureCapability[];
  expectedInvariant: string;
}

/**
 * The stable M1 corpus. Later milestones add concrete provider messages and
 * expected projections under these names rather than inventing a second suite.
 */
export const PROJECTION_FIXTURE_CORPUS: readonly ProjectionFixtureContract[] = [
  { name: "one root task", capabilities: ["hierarchy"], expectedInvariant: "a completed root projects once" },
  { name: "child closed while parent open", capabilities: ["hierarchy"], expectedInvariant: "only the child projects" },
  { name: "parent closed with one child", capabilities: ["hierarchy"], expectedInvariant: "parent summary subsumes child summary" },
  { name: "parent closed with multiple children", capabilities: ["hierarchy", "siblings"], expectedInvariant: "parent projects all child regions" },
  { name: "local depth-3 chain", capabilities: ["depth"], expectedInvariant: "local depth at configured limit is valid" },
  { name: "local depth-limit violation", capabilities: ["depth"], expectedInvariant: "begin above local limit hard-errors" },
  { name: "worker global ancestry exceeds local limit", capabilities: ["depth", "workers"], expectedInvariant: "fresh worker local budget remains valid" },
  { name: "root-level spawn", capabilities: ["workers"], expectedInvariant: "spawn without active task creates a semantic root" },
  { name: "adjacent sibling tasks", capabilities: ["siblings"], expectedInvariant: "both siblings project independently" },
  { name: "malformed child and valid sibling", capabilities: ["ambiguity", "siblings"], expectedInvariant: "malformed child is retained without blocking sibling" },
  { name: "pin mid-region", capabilities: ["pinning"], expectedInvariant: "pin precedes task summary" },
  { name: "interleaved pin protection pin", capabilities: ["pinning", "protection"], expectedInvariant: "all survivors remain in transcript order before summary" },
  { name: "multi-call assistant selected pin", capabilities: ["pinning", "compatibility"], expectedInvariant: "minimal valid original closure is retained without fabrication" },
  { name: "marked user response", capabilities: ["protection"], expectedInvariant: "user and assistant response survive verbatim" },
  { name: "multiple user turns one marker", capabilities: ["protection", "ambiguity"], expectedInvariant: "API-unsettled multi-message binding hard-errors without losing inputs" },
  { name: "unanswered user message", capabilities: ["replay"], expectedInvariant: "removed original is replayed after summary" },
  { name: "multiple unanswered messages", capabilities: ["replay"], expectedInvariant: "replays preserve original order" },
  { name: "child replay into parent", capabilities: ["hierarchy", "replay"], expectedInvariant: "replay becomes parent-visible input" },
  { name: "two-level replay cascade", capabilities: ["hierarchy", "replay"], expectedInvariant: "unanswered replay can replay again after parent closes" },
  { name: "replay suppressed for retained ambiguity", capabilities: ["ambiguity", "replay"], expectedInvariant: "visible original is not duplicated" },
  { name: "compaction-off no replay", capabilities: ["ablation", "replay"], expectedInvariant: "visible original is not duplicated" },
  { name: "protected interaction inside child", capabilities: ["hierarchy", "protection"], expectedInvariant: "interaction survives child and ancestor closure" },
  { name: "child then parent closure", capabilities: ["hierarchy"], expectedInvariant: "ancestor projection removes inserted child summary" },
  { name: "summaries-disabled closure", capabilities: ["ablation"], expectedInvariant: "authored summary is absent on next model turn" },
  { name: "unknown framework event", capabilities: ["ambiguity", "compatibility"], expectedInvariant: "unknown version is retained and not compacted" },
  { name: "adjacent branch and compaction summaries", capabilities: ["compatibility"], expectedInvariant: "framework range does not consume Pi summaries" },
  { name: "retry error persisted but absent from live context", capabilities: ["retries", "ambiguity", "compatibility"], expectedInvariant: "recognized retry history may be absent without weakening protocol validation" },
  { name: "provider switch within session", capabilities: ["compatibility"], expectedInvariant: "projected protocol serializes for the active provider" },
] as const;

export function assertProjectionFixtureCorpus(corpus = PROJECTION_FIXTURE_CORPUS): void {
  const names = new Set<string>();
  for (const fixture of corpus) {
    if (names.has(fixture.name)) throw new Error(`Duplicate projection fixture: ${fixture.name}`);
    names.add(fixture.name);
    if (fixture.expectedInvariant.trim() === "") {
      throw new Error(`Projection fixture has no invariant: ${fixture.name}`);
    }
  }
}
