import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  main,
  edge,
  extractSsFromManifest,
  decodeSs,
  post,
  get,
  type ManifestUpdateRequest,
  type SteeringResponse,
} from "../helpers/api";
import { updateManifest } from "../helpers/manifest-bridge";
import { sampleHls } from "../helpers/fixtures";

/**
 * Multi-region fleet tests.
 *
 * The global setup already registers one edge fleet member at us-east.
 * These tests register a second simulated fleet member and verify that
 * region-scoped commands only affect matching fleet members, while
 * global (null region) commands affect all.
 */
describe("Multi-Region Fleet", () => {
  const STEERING_URI = `${edge.url}/steer/hls`;
  let secondFleetId: string | undefined;

  beforeEach(async () => {
    await edge.reset();
    await main.clear();
  });

  afterEach(async () => {
    // Deregister any secondary fleet member we created
    if (secondFleetId) {
      try {
        await main.deregisterFleet(secondFleetId);
      } catch {
        // ignore cleanup errors
      }
      secondFleetId = undefined;
    }
  });

  // ── Helper: init a session and get _ss ─────────────────────────

  async function initAndGetSs(
    cdns = "cdn-a,cdn-b",
    region = "us-east",
  ): Promise<{ initResp: ManifestUpdateRequest; ss: string }> {
    const initResp = await main.sessionInit({
      cdns,
      steering_uri: STEERING_URI,
      region,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    const ss = extractSsFromManifest(manifest);
    return { initResp, ss };
  }

  // ── Region-scoped vs global commands ──────────────────────────

  it("global setup registers edge as us-east fleet member", async () => {
    const status = (await main.status()) as { fleet?: unknown[] };
    expect(status.fleet).toBeDefined();
    // At least the default us-east member from global setup
    const fleet = status.fleet as Array<{ region?: string }>;
    expect(fleet.some((m) => m.region === "us-east")).toBe(true);
  });

  it("can register a second fleet member for eu-west", async () => {
    // Register a second edge (pointing to the same server for test purposes,
    // but with a different region label)
    const resp = (await main.registerFleet({
      platform: "cloudflare",
      control_url: `${edge.url}/control`,
      region: "eu-west",
    })) as { id?: string };
    secondFleetId = resp.id;
    expect(secondFleetId).toBeDefined();

    const status = (await main.status()) as { fleet?: Array<{ region?: string }> };
    const regions = status.fleet?.map((m) => m.region) ?? [];
    expect(regions).toContain("us-east");
    expect(regions).toContain("eu-west");
  });

  it("setPriorities with region=us-east affects edge in us-east", async () => {
    const { ss } = await initAndGetSs();

    await main.setPriorities({
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
    });
    await new Promise((r) => setTimeout(r, 200));

    const resp = await edge.steerHls({
      _ss: ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
  });

  it("setPriorities with region=eu-west does NOT affect us-east edge", async () => {
    const { ss } = await initAndGetSs();

    // Send override scoped to eu-west only
    await main.setPriorities({
      region: "eu-west",
      priorities: ["cdn-b", "cdn-a"],
    });
    await new Promise((r) => setTimeout(r, 200));

    // The us-east edge should still have original priorities from _ss
    const resp = await edge.steerHls({
      _ss: ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
  });

  it("global setPriorities (null region) affects all edges", async () => {
    const { ss } = await initAndGetSs();

    await main.setPriorities({
      region: null,
      priorities: ["cdn-b", "cdn-a"],
    });
    await new Promise((r) => setTimeout(r, 200));

    const resp = await edge.steerHls({
      _ss: ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
  });

  it("exclude with region=us-east removes CDN from us-east edge", async () => {
    const { ss } = await initAndGetSs();

    await main.exclude({ pathway: "cdn-a", region: "us-east" });
    await new Promise((r) => setTimeout(r, 200));

    const resp = await edge.steerHls({ _ss: ss });
    expect(resp["PATHWAY-PRIORITY"]).not.toContain("cdn-a");
  });

  it("exclude with region=eu-west does NOT affect us-east edge", async () => {
    const { ss } = await initAndGetSs();

    await main.exclude({ pathway: "cdn-a", region: "eu-west" });
    await new Promise((r) => setTimeout(r, 200));

    const resp = await edge.steerHls({ _ss: ss });
    expect(resp["PATHWAY-PRIORITY"]).toContain("cdn-a");
  });

  it("global exclude (null region) affects all edges", async () => {
    const { ss } = await initAndGetSs();

    await main.exclude({ pathway: "cdn-a", region: null });
    await new Promise((r) => setTimeout(r, 200));

    const resp = await edge.steerHls({ _ss: ss });
    expect(resp["PATHWAY-PRIORITY"]).not.toContain("cdn-a");
  });

  // ── Region in session init ─────────────────────────────────────

  it("session init with region=us-east returns pathways available in us-east", async () => {
    const resp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
      region: "us-east",
    });
    // Both cdn-a and cdn-b serve us-east (from providers.json)
    expect(resp.pathways).toHaveLength(2);
    const ids = resp.pathways.map((p) => p.pathway_id);
    expect(ids).toContain("cdn-a");
    expect(ids).toContain("cdn-b");
  });

  it("session init without region returns all requested CDNs", async () => {
    const resp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    expect(resp.pathways).toHaveLength(2);
  });

  // ── Clear after regional override ──────────────────────────────

  it("clear restores all regions to original state", async () => {
    const { ss } = await initAndGetSs();

    // Override us-east
    await main.setPriorities({
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
    });
    await new Promise((r) => setTimeout(r, 200));

    // Verify override took effect
    let resp = await edge.steerHls({ _ss: ss });
    expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");

    // Clear all overrides
    await main.clear();
    await new Promise((r) => setTimeout(r, 200));

    resp = await edge.steerHls({ _ss: ss });
    expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
  });

  it("sequential regional overrides are independent", async () => {
    const { ss } = await initAndGetSs();

    // Override us-east
    await main.setPriorities({
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
    });
    await new Promise((r) => setTimeout(r, 200));

    // Verify
    let resp = await edge.steerHls({ _ss: ss });
    expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");

    // Override globally (should also affect us-east)
    await main.setPriorities({
      region: null,
      priorities: ["cdn-a", "cdn-b"],
    });
    await new Promise((r) => setTimeout(r, 200));

    resp = await edge.steerHls({ _ss: ss });
    expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
  });
});
