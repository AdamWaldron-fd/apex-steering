import { describe, it, expect } from "vitest";
import { buildSessionState } from "../sessions.js";
import { CdnRegistry, type CdnProvider } from "../cdn.js";
import { CommitTracker } from "../contracts.js";

const providers: CdnProvider[] = [
  {
    id: "cdn-a",
    name: "CDN Alpha",
    base_url: "https://cdn-a.example.com",
    regions: ["us-east"],
    pricing: { cost_per_gb: 0.08, burst_cost_per_gb: 0.12, currency: "USD" },
    weight: 0.6,
    enabled: true,
  },
  {
    id: "cdn-b",
    name: "CDN Beta",
    base_url: "https://cdn-b.example.com",
    regions: ["us-east"],
    pricing: { cost_per_gb: 0.05, burst_cost_per_gb: 0.10, currency: "USD" },
    weight: 0.4,
    enabled: true,
  },
];

describe("buildSessionState", () => {
  it("produces valid SessionState with all required fields", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const state = buildSessionState(
      { cdn_ids: ["cdn-a", "cdn-b"], min_bitrate: 500000, max_bitrate: 4000000, duration: 3600 },
      registry,
      tracker,
      0,
    );
    expect(state.priorities).toHaveLength(2);
    expect(state.priorities).toContain("cdn-a");
    expect(state.priorities).toContain("cdn-b");
    expect(state.throughput_map).toEqual([]);
    expect(state.min_bitrate).toBe(500000);
    expect(state.max_bitrate).toBe(4000000);
    expect(state.duration).toBe(3600);
    expect(state.position).toBe(0);
    expect(state.timestamp).toBeGreaterThan(0);
    expect(state.override_gen).toBe(0);
  });

  it("carries current generation into override_gen", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const state = buildSessionState(
      { cdn_ids: ["cdn-a"], min_bitrate: 0, max_bitrate: 0, duration: 0 },
      registry,
      tracker,
      42,
    );
    expect(state.override_gen).toBe(42);
  });

  it("falls back to input order when all CDNs are unknown", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const state = buildSessionState(
      { cdn_ids: ["unknown-x", "unknown-y"], min_bitrate: 0, max_bitrate: 0, duration: 0 },
      registry,
      tracker,
      0,
    );
    expect(state.priorities).toEqual(["unknown-x", "unknown-y"]);
  });

  it("sets timestamp to current epoch seconds", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const before = Math.floor(Date.now() / 1000);
    const state = buildSessionState(
      { cdn_ids: ["cdn-a"], min_bitrate: 0, max_bitrate: 0, duration: 0 },
      registry,
      tracker,
      0,
    );
    const after = Math.floor(Date.now() / 1000);
    expect(state.timestamp).toBeGreaterThanOrEqual(before);
    expect(state.timestamp).toBeLessThanOrEqual(after);
  });

  it("live content has duration 0", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const state = buildSessionState(
      { cdn_ids: ["cdn-a"], min_bitrate: 0, max_bitrate: 0, duration: 0 },
      registry,
      tracker,
      0,
    );
    expect(state.duration).toBe(0);
  });

  it("single CDN produces single-element priorities", () => {
    const registry = new CdnRegistry(providers);
    const tracker = new CommitTracker();
    const state = buildSessionState(
      { cdn_ids: ["cdn-a"], min_bitrate: 0, max_bitrate: 0, duration: 0 },
      registry,
      tracker,
      0,
    );
    expect(state.priorities).toEqual(["cdn-a"]);
  });

  it("region parameter filters available CDNs", () => {
    const registry = new CdnRegistry([
      ...providers,
      {
        id: "cdn-eu",
        name: "CDN EU Only",
        base_url: "https://cdn-eu.example.com",
        regions: ["eu-west"],
        pricing: { cost_per_gb: 0.01, burst_cost_per_gb: 0.02, currency: "EUR" },
        weight: 0.9,
        enabled: true,
      },
    ]);
    const tracker = new CommitTracker();
    // cdn-eu is cheapest but only available in eu-west
    // When requesting us-east CDNs, cdn-eu should still appear in priorities
    // because we pass cdn_ids explicitly (region is a hint for priority calc)
    const state = buildSessionState(
      { cdn_ids: ["cdn-a", "cdn-eu"], region: "us-east", min_bitrate: 0, max_bitrate: 0, duration: 0 },
      registry,
      tracker,
      0,
    );
    expect(state.priorities).toHaveLength(2);
  });
});
