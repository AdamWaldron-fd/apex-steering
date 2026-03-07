import { describe, it, expect } from "vitest";
import { EdgeFleet, parseEdgePlatform, type EdgeInstance } from "../fleet.js";

function makeInstance(
  id: string,
  platform: "akamai" | "cloudfront" | "cloudflare" | "fastly",
  region: string | null,
  healthy: boolean,
): EdgeInstance {
  return {
    id,
    platform,
    control_url: `https://${id}.example.com/control`,
    region,
    last_seen: new Date().toISOString(),
    healthy,
  };
}

describe("EdgeFleet", () => {
  it("register and deregister", () => {
    const fleet = new EdgeFleet();
    fleet.register(makeInstance("e1", "akamai", null, true));
    fleet.register(makeInstance("e2", "cloudfront", null, true));
    expect(fleet.instances).toHaveLength(2);
    expect(fleet.deregister("e1")).toBe(true);
    expect(fleet.instances).toHaveLength(1);
    expect(fleet.deregister("nonexistent")).toBe(false);
  });

  it("healthy instances filters", () => {
    const fleet = new EdgeFleet();
    fleet.register(makeInstance("e1", "akamai", "us-east", true));
    fleet.register(makeInstance("e2", "cloudfront", "us-east", false));
    fleet.register(makeInstance("e3", "cloudflare", "eu-west", true));

    const usEast = fleet.healthyInstances("us-east");
    expect(usEast).toHaveLength(1);
    expect(usEast[0].id).toBe("e1");

    const all = fleet.healthyInstances();
    expect(all).toHaveLength(2);
  });

  it("by platform", () => {
    const fleet = new EdgeFleet();
    fleet.register(makeInstance("e1", "akamai", null, true));
    fleet.register(makeInstance("e2", "akamai", null, true));
    fleet.register(makeInstance("e3", "fastly", null, true));

    expect(fleet.byPlatform("akamai")).toHaveLength(2);
    expect(fleet.byPlatform("fastly")).toHaveLength(1);
    expect(fleet.byPlatform("cloudflare")).toHaveLength(0);
  });

  it("get returns instance by ID", () => {
    const fleet = new EdgeFleet();
    fleet.register(makeInstance("e1", "akamai", null, true));
    fleet.register(makeInstance("e2", "cloudfront", "us-east", true));
    expect(fleet.get("e1")?.platform).toBe("akamai");
    expect(fleet.get("e2")?.region).toBe("us-east");
    expect(fleet.get("nonexistent")).toBeUndefined();
  });

  it("healthyInstances with null region instances (global)", () => {
    const fleet = new EdgeFleet();
    fleet.register(makeInstance("global-1", "akamai", null, true));
    fleet.register(makeInstance("regional-1", "cloudfront", "us-east", true));

    // When filtering by region, null-region instances should NOT match
    const usEast = fleet.healthyInstances("us-east");
    expect(usEast).toHaveLength(1);
    expect(usEast[0].id).toBe("regional-1");

    // When no region filter, all healthy returned
    const all = fleet.healthyInstances();
    expect(all).toHaveLength(2);
  });

  it("empty fleet returns empty arrays", () => {
    const fleet = new EdgeFleet();
    expect(fleet.instances).toHaveLength(0);
    expect(fleet.healthyInstances()).toHaveLength(0);
    expect(fleet.byPlatform("akamai")).toHaveLength(0);
    expect(fleet.get("any")).toBeUndefined();
    expect(fleet.deregister("any")).toBe(false);
  });

  it("deregister idempotent — second call returns false", () => {
    const fleet = new EdgeFleet();
    fleet.register(makeInstance("e1", "akamai", null, true));
    expect(fleet.deregister("e1")).toBe(true);
    expect(fleet.deregister("e1")).toBe(false);
  });
});

describe("parseEdgePlatform", () => {
  it("parses valid platforms", () => {
    expect(parseEdgePlatform("akamai")).toBe("akamai");
    expect(parseEdgePlatform("CloudFront")).toBe("cloudfront");
    expect(parseEdgePlatform("CLOUDFLARE")).toBe("cloudflare");
    expect(parseEdgePlatform("fastly")).toBe("fastly");
  });

  it("rejects invalid platforms", () => {
    expect(parseEdgePlatform("unknown")).toBeUndefined();
  });

  it("rejects empty string", () => {
    expect(parseEdgePlatform("")).toBeUndefined();
  });

  it("handles mixed case", () => {
    expect(parseEdgePlatform("Akamai")).toBe("akamai");
    expect(parseEdgePlatform("FASTLY")).toBe("fastly");
    expect(parseEdgePlatform("cloudFlare")).toBe("cloudflare");
  });
});
