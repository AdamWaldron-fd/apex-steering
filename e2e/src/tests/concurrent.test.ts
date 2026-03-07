import { describe, it, expect, beforeEach } from "vitest";
import {
  main,
  edge,
  extractSsFromManifest,
  decodeSs,
  type ManifestUpdateRequest,
} from "../helpers/api";
import { updateManifest } from "../helpers/manifest-bridge";
import { sampleHls } from "../helpers/fixtures";

/**
 * Concurrent session independence.
 *
 * Two independent sessions with different CDN sets transform manifests
 * separately. Interleaved steering requests verify that each session's
 * _ss state is independent and overrides to one CDN don't corrupt
 * the other session's state.
 */
describe("Concurrent Sessions", () => {
  const STEERING_URI = `${edge.url}/steer/hls`;

  beforeEach(async () => {
    await edge.reset();
    await main.clear();
  });

  // ── Helper ─────────────────────────────────────────────────────

  async function initSession(cdns: string): Promise<{
    initResp: ManifestUpdateRequest;
    manifest: string;
    ss: string;
  }> {
    const initResp = await main.sessionInit({
      cdns,
      steering_uri: STEERING_URI,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    const ss = extractSsFromManifest(manifest);
    return { initResp, manifest, ss };
  }

  // ── Independent session state ──────────────────────────────────

  it("two sessions with different CDN order get different _ss values", async () => {
    const sessionA = await initSession("cdn-a,cdn-b");
    const sessionB = await initSession("cdn-b,cdn-a");

    // Both should encode priorities, but the encoded _ss may differ
    // because session_state fields like timestamp differ
    expect(sessionA.ss).not.toBe(sessionB.ss);
  });

  it("session A priorities are [cdn-a, cdn-b]", async () => {
    const sessionA = await initSession("cdn-a,cdn-b");
    const decoded = decodeSs(sessionA.ss);
    expect(decoded.priorities).toEqual(["cdn-a", "cdn-b"]);
  });

  it("session B with single CDN has [cdn-b] priority", async () => {
    const sessionB = await initSession("cdn-b");
    const decoded = decodeSs(sessionB.ss);
    expect(decoded.priorities).toEqual(["cdn-b"]);
  });

  it("interleaved steering requests return correct priorities per session", async () => {
    const sessionA = await initSession("cdn-a,cdn-b");
    const sessionB = await initSession("cdn-b,cdn-a");

    // Session A steering
    const respA = await edge.steerHls({ _ss: sessionA.ss });
    // Session B steering
    const respB = await edge.steerHls({ _ss: sessionB.ss });
    // Session A again
    const respA2 = await edge.steerHls({ _ss: sessionA.ss });

    expect(respA["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    // Session B also gets cdn-a first (contract weight still applies)
    expect(respB["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    expect(respA2["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
  });

  it("throughput degradation in session A does not affect session B", async () => {
    const sessionA = await initSession("cdn-a,cdn-b");
    const sessionB = await initSession("cdn-a,cdn-b");

    // Session A: good throughput, then degraded
    const respA1 = await edge.steerHls({
      _ss: sessionA.ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    const respA2 = await edge.followReloadUri(respA1["RELOAD-URI"]!, {
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 50000, // degraded
    });

    // Session A should have QoE demotion
    expect(respA2["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");

    // Session B: first request, healthy — should not be affected by A's demotion
    const respB = await edge.steerHls({
      _ss: sessionB.ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    expect(respB["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
  });

  it("override affects both sessions equally (state carried in _ss)", async () => {
    const sessionA = await initSession("cdn-a,cdn-b");
    const sessionB = await initSession("cdn-a,cdn-b");

    await main.setPriorities({
      region: null,
      priorities: ["cdn-b", "cdn-a"],
    });
    await new Promise((r) => setTimeout(r, 200));

    const respA = await edge.steerHls({ _ss: sessionA.ss });
    const respB = await edge.steerHls({ _ss: sessionB.ss });

    // Both sessions should see the override
    expect(respA["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
    expect(respB["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
  });

  it("each session's manifest has independent variant cloning", async () => {
    const sessionA = await initSession("cdn-a,cdn-b");
    const sessionB = await initSession("cdn-b");

    // Session A: 2 CDNs → 8 variants (4 × 2)
    const countA = (sessionA.manifest.match(/#EXT-X-STREAM-INF/g) ?? []).length;
    expect(countA).toBe(8);

    // Session B: 1 CDN → 4 variants (4 × 1)
    const countB = (sessionB.manifest.match(/#EXT-X-STREAM-INF/g) ?? []).length;
    expect(countB).toBe(4);
  });

  it("RELOAD-URI _ss from session A decodes to session A priorities", async () => {
    const sessionA = await initSession("cdn-a,cdn-b");

    const resp = await edge.steerHls({ _ss: sessionA.ss });
    const reloadUri = resp["RELOAD-URI"]!;
    const reloadSsMatch = reloadUri.match(/_ss=([^&]+)/);
    expect(reloadSsMatch).toBeTruthy();

    const reloadDecoded = decodeSs(reloadSsMatch![1]);
    expect(reloadDecoded.priorities[0]).toBe("cdn-a");
  });

  it("sessions with different bitrate params encode different _ss", async () => {
    const sessionA = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
      min_bitrate: 783322,
      max_bitrate: 4530860,
    });
    const sessionB = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
      min_bitrate: 100000,
      max_bitrate: 1000000,
    });

    const manifestA = updateManifest(sampleHls(), JSON.stringify(sessionA));
    const manifestB = updateManifest(sampleHls(), JSON.stringify(sessionB));

    const ssA = extractSsFromManifest(manifestA);
    const ssB = extractSsFromManifest(manifestB);

    const decodedA = decodeSs(ssA);
    const decodedB = decodeSs(ssB);

    expect(decodedA.min_bitrate).toBe(783322);
    expect(decodedB.min_bitrate).toBe(100000);
  });

  it("rapid interleaved requests do not mix up session state", async () => {
    const sessionA = await initSession("cdn-a,cdn-b");
    const sessionB = await initSession("cdn-a,cdn-b");

    // Fire multiple requests in quick succession
    const [rA1, rB1, rA2, rB2, rA3] = await Promise.all([
      edge.steerHls({ _ss: sessionA.ss, _HLS_pathway: "cdn-a", _HLS_throughput: 5000000 }),
      edge.steerHls({ _ss: sessionB.ss, _HLS_pathway: "cdn-a", _HLS_throughput: 5000000 }),
      edge.steerHls({ _ss: sessionA.ss, _HLS_pathway: "cdn-a", _HLS_throughput: 5000000 }),
      edge.steerHls({ _ss: sessionB.ss, _HLS_pathway: "cdn-a", _HLS_throughput: 5000000 }),
      edge.steerHls({ _ss: sessionA.ss, _HLS_pathway: "cdn-a", _HLS_throughput: 5000000 }),
    ]);

    // All should return valid responses with correct priorities
    for (const resp of [rA1, rB1, rA2, rB2, rA3]) {
      expect(resp.VERSION).toBe(1);
      expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
      expect(resp["RELOAD-URI"]).toContain("_ss=");
    }
  });
});
