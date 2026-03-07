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

describe("Master Override Propagation", () => {
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

  // ── Baseline ───────────────────────────────────────────────────

  describe("baseline before overrides", () => {
    it("initial priorities are cdn-a, cdn-b", async () => {
      ssParam = await initSession();
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
      expect(resp["PATHWAY-PRIORITY"]?.[1]).toBe("cdn-b");
    });

    it("initial override_gen is 0", async () => {
      ssParam = await initSession();
      const decoded = decodeSs(ssParam);
      expect(decoded.override_gen).toBe(0);
    });
  });

  // ── setPriorities ──────────────────────────────────────────────

  describe("POST /priorities", () => {
    it("reverses priority order on edge", async () => {
      ssParam = await initSession();
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({
        _ss: ssParam,
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    });

    it("cdn-a moves to second position after priority swap", async () => {
      ssParam = await initSession();
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({
        _ss: ssParam,
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      expect(resp["PATHWAY-PRIORITY"]?.[1]).toBe("cdn-a");
    });

    it("RELOAD-URI reflects new priorities", async () => {
      ssParam = await initSession();
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["RELOAD-URI"]).toContain("_ss=");
    });

    it("subsequent request also reflects override", async () => {
      ssParam = await initSession();
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 100));
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-b",
        _HLS_throughput: 5000000,
      });
      expect(resp2["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    });

    it("multiple setPriorities calls — last one wins", async () => {
      ssParam = await initSession();
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 50));
      await main.setPriorities({ region: "us-east", priorities: ["cdn-a", "cdn-b"] });
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    });
  });

  // ── exclude ────────────────────────────────────────────────────

  describe("POST /exclude", () => {
    it("removes cdn-a from priorities", async () => {
      ssParam = await initSession();
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({
        _ss: ssParam,
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      expect(resp["PATHWAY-PRIORITY"]).not.toContain("cdn-a");
    });

    it("cdn-b becomes sole priority after cdn-a excluded", async () => {
      ssParam = await initSession();
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    });

    it("excluding cdn-b leaves only cdn-a", async () => {
      ssParam = await initSession();
      await main.exclude({ pathway: "cdn-b" });
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
      expect(resp["PATHWAY-PRIORITY"]).not.toContain("cdn-b");
    });

    it("exclude propagates through RELOAD-URI chain", async () => {
      ssParam = await initSession();
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-b",
        _HLS_throughput: 5000000,
      });
      expect(resp2["PATHWAY-PRIORITY"]).not.toContain("cdn-a");
    });
  });

  // ── clear ──────────────────────────────────────────────────────

  describe("POST /clear", () => {
    it("restores original priorities after setPriorities", async () => {
      ssParam = await initSession();
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 100));
      await main.clear();
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({ _ss: ssParam });
      // After clear, should return to session state defaults (cdn-a first)
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    });

    it("restores excluded CDN after clear", async () => {
      ssParam = await initSession();
      await main.exclude({ pathway: "cdn-a" });
      await new Promise((r) => setTimeout(r, 100));
      await main.clear();
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]).toContain("cdn-a");
      expect(resp["PATHWAY-PRIORITY"]).toContain("cdn-b");
    });

    it("clear is idempotent", async () => {
      ssParam = await initSession();
      await main.clear();
      await main.clear();
      await new Promise((r) => setTimeout(r, 100));
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    });
  });

  // ── Stale generation rejection ─────────────────────────────────

  describe("generation counter", () => {
    it("stale generation=0 rejected after a real override", async () => {
      ssParam = await initSession();
      // Real override via main → bumps generation
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 100));

      // Stale control command with generation=0 directly to edge
      await edge.control({
        type: "set_priorities",
        region: null,
        priorities: ["cdn-a", "cdn-b"],
        generation: 0,
        ttl_override: null,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should still reflect the real override (cdn-b first), stale command ignored
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    });

    it("override → clear → override produces monotonically increasing generations", async () => {
      ssParam = await initSession();

      // First override
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 100));
      const resp1 = await edge.steerHls({ _ss: ssParam });
      expect(resp1["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");

      // Clear
      await main.clear();
      await new Promise((r) => setTimeout(r, 100));
      const resp2 = await edge.steerHls({ _ss: ssParam });
      expect(resp2["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");

      // Second override — should still work (generation incremented past the clear)
      await main.setPriorities({ region: "us-east", priorities: ["cdn-b", "cdn-a"] });
      await new Promise((r) => setTimeout(r, 100));
      const resp3 = await edge.steerHls({ _ss: ssParam });
      expect(resp3["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    });
  });
});
