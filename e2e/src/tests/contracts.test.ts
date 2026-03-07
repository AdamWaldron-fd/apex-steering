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
 * Contract-driven priority verification.
 *
 * Tests that apex-main-steering returns priorities influenced by CDN contracts
 * and COGS, that manifest-updater encodes those priorities into _ss, and that
 * edge-steering honours them in PATHWAY-PRIORITY responses.
 */
describe("Contract-Driven Priorities", () => {
  const STEERING_URI = `${edge.url}/steer/hls`;

  beforeEach(async () => {
    await edge.reset();
    await main.clear();
  });

  // ── Session init returns contract-influenced priorities ────────

  it("session init with cdn-a,cdn-b returns priorities in contract weight order", async () => {
    const resp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    // cdn-a has higher weight (60) than cdn-b (40) in providers.json
    expect(resp.session_state.priorities).toEqual(["cdn-a", "cdn-b"]);
  });

  it("session init with cdn-b,cdn-a still returns contract-weighted order", async () => {
    const resp = await main.sessionInit({
      cdns: "cdn-b,cdn-a",
      steering_uri: STEERING_URI,
    });
    // Main steering should sort by contract weight, not request order
    expect(resp.session_state.priorities[0]).toBe("cdn-a");
  });

  it("single CDN returns it as sole priority", async () => {
    const resp = await main.sessionInit({
      cdns: "cdn-a",
      steering_uri: STEERING_URI,
    });
    expect(resp.session_state.priorities).toEqual(["cdn-a"]);
    expect(resp.pathways).toHaveLength(1);
  });

  it("pathways ordered by priority (first pathway = highest priority)", async () => {
    const resp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    expect(resp.pathways[0].pathway_id).toBe(resp.session_state.priorities[0]);
  });

  // ── Manifest carries contract priorities into _ss ─────────────

  it("_ss in transformed manifest encodes contract priorities", async () => {
    const initResp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    const ss = extractSsFromManifest(manifest);
    const decoded = decodeSs(ss);
    expect(decoded.priorities).toEqual(["cdn-a", "cdn-b"]);
  });

  it("manifest PATHWAY-ID for default pathway matches top priority", async () => {
    const initResp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    // The #EXT-X-CONTENT-STEERING tag should have PATHWAY-ID matching top priority
    const steeringLine = manifest
      .split("\n")
      .find((l) => l.includes("#EXT-X-CONTENT-STEERING"));
    expect(steeringLine).toBeDefined();
    expect(steeringLine).toContain(`PATHWAY-ID="${initResp.session_state.priorities[0]}"`);
  });

  // ── Edge honours contract priorities from _ss ─────────────────

  it("edge steering returns contract-weighted PATHWAY-PRIORITY from _ss", async () => {
    const initResp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    const ss = extractSsFromManifest(manifest);

    const steerResp = await edge.steerHls({ _ss: ss });
    expect(steerResp["PATHWAY-PRIORITY"]).toEqual(["cdn-a", "cdn-b"]);
  });

  it("edge returns correct priorities even with player throughput report", async () => {
    const initResp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    const ss = extractSsFromManifest(manifest);

    const steerResp = await edge.steerHls({
      _ss: ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    // Healthy throughput should preserve contract order
    expect(steerResp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
  });

  // ── Override changes priorities, then clear restores ───────────

  it("setPriorities override replaces contract order on edge", async () => {
    const initResp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    const ss = extractSsFromManifest(manifest);

    await main.setPriorities({
      region: null,
      priorities: ["cdn-b", "cdn-a"],
    });
    await new Promise((r) => setTimeout(r, 200));

    const steerResp = await edge.steerHls({
      _ss: ss,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    expect(steerResp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-b");
  });

  it("clear restores contract-weighted priorities", async () => {
    const initResp = await main.sessionInit({
      cdns: "cdn-a,cdn-b",
      steering_uri: STEERING_URI,
    });
    const manifest = updateManifest(sampleHls(), JSON.stringify(initResp));
    const ss = extractSsFromManifest(manifest);

    // Override
    await main.setPriorities({
      region: null,
      priorities: ["cdn-b", "cdn-a"],
    });
    await new Promise((r) => setTimeout(r, 200));

    // Clear
    await main.clear();
    await new Promise((r) => setTimeout(r, 200));

    const steerResp = await edge.steerHls({ _ss: ss });
    // After clear, edge should return to _ss-encoded priorities (contract order)
    expect(steerResp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
  });
});
