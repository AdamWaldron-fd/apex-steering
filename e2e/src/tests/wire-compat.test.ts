import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { edge, decodeSs, type SessionState } from "../helpers/api";
import { encodeState as wasmEncodeState } from "../helpers/manifest-bridge";

describe("Wire Compatibility", () => {
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

  let edgeEncoded: string;
  let wasmEncoded: string;

  beforeEach(async () => {
    await edge.reset();
  });

  beforeAll(async () => {
    edgeEncoded = await edge.storeInitialState(state);
    wasmEncoded = wasmEncodeState(JSON.stringify(state));
  });

  // ── Encoding identity ──────────────────────────────────────────

  it("edge and manifest-updater produce identical base64", () => {
    expect(edgeEncoded).toBe(wasmEncoded);
  });

  it("base64 is URL-safe — no +, /, or = characters", () => {
    expect(edgeEncoded).not.toContain("+");
    expect(edgeEncoded).not.toContain("/");
    expect(edgeEncoded).not.toContain("=");
  });

  it("encoded string is non-empty and reasonably sized", () => {
    expect(edgeEncoded.length).toBeGreaterThan(10);
    expect(wasmEncoded.length).toBeGreaterThan(10);
  });

  // ── Decoded field structure ────────────────────────────────────

  it("decodes to exactly 8 fields", () => {
    const decoded = decodeSs(edgeEncoded);
    expect(Object.keys(decoded)).toHaveLength(8);
  });

  it("decodes to the correct field set", () => {
    const decoded = decodeSs(edgeEncoded);
    expect(Object.keys(decoded).sort()).toEqual([
      "duration",
      "max_bitrate",
      "min_bitrate",
      "override_gen",
      "position",
      "priorities",
      "throughput_map",
      "timestamp",
    ]);
  });

  // ── Field value roundtrips ─────────────────────────────────────

  it("priorities roundtrip correctly", () => {
    const decoded = decodeSs(edgeEncoded);
    expect(decoded.priorities).toEqual(["cdn-a", "cdn-b"]);
  });

  it("throughput_map serializes as tuple array", () => {
    const decoded = decodeSs(edgeEncoded);
    expect(decoded.throughput_map).toEqual([["cdn-a", 5000000]]);
  });

  it("integer fields are numbers (not strings)", () => {
    const decoded = decodeSs(edgeEncoded);
    expect(typeof decoded.min_bitrate).toBe("number");
    expect(typeof decoded.max_bitrate).toBe("number");
    expect(typeof decoded.duration).toBe("number");
    expect(typeof decoded.position).toBe("number");
    expect(typeof decoded.timestamp).toBe("number");
    expect(typeof decoded.override_gen).toBe("number");
  });

  it("min_bitrate roundtrips to exact value", () => {
    const decoded = decodeSs(wasmEncoded);
    expect(decoded.min_bitrate).toBe(783322);
  });

  it("max_bitrate roundtrips to exact value", () => {
    const decoded = decodeSs(wasmEncoded);
    expect(decoded.max_bitrate).toBe(4530860);
  });

  it("timestamp roundtrips to exact value", () => {
    const decoded = decodeSs(wasmEncoded);
    expect(decoded.timestamp).toBe(1709654400);
  });

  // ── Edge can decode _ss from manifest-updater ──────────────────

  it("edge steering correctly decodes _ss from manifest-updater", async () => {
    const resp = await edge.steerHls({
      _ss: wasmEncoded,
      _HLS_pathway: "cdn-a",
      _HLS_throughput: 5000000,
    });
    expect(resp.VERSION).toBe(1);
    expect(resp["PATHWAY-PRIORITY"]?.[0]).toBe("cdn-a");
    expect(resp["PATHWAY-PRIORITY"]?.[1]).toBe("cdn-b");
  });

  it("edge steering returns RELOAD-URI with _ss when given manifest-updater encoding", async () => {
    const resp = await edge.steerHls({ _ss: wasmEncoded });
    expect(resp["RELOAD-URI"]).toContain("_ss=");
  });

  // ── Edge cases ─────────────────────────────────────────────────

  it("empty throughput_map roundtrips correctly", () => {
    const emptyState: SessionState = {
      ...state,
      throughput_map: [],
    };
    const encoded = wasmEncodeState(JSON.stringify(emptyState));
    const decoded = decodeSs(encoded);
    expect(decoded.throughput_map).toEqual([]);
  });

  it("multiple CDNs in throughput_map roundtrip correctly", () => {
    const multiState: SessionState = {
      ...state,
      throughput_map: [
        ["cdn-a", 5000000],
        ["cdn-b", 3000000],
      ],
    };
    const encoded = wasmEncodeState(JSON.stringify(multiState));
    const decoded = decodeSs(encoded);
    expect(decoded.throughput_map).toEqual([
      ["cdn-a", 5000000],
      ["cdn-b", 3000000],
    ]);
  });

  it("three CDN priorities roundtrip correctly", () => {
    const triState: SessionState = {
      ...state,
      priorities: ["cdn-a", "cdn-b", "cdn-c"],
    };
    const encoded = wasmEncodeState(JSON.stringify(triState));
    const decoded = decodeSs(encoded);
    expect(decoded.priorities).toEqual(["cdn-a", "cdn-b", "cdn-c"]);
  });
});
