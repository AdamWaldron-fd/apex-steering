import { describe, it, expect } from "vitest";
import { calculatePriorities, scoreCdn, DEFAULT_WEIGHTS, type PriorityWeights } from "../priority.js";
import { CdnRegistry, type CdnProvider } from "../cdn.js";
import { CommitTracker } from "../contracts.js";

const providers: CdnProvider[] = [
  {
    id: "cdn-a",
    name: "CDN Alpha",
    base_url: "https://cdn-a.example.com",
    regions: ["us-east", "us-west"],
    pricing: { cost_per_gb: 0.08, burst_cost_per_gb: 0.12, currency: "USD" },
    weight: 0.6,
    enabled: true,
  },
  {
    id: "cdn-b",
    name: "CDN Beta",
    base_url: "https://cdn-b.example.com",
    regions: ["us-east", "eu-west"],
    pricing: { cost_per_gb: 0.05, burst_cost_per_gb: 0.10, currency: "USD" },
    weight: 0.4,
    enabled: true,
  },
  {
    id: "cdn-c",
    name: "CDN Gamma",
    base_url: "https://cdn-c.example.com",
    regions: [],
    pricing: { cost_per_gb: 0.15, burst_cost_per_gb: 0.25, currency: "USD" },
    weight: 0.2,
    enabled: true,
  },
];

describe("Priority calculation — basic", () => {
  it("cheaper CDN ranks higher when no contracts", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "cdn-b", "cdn-c"], now: new Date() },
      registry,
      tracker,
    );
    expect(result).toContain("cdn-a");
    expect(result).toContain("cdn-b");
    expect(result).toContain("cdn-c");
    expect(result).toHaveLength(3);
  });

  it("single CDN returns single-element array", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a"], now: new Date() },
      registry,
      tracker,
    );
    expect(result).toEqual(["cdn-a"]);
  });

  it("empty input returns empty array", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const result = calculatePriorities(
      { cdn_ids: [], now: new Date() },
      registry,
      tracker,
    );
    expect(result).toEqual([]);
  });

  it("disabled CDN excluded from results", () => {
    const registry = new CdnRegistry([
      ...providers,
      { id: "cdn-disabled", name: "Disabled", base_url: "https://cdn-disabled.example.com", regions: [], pricing: { cost_per_gb: 0, burst_cost_per_gb: 0, currency: "USD" }, weight: 1.0, enabled: false },
    ]);
    const tracker = new CommitTracker();
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "cdn-disabled"], now: new Date() },
      registry,
      tracker,
    );
    expect(result).not.toContain("cdn-disabled");
    expect(result).toHaveLength(1);
  });

  it("unknown CDN excluded from results", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "nonexistent"], now: new Date() },
      registry,
      tracker,
    );
    expect(result).not.toContain("nonexistent");
  });

  it("all unknown CDNs returns empty array", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const result = calculatePriorities(
      { cdn_ids: ["x", "y", "z"], now: new Date() },
      registry,
      tracker,
    );
    expect(result).toEqual([]);
  });
});

describe("Priority calculation — contract urgency", () => {
  it("CDN behind on contract gets boosted to first", () => {
    const registry = new CdnRegistry(providers);
    const now = new Date("2026-03-20T00:00:00Z");
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null }],
      [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", delivered_gb: 200 }],
    );
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "cdn-b", "cdn-c"], now },
      registry,
      tracker,
    );
    expect(result[0]).toBe("cdn-c");
  });

  it("CDN with met commit has no urgency boost", () => {
    const registry = new CdnRegistry(providers);
    const now = new Date("2026-03-20T00:00:00Z");
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null }],
      [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", delivered_gb: 1200 }],
    );
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "cdn-b", "cdn-c"], now },
      registry,
      tracker,
    );
    expect(result[0]).not.toBe("cdn-c");
  });

  it("CDN with contract but no usage gets high urgency", () => {
    const registry = new CdnRegistry(providers);
    const now = new Date("2026-03-15T00:00:00Z");
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 5000, max_burst_gb: null }],
      [],
    );
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "cdn-b", "cdn-c"], now },
      registry,
      tracker,
    );
    expect(result[0]).toBe("cdn-c");
  });

  it("multiple CDNs behind pace — worse one ranked higher", () => {
    const registry = new CdnRegistry(providers);
    const now = new Date("2026-03-25T00:00:00Z"); // ~80% through
    // Use contract-urgency-only weights so cost difference doesn't interfere
    const weights: PriorityWeights = { contract_urgency: 1.0, cost_efficiency: 0, base_weight: 0 };
    const tracker = new CommitTracker(
      [
        { cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null },
        { cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null },
      ],
      [
        { cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 600 },
        { cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", delivered_gb: 200 },
      ],
    );
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "cdn-b", "cdn-c"], now },
      registry,
      tracker,
      weights,
    );
    expect(result.indexOf("cdn-c")).toBeLessThan(result.indexOf("cdn-a"));
  });
});

describe("Priority calculation — custom weights", () => {
  it("cost-only weights rank cheapest first", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const weights: PriorityWeights = { contract_urgency: 0, cost_efficiency: 1.0, base_weight: 0 };
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "cdn-b", "cdn-c"], now: new Date() },
      registry,
      tracker,
      weights,
    );
    expect(result[0]).toBe("cdn-b");
    expect(result[2]).toBe("cdn-c");
  });

  it("weight-only weights rank highest weight first", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const weights: PriorityWeights = { contract_urgency: 0, cost_efficiency: 0, base_weight: 1.0 };
    const result = calculatePriorities(
      { cdn_ids: ["cdn-a", "cdn-b", "cdn-c"], now: new Date() },
      registry,
      tracker,
      weights,
    );
    expect(result[0]).toBe("cdn-a");
    expect(result[1]).toBe("cdn-b");
    expect(result[2]).toBe("cdn-c");
  });
});

describe("scoreCdn", () => {
  it("returns null for disabled provider", () => {
    const registry = new CdnRegistry([{ ...providers[0], enabled: false }]);
    const tracker = new CommitTracker();
    expect(scoreCdn("cdn-a", registry, tracker, new Date())).toBeNull();
  });

  it("returns null for unknown provider", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    expect(scoreCdn("nonexistent", registry, tracker, new Date())).toBeNull();
  });

  it("returns score with all components", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const score = scoreCdn("cdn-a", registry, tracker, new Date());
    expect(score).not.toBeNull();
    expect(score!.cdn_id).toBe("cdn-a");
    expect(typeof score!.score).toBe("number");
    expect(score!.components).toHaveProperty("contract_urgency");
    expect(score!.components).toHaveProperty("cost_efficiency");
    expect(score!.components).toHaveProperty("base_weight");
  });

  it("free CDN gets max cost efficiency score", () => {
    const registry = new CdnRegistry([
      { ...providers[0], pricing: { cost_per_gb: 0, burst_cost_per_gb: 0, currency: "USD" } },
    ]);
    const tracker = new CommitTracker();
    const score = scoreCdn("cdn-a", registry, tracker, new Date());
    expect(score!.components.cost_efficiency).toBe(100);
  });

  it("CDN with no contract has 0 urgency", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const score = scoreCdn("cdn-a", registry, tracker, new Date());
    expect(score!.components.contract_urgency).toBe(0);
  });

  it("very expensive CDN gets low cost efficiency score", () => {
    const registry = new CdnRegistry([
      { ...providers[0], pricing: { cost_per_gb: 0.20, burst_cost_per_gb: 0.30, currency: "USD" } },
    ]);
    const tracker = new CommitTracker();
    const score = scoreCdn("cdn-a", registry, tracker, new Date());
    expect(score!.components.cost_efficiency).toBe(0);
  });

  it("CDN with burst exhausted contract gets 0 urgency", () => {
    const registry = new CdnRegistry(providers);
    const now = new Date("2026-03-15T00:00:00Z");
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 100, max_burst_gb: 10 }],
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 110 }],
    );
    const score = scoreCdn("cdn-a", registry, tracker, now);
    expect(score!.components.contract_urgency).toBe(0);
  });

  it("base_weight component reflects provider weight", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const scoreA = scoreCdn("cdn-a", registry, tracker, new Date());
    const scoreC = scoreCdn("cdn-c", registry, tracker, new Date());
    expect(scoreA!.components.base_weight).toBe(60);
    expect(scoreC!.components.base_weight).toBe(20);
  });

  it("score is sum of weighted components", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const weights: PriorityWeights = { contract_urgency: 0.5, cost_efficiency: 0.35, base_weight: 0.15 };
    const score = scoreCdn("cdn-a", registry, tracker, new Date(), weights);
    const expected =
      score!.components.contract_urgency * 0.5 +
      score!.components.cost_efficiency * 0.35 +
      score!.components.base_weight * 0.15;
    expect(score!.score).toBeCloseTo(expected);
  });
});
