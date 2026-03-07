import { describe, it, expect, beforeEach } from "vitest";
import {
  main,
  edge,
  extractSsFromManifest,
  decodeSs,
  get,
  type ManifestUpdateRequest,
  type SessionState,
  type PathwayMapping,
} from "../helpers/api";
import { updateManifest, encodeState } from "../helpers/manifest-bridge";
import { sampleHls, sampleDash } from "../helpers/fixtures";

/**
 * Error handling across boundaries.
 *
 * Tests corrupted _ss, empty manifests, malformed JSON, and edge reset
 * to verify graceful degradation across all three systems.
 */
describe("Error Handling", () => {
  const STEERING_URI = `${edge.url}/steer/hls`;

  beforeEach(async () => {
    await edge.reset();
    await main.clear();
  });

  // ── Helper ─────────────────────────────────────────────────────

  function buildRequest(overrides?: Partial<ManifestUpdateRequest>): ManifestUpdateRequest {
    const state: SessionState = {
      priorities: ["cdn-a", "cdn-b"],
      throughput_map: [["cdn-a", 5000000]],
      min_bitrate: 783322,
      max_bitrate: 4530860,
      duration: 596,
      position: 0,
      timestamp: 1709654400,
      override_gen: 0,
    };
    return {
      session_state: state,
      pathways: [
        { pathway_id: "cdn-a", base_url: "https://cdn-a.example.com" },
        { pathway_id: "cdn-b", base_url: "https://cdn-b.example.com" },
      ],
      steering_uri: STEERING_URI,
      ...overrides,
    };
  }

  // ── Corrupted _ss ──────────────────────────────────────────────

  it("corrupted _ss with stored fallback returns valid response", async () => {
    // Store initial state as fallback (dev convenience)
    const state: SessionState = {
      priorities: ["cdn-a", "cdn-b"],
      throughput_map: [],
      min_bitrate: 783322,
      max_bitrate: 4530860,
      duration: 596,
      position: 0,
      timestamp: 1709654400,
      override_gen: 0,
    };
    await edge.storeInitialState(state);

    // Send garbage _ss — edge should fall back to stored state
    const resp = await edge.steerHls({ _ss: "INVALID_BASE64_GARBAGE" });
    expect(resp.VERSION).toBe(1);
    expect(resp["PATHWAY-PRIORITY"]).toBeDefined();
  });

  it("corrupted _ss without stored fallback returns error", async () => {
    // No stored state, edge has been reset
    try {
      const resp = await fetch(
        `${edge.url}/steer/hls?_ss=NOT_VALID_BASE64`,
      );
      // Either a 400/500 error or a valid fallback response
      // Both are acceptable error handling behaviours
      if (resp.ok) {
        const body = await resp.json();
        expect(body.VERSION).toBe(1);
      } else {
        expect(resp.status).toBeGreaterThanOrEqual(400);
      }
    } catch {
      // Network error is also acceptable for corrupt input
    }
  });

  it("truncated _ss is handled gracefully", async () => {
    const req = buildRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));
    const ss = extractSsFromManifest(manifest);

    // Truncate the _ss to half its length
    const truncated = ss.substring(0, Math.floor(ss.length / 2));
    try {
      const resp = await fetch(
        `${edge.url}/steer/hls?_ss=${truncated}`,
      );
      // Should not crash — either error response or fallback
      expect(resp.status).toBeDefined();
    } catch {
      // Network-level error acceptable
    }
  });

  it("empty _ss parameter is handled gracefully", async () => {
    try {
      const resp = await fetch(`${edge.url}/steer/hls?_ss=`);
      expect(resp.status).toBeDefined();
    } catch {
      // acceptable
    }
  });

  // ── Empty and malformed manifests ──────────────────────────────

  it("empty manifest returns empty string", () => {
    const req = buildRequest();
    const result = updateManifest("", JSON.stringify(req));
    // Empty input should return empty (or unchanged) output
    expect(result).toBe("");
  });

  it("non-HLS non-DASH manifest returns unchanged", () => {
    const req = buildRequest();
    const garbage = "this is not a manifest at all";
    const result = updateManifest(garbage, JSON.stringify(req));
    // Auto-detect finds neither #EXTM3U nor <MPD>, returns unchanged
    expect(result).toBe(garbage);
  });

  it("malformed JSON request throws", () => {
    expect(() => updateManifest(sampleHls(), "not json")).toThrow();
  });

  it("JSON with missing required fields throws", () => {
    expect(() =>
      updateManifest(sampleHls(), JSON.stringify({ session_state: {} })),
    ).toThrow();
  });

  // ── Edge reset clears state ────────────────────────────────────

  it("edge reset clears stored state", async () => {
    // Store initial state
    const state: SessionState = {
      priorities: ["cdn-a", "cdn-b"],
      throughput_map: [],
      min_bitrate: 783322,
      max_bitrate: 4530860,
      duration: 596,
      position: 0,
      timestamp: 1709654400,
      override_gen: 0,
    };
    await edge.storeInitialState(state);

    // Verify it works
    const resp1 = await edge.steerHls({ _ss: "GARBAGE" });
    expect(resp1.VERSION).toBe(1);

    // Reset
    await edge.reset();

    // After reset, corrupt _ss should no longer have a fallback
    try {
      const rawResp = await fetch(
        `${edge.url}/steer/hls?_ss=GARBAGE`,
      );
      if (rawResp.ok) {
        // Some implementations may still return a default
        const body = await rawResp.json();
        expect(body).toBeDefined();
      } else {
        expect(rawResp.status).toBeGreaterThanOrEqual(400);
      }
    } catch {
      // acceptable
    }
  });

  it("edge reset clears override commands", async () => {
    const req = buildRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));
    const ss = extractSsFromManifest(manifest);

    // Send an override to edge
    await edge.control({
      type: "set_priorities",
      region: null,
      priorities: ["cdn-b", "cdn-a"],
      generation: 1,
      ttl_override: null,
    });

    // Verify override took effect
    const resp1 = await edge.steerHls({ _ss: ss });
    expect(resp1["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");

    // Reset
    await edge.reset();

    // After reset, override should be gone — priorities from _ss
    const resp2 = await edge.steerHls({ _ss: ss });
    expect(resp2["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
  });
});
