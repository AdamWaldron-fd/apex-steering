import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  main,
  edge,
  extractSsFromManifest,
  decodeSs,
  type ManifestUpdateRequest,
  type SteeringResponse,
} from "../helpers/api";
import { updateManifest } from "../helpers/manifest-bridge";
import { sampleHls } from "../helpers/fixtures";

describe("CDN Disaster Recovery", () => {
  let initResp: ManifestUpdateRequest;
  let steeredManifest: string;
  let ssParam: string;

  beforeEach(async () => {
    await edge.reset();
  });

  /** Helper: set up a fresh session and extract _ss from the manifest. */
  async function initSession(): Promise<string> {
    initResp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: `${edge.url}/steer`,
      region: "us-east",
      min_bitrate: 783322,
      max_bitrate: 4530860,
      duration: 596,
    });
    steeredManifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    return extractSsFromManifest(steeredManifest);
  }

  // ── Normal baseline ────────────────────────────────────────────

  describe("normal baseline before disaster", () => {
    it("session starts with cdn-a as primary", async () => {
      ssParam = await initSession();
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
      expect(resp["PATHWAY-PRIORITY"]?.[1]).toBe("cdn-b");
    });

    it("healthy throughput on cdn-a keeps normal TTL", async () => {
      ssParam = await initSession();
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      expect(resp2.TTL).toBe(300);
      expect(resp2["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    });
  });

  // ── Master exclusion ───────────────────────────────────────────

  describe("master exclusion of cdn-a", () => {
    it("exclude cdn-a removes it from priorities", async () => {
      ssParam = await initSession();
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({
        _ss: ssParam,
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      expect(resp["PATHWAY-PRIORITY"]).not.toContain("cdn-a");
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    });

    it("player following RELOAD-URI also sees cdn-a excluded", async () => {
      ssParam = await initSession();
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-b",
        _HLS_throughput: 4000000,
      });
      expect(resp2["PATHWAY-PRIORITY"]).not.toContain("cdn-a");
    });
  });

  // ── QoE demotion during outage ─────────────────────────────────

  describe("QoE demotion with degraded throughput", () => {
    it("degraded throughput on cdn-a triggers QoE switch to cdn-b", async () => {
      ssParam = await initSession();
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      // Simulate cdn-a degradation
      const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 50000, // very low — cdn-a failing
      });
      expect(resp3["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
      expect(resp3.TTL).toBe(10); // fast poll during QoE event
    });

    it("QoE demotion combined with master exclusion", async () => {
      ssParam = await initSession();

      // Normal start
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });

      // Master excludes cdn-a (simulating ops noticing outage)
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));

      // Player reports degraded throughput on cdn-a
      const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 50000,
      });

      // Both QoE and master agree: cdn-b should be primary
      expect(resp3["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
      expect(resp3["PATHWAY-PRIORITY"]).not.toContain("cdn-a");
    });
  });

  // ── cdn-b takes over ───────────────────────────────────────────

  describe("cdn-b takeover", () => {
    it("cdn-b serves traffic with healthy throughput after failover", async () => {
      ssParam = await initSession();

      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      // cdn-a degrades
      const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 50000,
      });
      // Player switches to cdn-b, good throughput
      const resp4 = await edge.followReloadUri(resp3["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-b",
        _HLS_throughput: 6000000,
      });
      expect(resp4["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
      expect(resp4.TTL).toBe(300); // back to normal TTL
    });

    it("cdn-b maintains priority across multiple healthy polls", async () => {
      ssParam = await initSession();

      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 50000,
      });
      const resp4 = await edge.followReloadUri(resp3["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-b",
        _HLS_throughput: 6000000,
      });
      // Another poll — still on cdn-b
      const resp5 = await edge.followReloadUri(resp4["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-b",
        _HLS_throughput: 5500000,
      });
      expect(resp5["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    });
  });

  // ── Recovery after clear ───────────────────────────────────────

  describe("recovery after clear", () => {
    it("clear restores cdn-a to priorities after exclusion", async () => {
      ssParam = await initSession();

      // Exclude cdn-a
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));

      // Verify excluded
      const respExcluded = await edge.steerHls({ _ss: ssParam });
      expect(respExcluded["PATHWAY-PRIORITY"]).not.toContain("cdn-a");

      // Clear
      await main.clear();
      await new Promise((r) => setTimeout(r, 100));

      // cdn-a should be back
      const respRecovered = await edge.steerHls({ _ss: ssParam });
      expect(respRecovered["PATHWAY-PRIORITY"]).toContain("cdn-a");
      expect(respRecovered["PATHWAY-PRIORITY"]).toContain("cdn-b");
    });

    it("after clear, cdn-a returns as primary (original priority order)", async () => {
      ssParam = await initSession();

      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));
      await main.clear();
      await new Promise((r) => setTimeout(r, 100));

      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    });

    it("full disaster cycle: normal → exclude → degrade → failover → clear → recover", async () => {
      ssParam = await initSession();

      // 1. Normal operation on cdn-a
      const resp1 = await edge.steerHls({ _ss: ssParam });
      expect(resp1["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");

      // 2. Master excludes cdn-a
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));

      // 3. Player reports degraded cdn-a + edge has exclusion
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 50000,
      });
      expect(resp2["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");

      // 4. Player switches to cdn-b, healthy throughput
      const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-b",
        _HLS_throughput: 6000000,
      });
      expect(resp3["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
      expect(resp3.TTL).toBe(300);

      // 5. Ops clears exclusion (cdn-a recovered)
      await main.clear();
      await new Promise((r) => setTimeout(r, 100));

      // 6. Next poll should show cdn-a restored
      const resp4 = await edge.followReloadUri(resp3["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-b",
        _HLS_throughput: 6000000,
      });
      expect(resp4["PATHWAY-PRIORITY"]).toContain("cdn-a");
      expect(resp4["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    });

    it("recovery with healthy throughput on restored cdn-a", async () => {
      ssParam = await initSession();

      // Exclude and clear
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));
      await main.clear();
      await new Promise((r) => setTimeout(r, 100));

      // Poll with healthy cdn-a throughput
      const resp = await edge.steerHls({
        _ss: ssParam,
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
      expect(resp.TTL).toBe(300);
    });
  });
});
