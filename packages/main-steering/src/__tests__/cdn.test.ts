import { describe, it, expect } from "vitest";
import { CdnRegistry, type CdnProvider, defaultPricingTier } from "../cdn.js";

function makeProviders(): CdnProvider[] {
  return [
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
      pricing: defaultPricingTier(),
      weight: 0.3,
      enabled: false,
    },
  ];
}

describe("CdnRegistry", () => {
  it("get provider by id", () => {
    const reg = new CdnRegistry(makeProviders());
    expect(reg.get("cdn-a")?.name).toBe("CDN Alpha");
    expect(reg.get("cdn-b")?.name).toBe("CDN Beta");
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("enabledForRegion filters correctly", () => {
    const reg = new CdnRegistry(makeProviders());
    const usEast = reg.enabledForRegion("us-east");
    expect(usEast).toHaveLength(2);
    const euWest = reg.enabledForRegion("eu-west");
    expect(euWest).toHaveLength(1);
    expect(euWest[0].id).toBe("cdn-b");
  });

  it("enabledForRegion without region returns all enabled", () => {
    const reg = new CdnRegistry(makeProviders());
    const all = reg.enabledForRegion();
    expect(all).toHaveLength(2); // cdn-c disabled
  });

  it("disabled providers excluded", () => {
    const reg = new CdnRegistry(makeProviders());
    const ids = reg.enabledIdsForRegion();
    expect(ids).not.toContain("cdn-c");
  });

  it("global provider available in all regions", () => {
    const reg = new CdnRegistry([
      {
        id: "global",
        name: "Global",
        base_url: "https://global.example.com",
        regions: [],
        pricing: defaultPricingTier(),
        weight: 1.0,
        enabled: true,
      },
    ]);
    expect(reg.enabledForRegion("any-region")).toHaveLength(1);
    expect(reg.enabledForRegion()).toHaveLength(1);
  });

  it("empty registry returns empty results", () => {
    const reg = new CdnRegistry();
    expect(reg.providers).toHaveLength(0);
    expect(reg.get("anything")).toBeUndefined();
    expect(reg.enabledForRegion()).toHaveLength(0);
    expect(reg.enabledIdsForRegion()).toHaveLength(0);
  });

  it("enabledIdsForRegion returns only matching IDs", () => {
    const reg = new CdnRegistry(makeProviders());
    const ids = reg.enabledIdsForRegion("eu-west");
    expect(ids).toEqual(["cdn-b"]);
  });

  it("multiple providers in same region", () => {
    const reg = new CdnRegistry(makeProviders());
    const usEast = reg.enabledIdsForRegion("us-east");
    expect(usEast).toContain("cdn-a");
    expect(usEast).toContain("cdn-b");
    expect(usEast).toHaveLength(2);
  });

  it("provider in non-matching region excluded", () => {
    const reg = new CdnRegistry(makeProviders());
    const apSouth = reg.enabledForRegion("ap-south");
    expect(apSouth).toHaveLength(0); // cdn-a/b not in ap-south, cdn-c disabled
  });
});

describe("defaultPricingTier", () => {
  it("returns zeroed USD pricing", () => {
    const tier = defaultPricingTier();
    expect(tier.cost_per_gb).toBe(0);
    expect(tier.burst_cost_per_gb).toBe(0);
    expect(tier.currency).toBe("USD");
  });

  it("returns a new object each call", () => {
    const a = defaultPricingTier();
    const b = defaultPricingTier();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
