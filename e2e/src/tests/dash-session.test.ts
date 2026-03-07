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
import { sampleDash } from "../helpers/fixtures";

describe("DASH Full Session", () => {
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

    it("returns 2 pathways for DASH", () => {
      expect(initResp.pathways).toHaveLength(2);
    });

    it("pathways have valid base_url for DASH", () => {
      for (const p of initResp.pathways) {
        expect(p.base_url).toMatch(/^https?:\/\//);
      }
    });

    it("steering_uri matches requested", () => {
      expect(initResp.steering_uri).toBe(`${edge.url}/steer`);
    });
  });

  // ── Step 2: DASH manifest transformation ───────────────────────

  describe("Step 2: DASH manifest transformation", () => {
    beforeAll(async () => {
      initResp = await main.sessionInit({
        cdns: "cdn-a,cdn-b",
        steering_uri: `${edge.url}/steer`,
        region: "us-east",
        min_bitrate: 783322,
        max_bitrate: 4530860,
        duration: 596,
      });
      steeredManifest = updateManifest(sampleDash(), JSON.stringify(initResp));
    });

    it("injects <ContentSteering> element", () => {
      expect(steeredManifest).toContain("<ContentSteering");
    });

    it("ContentSteering has queryBeforeStart attribute", () => {
      expect(steeredManifest).toMatch(/queryBeforeStart\s*=\s*"true"/);
    });

    it("ContentSteering has defaultServiceLocation attribute", () => {
      expect(steeredManifest).toContain("defaultServiceLocation");
    });

    it("defaultServiceLocation is cdn-a (primary)", () => {
      expect(steeredManifest).toMatch(/defaultServiceLocation\s*=\s*"cdn-a"/);
    });

    it("ContentSteering URL contains _ss= parameter", () => {
      // The steering URL inside <ContentSteering> should have _ss=
      const csMatch = steeredManifest.match(/<ContentSteering[^>]*>(.*?)<\/ContentSteering>/);
      expect(csMatch).toBeTruthy();
      expect(csMatch![1]).toContain("_ss=");
    });

    it("injects <BaseURL> elements with serviceLocation", () => {
      expect(steeredManifest).toContain("serviceLocation");
      expect(steeredManifest).toContain("<BaseURL");
    });

    it("has BaseURL with serviceLocation=cdn-a", () => {
      expect(steeredManifest).toMatch(/serviceLocation\s*=\s*"cdn-a"/);
    });

    it("has BaseURL with serviceLocation=cdn-b", () => {
      expect(steeredManifest).toMatch(/serviceLocation\s*=\s*"cdn-b"/);
    });

    it("does NOT duplicate Representation elements (DASH uses BaseURL, not cloning)", () => {
      const origCount = (sampleDash().match(/<Representation/g) ?? []).length;
      const steeredCount = (steeredManifest.match(/<Representation/g) ?? []).length;
      expect(steeredCount).toBe(origCount);
    });

    it("preserves MPD root element", () => {
      expect(steeredManifest).toContain("<MPD");
      expect(steeredManifest).toContain("</MPD>");
    });

    it("preserves AdaptationSet elements", () => {
      const origCount = (sampleDash().match(/<AdaptationSet/g) ?? []).length;
      const steeredCount = (steeredManifest.match(/<AdaptationSet/g) ?? []).length;
      expect(steeredCount).toBe(origCount);
    });

    it("extracts valid _ss parameter from DASH manifest", () => {
      ssParam = extractSsFromManifest(steeredManifest);
      expect(ssParam.length).toBeGreaterThan(10);
    });

    it("extracted _ss decodes to valid SessionState", () => {
      ssParam = extractSsFromManifest(steeredManifest);
      const decoded = decodeSs(ssParam);
      expect(decoded.priorities).toEqual(["cdn-a", "cdn-b"]);
    });
  });

  // ── Step 3-6: DASH steering loop ──────────────────────────────

  describe("Step 3-6: DASH steering loop", () => {
    beforeAll(async () => {
      initResp = await main.sessionInit({
        cdns: "cdn-a,cdn-b",
        steering_uri: `${edge.url}/steer`,
        region: "us-east",
        min_bitrate: 783322,
        max_bitrate: 4530860,
        duration: 596,
      });
      steeredManifest = updateManifest(sampleDash(), JSON.stringify(initResp));
      ssParam = extractSsFromManifest(steeredManifest);
    });

    it("first DASH request returns VERSION=1", async () => {
      const resp = await edge.steerDash({ _ss: ssParam });
      expect(resp.VERSION).toBe(1);
    });

    it("first DASH request returns TTL as a number", async () => {
      const resp = await edge.steerDash({ _ss: ssParam });
      expect(resp.TTL).toBeTypeOf("number");
      expect(resp.TTL).toBeGreaterThan(0);
    });

    it("DASH uses SERVICE-LOCATION-PRIORITY (not PATHWAY-PRIORITY)", async () => {
      const resp = await edge.steerDash({ _ss: ssParam });
      expect(resp["SERVICE-LOCATION-PRIORITY"]).toBeDefined();
    });

    it("first request: cdn-a is top service location", async () => {
      const resp = await edge.steerDash({ _ss: ssParam });
      expect(resp["SERVICE-LOCATION-PRIORITY"]?.[0]).toBe("cdn-a");
    });

    it("first DASH request includes RELOAD-URI with _ss", async () => {
      const resp = await edge.steerDash({ _ss: ssParam });
      expect(resp["RELOAD-URI"]).toBeDefined();
      expect(resp["RELOAD-URI"]).toContain("_ss=");
    });

    it("second request: healthy throughput keeps cdn-a on top", async () => {
      const resp1 = await edge.steerDash({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _DASH_pathway: "cdn-a",
        _DASH_throughput: 5000000,
      });
      expect(resp2["SERVICE-LOCATION-PRIORITY"]?.[0]).toBe("cdn-a");
      expect(resp2.TTL).toBe(300);
    });

    it("third request: degraded throughput triggers QoE demotion", async () => {
      const resp1 = await edge.steerDash({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _DASH_pathway: "cdn-a",
        _DASH_throughput: 5000000,
      });
      const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
        _DASH_pathway: "cdn-a",
        _DASH_throughput: 50000, // degraded
      });
      expect(resp3["SERVICE-LOCATION-PRIORITY"]?.[0]).toBe("cdn-b");
      expect(resp3.TTL).toBe(10); // QoE fast poll
    });

    it("fourth request: recovery on cdn-b", async () => {
      const resp1 = await edge.steerDash({ _ss: ssParam });
      const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
        _DASH_pathway: "cdn-a",
        _DASH_throughput: 5000000,
      });
      const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
        _DASH_pathway: "cdn-a",
        _DASH_throughput: 50000,
      });
      const resp4 = await edge.followReloadUri(resp3["RELOAD-URI"]!, {
        _DASH_pathway: "cdn-b",
        _DASH_throughput: 6000000,
      });
      expect(resp4["SERVICE-LOCATION-PRIORITY"]?.[0]).toBe("cdn-b");
      expect(resp4.TTL).toBe(300);
    });
  });
});
