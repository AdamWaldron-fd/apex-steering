import { describe, it, expect } from "vitest";
import { AppState } from "../state.js";
import { CdnRegistry, type CdnProvider } from "../cdn.js";
import { CommitTracker } from "../contracts.js";
import { EdgeFleet } from "../fleet.js";

describe("AppState", () => {
  it("initializes with defaults when no args provided", () => {
    const state = new AppState();
    expect(state.cdnRegistry).toBeInstanceOf(CdnRegistry);
    expect(state.commitTracker).toBeInstanceOf(CommitTracker);
    expect(state.fleet).toBeInstanceOf(EdgeFleet);
    expect(state.generation).toBe(0);
  });

  it("accepts custom CdnRegistry", () => {
    const providers: CdnProvider[] = [
      { id: "cdn-x", name: "X", base_url: "https://cdn-x.example.com", regions: [], pricing: { cost_per_gb: 0.1, burst_cost_per_gb: 0.2, currency: "USD" }, weight: 1.0, enabled: true },
    ];
    const state = new AppState(new CdnRegistry(providers));
    expect(state.cdnRegistry.get("cdn-x")).toBeDefined();
  });

  it("accepts custom CommitTracker", () => {
    const tracker = new CommitTracker(
      [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 500, max_burst_gb: null }],
    );
    const state = new AppState(undefined, tracker);
    expect(state.commitTracker.contracts).toHaveLength(1);
  });

  it("accepts custom EdgeFleet", () => {
    const fleet = new EdgeFleet();
    fleet.register({ id: "e1", platform: "akamai", control_url: "https://example.com/control", region: null, last_seen: new Date().toISOString(), healthy: true });
    const state = new AppState(undefined, undefined, fleet);
    expect(state.fleet.instances).toHaveLength(1);
  });

  it("generation starts at 0", () => {
    const state = new AppState();
    expect(state.generation).toBe(0);
  });

  it("nextGeneration increments by 1 each call", () => {
    const state = new AppState();
    expect(state.nextGeneration()).toBe(1);
    expect(state.nextGeneration()).toBe(2);
    expect(state.nextGeneration()).toBe(3);
    expect(state.generation).toBe(3);
  });

  it("generation counter is monotonically increasing", () => {
    const state = new AppState();
    const values: number[] = [];
    for (let i = 0; i < 100; i++) {
      values.push(state.nextGeneration());
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it("generation getter does not mutate", () => {
    const state = new AppState();
    state.nextGeneration();
    const g1 = state.generation;
    const g2 = state.generation;
    expect(g1).toBe(g2);
    expect(g1).toBe(1);
  });
});
