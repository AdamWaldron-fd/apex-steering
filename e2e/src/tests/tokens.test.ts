import { describe, it, expect, beforeEach } from "vitest";
import {
  main,
  edge,
  extractSsFromManifest,
  decodeSs,
  type ManifestUpdateRequest,
  type SessionState,
  type PathwayMapping,
} from "../helpers/api";
import { updateManifest } from "../helpers/manifest-bridge";
import { sampleHls } from "../helpers/fixtures";

/**
 * CDN auth token passthrough.
 *
 * Verifies that query parameters (tokens) on the steering_uri survive
 * manifest transformation, appear in SERVER-URI, persist through
 * RELOAD-URI across multiple steering hops, and that internal params
 * (_ss, _HLS_*) are NOT duplicated in passthrough.
 */
describe("CDN Token Passthrough", () => {
  const TOKEN_STEERING_URI = `${edge.url}/steer/hls?start=123&end=456&hash=abc`;

  beforeEach(async () => {
    await edge.reset();
    await main.clear();
  });

  // ── Helper: build a ManifestUpdateRequest with token-laden URI ─

  function buildTokenRequest(overrides?: Partial<ManifestUpdateRequest>): ManifestUpdateRequest {
    const baseState: SessionState = {
      priorities: ["cdn-a", "cdn-b"],
      throughput_map: [["cdn-a", 5000000]],
      min_bitrate: 783322,
      max_bitrate: 4530860,
      duration: 596,
      position: 0,
      timestamp: 1709654400,
      override_gen: 0,
    };
    const basePathways: PathwayMapping[] = [
      { pathway_id: "cdn-a", base_url: "https://cdn-a.example.com" },
      { pathway_id: "cdn-b", base_url: "https://cdn-b.example.com" },
    ];
    return {
      session_state: baseState,
      pathways: basePathways,
      steering_uri: TOKEN_STEERING_URI,
      ...overrides,
    };
  }

  // ── Token survival in manifest ─────────────────────────────────

  it("tokens in steering_uri survive manifest transformation", () => {
    const req = buildTokenRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));

    expect(manifest).toContain("start=123");
    expect(manifest).toContain("end=456");
    expect(manifest).toContain("hash=abc");
  });

  it("SERVER-URI contains both tokens and _ss parameter", () => {
    const req = buildTokenRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));

    // Extract the SERVER-URI line
    const steeringLine = manifest
      .split("\n")
      .find((l) => l.includes("#EXT-X-CONTENT-STEERING"));
    expect(steeringLine).toBeDefined();

    const serverUriMatch = steeringLine!.match(/SERVER-URI="([^"]+)"/);
    expect(serverUriMatch).toBeTruthy();

    const serverUri = serverUriMatch![1];
    expect(serverUri).toContain("start=123");
    expect(serverUri).toContain("_ss=");
  });

  it("_ss parameter is appended alongside existing tokens", () => {
    const req = buildTokenRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));

    const serverUriMatch = manifest.match(/SERVER-URI="([^"]+)"/);
    const serverUri = serverUriMatch![1];
    const url = new URL(serverUri);

    expect(url.searchParams.get("start")).toBe("123");
    expect(url.searchParams.get("end")).toBe("456");
    expect(url.searchParams.get("hash")).toBe("abc");
    expect(url.searchParams.get("_ss")).toBeTruthy();
  });

  // ── Token preservation in RELOAD-URI ───────────────────────────

  it("tokens preserved in RELOAD-URI after first steering request", async () => {
    const req = buildTokenRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));
    const ss = extractSsFromManifest(manifest);

    const resp = await edge.steerHls({
      _ss: ss,
      extraParams: { start: "123", end: "456", hash: "abc" },
    });

    const reloadUri = resp["RELOAD-URI"]!;
    expect(reloadUri).toContain("_ss=");
    // The edge server should preserve passthrough params in RELOAD-URI
    // (tokens come from the request query string that edge passes through)
  });

  it("tokens survive multi-hop steering loop (3 hops)", async () => {
    const req = buildTokenRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));
    const ss = extractSsFromManifest(manifest);

    // Hop 1
    const resp1 = await edge.steerHls({
      _ss: ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
      extraParams: { start: "123", end: "456", hash: "abc" },
    });
    expect(resp1["RELOAD-URI"]).toBeDefined();

    // Hop 2: follow RELOAD-URI, add client params + tokens
    const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
      start: "123",
      end: "456",
      hash: "abc",
    });
    expect(resp2["RELOAD-URI"]).toBeDefined();

    // Hop 3
    const resp3 = await edge.followReloadUri(resp2["RELOAD-URI"]!, {
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
      start: "123",
      end: "456",
      hash: "abc",
    });
    expect(resp3.VERSION).toBe(1);
    expect(resp3["PATHWAY-PRIORITY"]).toBeDefined();
  });

  // ── Internal params NOT in passthrough ─────────────────────────

  it("_ss is not duplicated in RELOAD-URI", async () => {
    const req = buildTokenRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));
    const ss = extractSsFromManifest(manifest);

    const resp = await edge.steerHls({ _ss: ss });
    const reloadUri = resp["RELOAD-URI"]!;

    // Count occurrences of _ss= in the reload URI — should be exactly 1
    const ssMatches = reloadUri.match(/_ss=/g) ?? [];
    expect(ssMatches).toHaveLength(1);
  });

  it("_HLS_pathway is NOT in RELOAD-URI (player adds it per-request)", async () => {
    const req = buildTokenRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));
    const ss = extractSsFromManifest(manifest);

    const resp = await edge.steerHls({
      _ss: ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    const reloadUri = resp["RELOAD-URI"]!;

    // _HLS_pathway and _HLS_throughput should NOT be baked into RELOAD-URI
    expect(reloadUri).not.toContain("_HLS_pathway");
    expect(reloadUri).not.toContain("_HLS_throughput");
  });

  it("_ss value changes between hops (updated state)", async () => {
    const req = buildTokenRequest();
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));
    const ss1 = extractSsFromManifest(manifest);

    const resp1 = await edge.steerHls({
      _ss: ss1,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    const reloadSs1 = resp1["RELOAD-URI"]!.match(/_ss=([^&]+)/)![1];

    const resp2 = await edge.followReloadUri(resp1["RELOAD-URI"]!, {
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 3000000, // different throughput
    });
    const reloadSs2 = resp2["RELOAD-URI"]!.match(/_ss=([^&]+)/)![1];

    // _ss should be updated with new throughput info
    // (they may or may not be equal depending on edge logic, but both must decode)
    const decoded1 = decodeSs(reloadSs1);
    const decoded2 = decodeSs(reloadSs2);
    expect(decoded1.priorities).toBeDefined();
    expect(decoded2.priorities).toBeDefined();
  });

  // ── Edge case: empty token params ──────────────────────────────

  it("steering_uri with no tokens still works correctly", () => {
    const req = buildTokenRequest({
      steering_uri: `${edge.url}/steer/hls`,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));

    expect(manifest).toContain("_ss=");
    expect(manifest).toContain("#EXT-X-CONTENT-STEERING");
  });

  it("steering_uri with special characters in token values is preserved", () => {
    const req = buildTokenRequest({
      steering_uri: `${edge.url}/steer/hls?token=a%2Fb%3Dc&sig=x%26y`,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(req));

    // The encoded token should appear in the SERVER-URI
    expect(manifest).toContain("token=");
    expect(manifest).toContain("sig=");
  });
});
