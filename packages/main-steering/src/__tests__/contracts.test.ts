import { describe, it, expect } from "vitest";
import {
  CommitTracker,
  commitRemainingGb,
  commitPct,
  commitMet,
  burstExhausted,
  behindPace,
  periodElapsedPct,
  type Contract,
  type ContractUsage,
} from "../contracts.js";

function makeContract(cdnId: string, minGb: number): Contract {
  return {
    cdn_id: cdnId,
    period_start: "2026-03-01T00:00:00Z",
    period_end: "2026-04-01T00:00:00Z",
    min_commit_gb: minGb,
    max_burst_gb: 100,
  };
}

function makeUsage(cdnId: string, delivered: number): ContractUsage {
  return {
    cdn_id: cdnId,
    period_start: "2026-03-01T00:00:00Z",
    delivered_gb: delivered,
  };
}

describe("Contract calculations", () => {
  it("commit remaining when under", () => {
    const contract = makeContract("cdn-a", 1000);
    const usage = makeUsage("cdn-a", 400);
    expect(commitRemainingGb(usage, contract)).toBeCloseTo(600);
  });

  it("commit remaining when over", () => {
    const contract = makeContract("cdn-a", 1000);
    const usage = makeUsage("cdn-a", 1200);
    expect(commitRemainingGb(usage, contract)).toBe(0);
  });

  it("commit pct half delivered", () => {
    const contract = makeContract("cdn-a", 1000);
    const usage = makeUsage("cdn-a", 500);
    expect(commitPct(usage, contract)).toBeCloseTo(0.5);
  });

  it("commit met", () => {
    const contract = makeContract("cdn-a", 1000);
    expect(commitMet(makeUsage("cdn-a", 999.9), contract)).toBe(false);
    expect(commitMet(makeUsage("cdn-a", 1000), contract)).toBe(true);
  });

  it("burst exhausted", () => {
    const contract = makeContract("cdn-a", 1000); // max_burst = 100
    expect(burstExhausted(makeUsage("cdn-a", 1050), contract)).toBe(false);
    expect(burstExhausted(makeUsage("cdn-a", 1100), contract)).toBe(true);
  });

  it("behind pace", () => {
    const contract = makeContract("cdn-a", 1000);
    // Mid-month = ~50% through
    const mid = new Date("2026-03-16T12:00:00Z");
    expect(behindPace(makeUsage("cdn-a", 300), contract, mid)).toBe(true); // 30% at 50%
    expect(behindPace(makeUsage("cdn-a", 600), contract, mid)).toBe(false); // 60% at 50%
  });
});

describe("CommitTracker", () => {
  it("active contract found", () => {
    const now = new Date("2026-03-15T00:00:00Z");
    const tracker = new CommitTracker([makeContract("cdn-a", 1000)]);
    expect(tracker.activeContract("cdn-a", now)).toBeDefined();
    expect(tracker.activeContract("cdn-b", now)).toBeUndefined();
  });

  it("record delivery accumulates", () => {
    const tracker = new CommitTracker();
    tracker.recordDelivery("cdn-a", 10);
    tracker.recordDelivery("cdn-a", 5);
    expect(tracker.currentUsage("cdn-a")?.delivered_gb).toBeCloseTo(15);
  });

  it("record delivery creates new entry for unknown CDN", () => {
    const tracker = new CommitTracker();
    tracker.recordDelivery("cdn-new", 42);
    const usage = tracker.currentUsage("cdn-new");
    expect(usage).toBeDefined();
    expect(usage!.delivered_gb).toBeCloseTo(42);
  });

  it("currentUsage returns undefined for unknown CDN", () => {
    const tracker = new CommitTracker();
    expect(tracker.currentUsage("nonexistent")).toBeUndefined();
  });

  it("activeContract returns undefined for out-of-period time", () => {
    const now = new Date("2026-05-01T00:00:00Z"); // After contract period
    const tracker = new CommitTracker([makeContract("cdn-a", 1000)]);
    expect(tracker.activeContract("cdn-a", now)).toBeUndefined();
  });

  it("activeContract returns undefined before period starts", () => {
    const now = new Date("2026-02-15T00:00:00Z"); // Before contract period
    const tracker = new CommitTracker([makeContract("cdn-a", 1000)]);
    expect(tracker.activeContract("cdn-a", now)).toBeUndefined();
  });

  it("multiple contracts for different CDNs", () => {
    const now = new Date("2026-03-15T00:00:00Z");
    const tracker = new CommitTracker([
      makeContract("cdn-a", 1000),
      makeContract("cdn-b", 2000),
    ]);
    expect(tracker.activeContract("cdn-a", now)?.min_commit_gb).toBe(1000);
    expect(tracker.activeContract("cdn-b", now)?.min_commit_gb).toBe(2000);
  });
});

describe("periodElapsedPct", () => {
  it("returns 0 at period start", () => {
    const contract = makeContract("cdn-a", 1000);
    const start = new Date("2026-03-01T00:00:00Z");
    expect(periodElapsedPct(contract, start)).toBeCloseTo(0);
  });

  it("returns ~0.5 at midpoint", () => {
    const contract = makeContract("cdn-a", 1000);
    const mid = new Date("2026-03-16T12:00:00Z");
    const pct = periodElapsedPct(contract, mid);
    expect(pct).toBeGreaterThan(0.45);
    expect(pct).toBeLessThan(0.55);
  });

  it("returns 1.0 at period end", () => {
    const contract = makeContract("cdn-a", 1000);
    const end = new Date("2026-04-01T00:00:00Z");
    expect(periodElapsedPct(contract, end)).toBeCloseTo(1.0);
  });

  it("returns 1.0 after period end", () => {
    const contract = makeContract("cdn-a", 1000);
    const after = new Date("2026-05-01T00:00:00Z");
    expect(periodElapsedPct(contract, after)).toBeCloseTo(1.0);
  });

  it("returns 0 before period start", () => {
    const contract = makeContract("cdn-a", 1000);
    const before = new Date("2026-02-01T00:00:00Z");
    expect(periodElapsedPct(contract, before)).toBeCloseTo(0);
  });

  it("handles zero-length period", () => {
    const contract: Contract = {
      cdn_id: "cdn-a",
      period_start: "2026-03-01T00:00:00Z",
      period_end: "2026-03-01T00:00:00Z",
      min_commit_gb: 100,
      max_burst_gb: null,
    };
    expect(periodElapsedPct(contract, new Date("2026-03-01T00:00:00Z"))).toBe(1.0);
  });
});

describe("Contract edge cases", () => {
  it("commitPct returns 1.0 when min_commit_gb is 0", () => {
    const contract: Contract = { ...makeContract("cdn-a", 0) };
    contract.min_commit_gb = 0;
    const usage = makeUsage("cdn-a", 0);
    expect(commitPct(usage, contract)).toBe(1.0);
  });

  it("burstExhausted returns false when max_burst_gb is null (unlimited)", () => {
    const contract: Contract = {
      cdn_id: "cdn-a",
      period_start: "2026-03-01T00:00:00Z",
      period_end: "2026-04-01T00:00:00Z",
      min_commit_gb: 100,
      max_burst_gb: null,
    };
    const usage = makeUsage("cdn-a", 999999);
    expect(burstExhausted(usage, contract)).toBe(false);
  });

  it("commitRemainingGb is exact at boundary", () => {
    const contract = makeContract("cdn-a", 1000);
    expect(commitRemainingGb(makeUsage("cdn-a", 1000), contract)).toBe(0);
  });

  it("behindPace is false when commit is met", () => {
    const contract = makeContract("cdn-a", 1000);
    const mid = new Date("2026-03-16T12:00:00Z");
    // 100% fulfilled at 50% elapsed = ahead of pace
    expect(behindPace(makeUsage("cdn-a", 1000), contract, mid)).toBe(false);
  });
});
