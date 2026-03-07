import { describe, it, expect } from "vitest";
import { estimateCosts, cheapestFirst } from "../cogs.js";
import { CdnRegistry, type CdnProvider } from "../cdn.js";
import { CommitTracker } from "../contracts.js";

const providers: CdnProvider[] = [
  {
    id: "cdn-a",
    name: "CDN Alpha",
    base_url: "https://cdn-a.example.com",
    regions: [],
    pricing: { cost_per_gb: 0.08, burst_cost_per_gb: 0.12, currency: "USD" },
    weight: 0.6,
    enabled: true,
  },
  {
    id: "cdn-b",
    name: "CDN Beta",
    base_url: "https://cdn-b.example.com",
    regions: [],
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

const now = new Date("2026-03-15T00:00:00Z");

describe("COGS estimateCosts", () => {
  it("returns base pricing when no contracts", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const estimates = estimateCosts(["cdn-a", "cdn-b"], registry, tracker, now);
    expect(estimates).toHaveLength(2);
    const a = estimates.find((e) => e.cdn_id === "cdn-a")!;
    expect(a.effective_cost_per_gb).toBeCloseTo(0.08);
    expect(a.within_commit).toBe(false);
    expect(a.burst_exhausted).toBe(false);
  });

  it("within-commit CDN gets discounted rate", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null }],
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 500 }],
    );
    const estimates = estimateCosts(["cdn-a"], registry, tracker, now);
    const a = estimates[0];
    expect(a.within_commit).toBe(true);
    expect(a.effective_cost_per_gb).toBeCloseTo(0.04); // 0.08 * 0.5
  });

  it("above-commit CDN uses burst pricing", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: 500 }],
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 1200 }],
    );
    const estimates = estimateCosts(["cdn-a"], registry, tracker, now);
    const a = estimates[0];
    expect(a.within_commit).toBe(false);
    expect(a.burst_exhausted).toBe(false);
    expect(a.effective_cost_per_gb).toBeCloseTo(0.12);
  });

  it("burst-exhausted CDN gets infinite cost", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: 100 }],
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 1100 }],
    );
    const estimates = estimateCosts(["cdn-a"], registry, tracker, now);
    const a = estimates[0];
    expect(a.burst_exhausted).toBe(true);
    expect(a.effective_cost_per_gb).toBe(Infinity);
  });

  it("contract with no usage yet marks within_commit", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null }],
      [],
    );
    const estimates = estimateCosts(["cdn-a"], registry, tracker, now);
    const a = estimates[0];
    // No usage = not commit met, so within_commit should be true
    expect(a.within_commit).toBe(true);
  });

  it("disabled CDN excluded from estimates", () => {
    const registry = new CdnRegistry([{ ...providers[0], enabled: false }]);
    const tracker = new CommitTracker();
    const estimates = estimateCosts(["cdn-a"], registry, tracker, now);
    expect(estimates).toHaveLength(0);
  });

  it("unknown CDN excluded from estimates", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const estimates = estimateCosts(["nonexistent"], registry, tracker, now);
    expect(estimates).toHaveLength(0);
  });
});

describe("COGS cheapestFirst", () => {
  it("sorts by effective cost ascending", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const result = cheapestFirst(["cdn-a", "cdn-b", "cdn-c"], registry, tracker, now);
    // cdn-b ($0.05) < cdn-a ($0.08) < cdn-c ($0.15)
    expect(result).toEqual(["cdn-b", "cdn-a", "cdn-c"]);
  });

  it("burst-exhausted CDN excluded from cheapest", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-b", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 100, max_burst_gb: 10 }],
      [{ cdn_id: "cdn-b", period_start: "2026-03-01T00:00:00Z", delivered_gb: 110 }],
    );
    const result = cheapestFirst(["cdn-a", "cdn-b", "cdn-c"], registry, tracker, now);
    expect(result).not.toContain("cdn-b");
  });

  it("within-commit CDN ranked cheapest", () => {
    const registry = new CdnRegistry(providers);
    // cdn-c is most expensive but within commit = discounted to 0.075
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null }],
      [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", delivered_gb: 500 }],
    );
    const result = cheapestFirst(["cdn-a", "cdn-b", "cdn-c"], registry, tracker, now);
    // cdn-b=0.05, cdn-c=0.075 (0.15*0.5), cdn-a=0.08
    expect(result[0]).toBe("cdn-b");
    expect(result[1]).toBe("cdn-c"); // within-commit discount
    expect(result[2]).toBe("cdn-a");
  });

  it("empty input returns empty", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    expect(cheapestFirst([], registry, tracker, now)).toEqual([]);
  });

  it("single CDN returns single-element array", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    expect(cheapestFirst(["cdn-a"], registry, tracker, now)).toEqual(["cdn-a"]);
  });

  it("null max_burst_gb means unlimited burst — never exhausted", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 100, max_burst_gb: null }],
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 999999 }],
    );
    const estimates = estimateCosts(["cdn-a"], registry, tracker, now);
    const a = estimates[0];
    expect(a.burst_exhausted).toBe(false);
    expect(a.effective_cost_per_gb).toBeCloseTo(0.12);
  });

  it("mixed contract states: within commit, burst pricing, no contract", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker(
      [
        { cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: 100 },
        { cdn_id: "cdn-b", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 500, max_burst_gb: null },
      ],
      [
        { cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 400 },
        { cdn_id: "cdn-b", period_start: "2026-03-01T00:00:00Z", delivered_gb: 600 },
      ],
    );
    const estimates = estimateCosts(["cdn-a", "cdn-b", "cdn-c"], registry, tracker, now);
    const a = estimates.find((e) => e.cdn_id === "cdn-a")!;
    const b = estimates.find((e) => e.cdn_id === "cdn-b")!;
    const c = estimates.find((e) => e.cdn_id === "cdn-c")!;
    expect(a.within_commit).toBe(true);
    expect(a.effective_cost_per_gb).toBeCloseTo(0.04);
    expect(b.within_commit).toBe(false);
    expect(b.effective_cost_per_gb).toBeCloseTo(0.10);
    expect(c.within_commit).toBe(false);
    expect(c.effective_cost_per_gb).toBeCloseTo(0.15);
  });

  it("all CDNs burst exhausted returns empty cheapestFirst", () => {
    const registry = new CdnRegistry([providers[0]]);
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 100, max_burst_gb: 10 }],
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 110 }],
    );
    expect(cheapestFirst(["cdn-a"], registry, tracker, now)).toEqual([]);
  });
});
