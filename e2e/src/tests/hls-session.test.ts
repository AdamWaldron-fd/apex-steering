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

describe("HLS Full Session", () => {
  let initResp: ManifestUpdateRequest;
  let steeredManifest: string;
  let ssParam: string;

  beforeEach(async () => {
    await edge.reset();
  });

  // ── Step 1: session/init ───────────────────────────────────────

  describe("Step 1: session/init", () => {
    beforeAll(async () => {
      initResp = await main.sessionInit({
        cdns: "cdn-a,cdn-b",
        steering_uri: `${edge.url}/steer`,
        region: "us-east",
        min_bitrate: 783322,
        max_bitrate: 4530860,
        duration: 596,
      });
    });

    it("returns session_state object", () => {
      expect(initResp.session_state).toBeDefined();
      expect(typeof initResp.session_state).toBe("object");
    });

    it("returns 2 pathways", () => {
      expect(initResp.pathways).toHaveLength(2);
    });

    it("first pathway is cdn-a (default/primary)", () => {
      expect(initResp.pathways[0].pathway_id).toBe("cdn-a");
    });

    it("second pathway is cdn-b", () => {
      expect(initResp.pathways[1].pathway_id).toBe("cdn-b");
    });

    it("pathways have pathway_id and base_url", () => {
      for (const p of initResp.pathways) {
        expect(p.pathway_id).toBeTruthy();
        expect(p.base_url).toMatch(/^https?:\/\//);
      }
    });

    it("steering_uri matches requested", () => {
      expect(initResp.steering_uri).toBe(`${edge.url}/steer`);
    });

    it("session_state.min_bitrate passed through", () => {
      expect(initResp.session_state.min_bitrate).toBe(783322);
    });

    it("session_state.max_bitrate passed through", () => {
      expect(initResp.session_state.max_bitrate).toBe(4530860);
    });

    it("session_state.duration passed through", () => {
      expect(initResp.session_state.duration).toBe(596);
    });

    it("session_state.priorities match CDN order", () => {
      expect(initResp.session_state.priorities).toEqual(["cdn-a", "cdn-b"]);
    });

    it("session_state.override_gen matches server generation", () => {
      expect(initResp.session_state.override_gen).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Step 2: manifest transformation ────────────────────────────

  describe("Step 2: manifest transformation", () => {
    beforeAll(async () => {
      initResp = await main.sessionInit({
        cdns: "cdn-a,cdn-b",
        steering_uri: `${edge.url}/steer`,
        region: "us-east",
        min_bitrate: 783322,
        max_bitrate: 4530860,
        duration: 596,
      });
      steeredManifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    });

    it("injects #EXT-X-CONTENT-STEERING tag", () => {
      expect(steeredManifest).toContain("#EXT-X-CONTENT-STEERING");
    });

    it("CONTENT-STEERING tag appears after #EXTM3U", () => {
      const extm3uIdx = steeredManifest.indexOf("#EXTM3U");
      const steeringIdx = steeredManifest.indexOf("#EXT-X-CONTENT-STEERING");
      expect(steeringIdx).toBeGreaterThan(extm3uIdx);
    });

    it("SERVER-URI contains _ss= parameter", () => {
      expect(steeredManifest).toContain("_ss=");
    });

    it("SERVER-URI points to edge steering URL", () => {
      expect(steeredManifest).toContain(edge.url);
    });

    it("has PATHWAY-ID for cdn-a", () => {
      expect(steeredManifest).toContain('PATHWAY-ID="cdn-a"');
    });

    it("has PATHWAY-ID for cdn-b", () => {
      expect(steeredManifest).toContain('PATHWAY-ID="cdn-b"');
    });

    it("has STABLE-VARIANT-ID attributes", () => {
      expect(steeredManifest).toContain("STABLE-VARIANT-ID");
    });

    it("doubles variant count (4 originals x 2 pathways = 8)", () => {
      const origCount = (sampleHls().match(/#EXT-X-STREAM-INF/g) ?? []).length;
      const steeredCount = (steeredManifest.match(/#EXT-X-STREAM-INF/g) ?? []).length;
      expect(origCount).toBe(4);
      expect(steeredCount).toBe(origCount * 2);
    });

    it("doubles media rendition count (2 audio x 2 pathways = 4)", () => {
      const origCount = (sampleHls().match(/#EXT-X-MEDIA/g) ?? []).length;
      const steeredCount = (steeredManifest.match(/#EXT-X-MEDIA/g) ?? []).length;
      expect(origCount).toBe(2);
      expect(steeredCount).toBe(origCount * 2);
    });

    it("CDN base URLs appear in variant URIs", () => {
      for (const p of initResp.pathways) {
        expect(steeredManifest).toContain(p.base_url);
      }
    });

    it("extracts valid _ss parameter from manifest", () => {
      ssParam = extractSsFromManifest(steeredManifest);
      expect(ssParam.length).toBeGreaterThan(10);
    });

    it("extracted _ss decodes to valid SessionState", () => {
      ssParam = extractSsFromManifest(steeredManifest);
      const decoded = decodeSs(ssParam);
      expect(decoded.priorities).toEqual(["cdn-a", "cdn-b"]);
      expect(decoded.min_bitrate).toBe(783322);
    });

    it("preserves #EXT-X-VERSION tag", () => {
      expect(steeredManifest).toContain("#EXT-X-VERSION:6");
    });

    it("preserves #EXT-X-INDEPENDENT-SEGMENTS tag", () => {
      expect(steeredManifest).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    });
  });

  // ── Step 3-6: steering loop ────────────────────────────────────

  describe("Step 3-6: steering loop", () => {
    beforeAll(async () => {
      initResp = await main.sessionInit({
        cdns: "cdn-a,cdn-b",
        steering_uri: `${edge.url}/steer`,
        region: "us-east",
        min_bitrate: 783322,
        max_bitrate: 4530860,
        duration: 596,
      });
      steeredManifest = updateManifest(sampleHls(), JSON.stringify(initResp));
      ssParam = extractSsFromManifest(steeredManifest);
    });

    it("first request returns VERSION=1", async () => {
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp.VERSION).toBe(1);
    });

    it("first request returns TTL as a number", async () => {
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp.TTL).toBeTypeOf("number");
      expect(resp.TTL).toBeGreaterThan(0);
    });

    it("first request returns cdn-a as top priority", async () => {
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    });

    it("first request RELOAD-URI contains _ss", async () => {
      const resp = await edge.steerHls({ _ss: ssParam });
      expect(resp["RELOAD-URI"]).toBeDefined();
      expect(resp["RELOAD-URI"]).toContain("_ss=");
    });

    it("second request with healthy throughput keeps cdn-a on top", async () => {
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      expect(resp2["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
      expect(resp2.TTL).toBe(300);
    });

    it("third request with degraded throughput triggers QoE demotion", async () => {
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 50000, // degraded
      });
      expect(resp3["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
      expect(resp3.TTL).toBe(10); // QoE fast poll
    });

    it("fourth request shows recovery on cdn-b", async () => {
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
      expect(resp4["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    });

    it("recovery returns to normal TTL", async () => {
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
      expect(resp4.TTL).toBe(300);
    });

    it("RELOAD-URI chain maintains valid _ss across hops", async () => {
      const resp1 = await edge.steerHls({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _HLS_pathway: "cdn-a",
        _HLS_throughput: 5000000,
      });
      // Extract and decode _ss from the RELOAD-URI
      const reloadSs = resp2["RELOAD-URI"]!.match(/_ss=([^&]+)/)![1];
      const decoded = decodeSs(reloadSs);
      expect(decoded.priorities).toBeDefined();
      expect(decoded.throughput_map).toBeDefined();
    });
  });
});
