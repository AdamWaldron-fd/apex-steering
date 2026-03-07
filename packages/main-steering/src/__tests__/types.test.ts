import { describe, it, expect } from "vitest";
import type {
  ControlCommand,
  SessionState,
} from "../types.js";
import { defaultSessionState } from "../types.js";

// ─── JSON compatibility with apex-edge-steering ─────────────────────────────
//
// These tests verify that our TypeScript types serialize to identical JSON
// as the Rust types in apex-edge-steering/src/types.rs. The edge server's
// serde deserialization is the contract — we must match it exactly.

describe("ControlCommand JSON compatibility", () => {
  it("set_priorities matches edge format", () => {
    // Exact JSON from apex-edge-steering/src/control.rs test fixture
    const json = `{
      "type": "set_priorities",
      "region": "us-east",
      "priorities": ["cdn-b", "cdn-a"],
      "generation": 42,
      "ttl_override": 15
    }`;
    const cmd: ControlCommand = JSON.parse(json);
    expect(cmd.type).toBe("set_priorities");
    if (cmd.type === "set_priorities") {
      expect(cmd.region).toBe("us-east");
      expect(cmd.priorities).toEqual(["cdn-b", "cdn-a"]);
      expect(cmd.generation).toBe(42);
      expect(cmd.ttl_override).toBe(15);
    }
  });

  it("exclude_pathway matches edge format", () => {
    const json = `{
      "type": "exclude_pathway",
      "region": null,
      "pathway": "cdn-c",
      "generation": 5
    }`;
    const cmd: ControlCommand = JSON.parse(json);
    expect(cmd.type).toBe("exclude_pathway");
    if (cmd.type === "exclude_pathway") {
      expect(cmd.region).toBeNull();
      expect(cmd.pathway).toBe("cdn-c");
      expect(cmd.generation).toBe(5);
    }
  });

  it("clear_overrides matches edge format", () => {
    const json = `{
      "type": "clear_overrides",
      "region": null,
      "generation": 10
    }`;
    const cmd: ControlCommand = JSON.parse(json);
    expect(cmd.type).toBe("clear_overrides");
    if (cmd.type === "clear_overrides") {
      expect(cmd.region).toBeNull();
      expect(cmd.generation).toBe(10);
    }
  });

  it("serialization roundtrip preserves all fields", () => {
    const cmd: ControlCommand = {
      type: "set_priorities",
      region: "eu-west",
      priorities: ["cdn-a", "cdn-b"],
      generation: 7,
      ttl_override: 30,
    };
    const json = JSON.stringify(cmd);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe("set_priorities");
    expect(parsed.region).toBe("eu-west");
    expect(parsed.generation).toBe(7);
    expect(parsed.ttl_override).toBe(30);
  });

  it("null region serializes correctly", () => {
    const cmd: ControlCommand = {
      type: "exclude_pathway",
      region: null,
      pathway: "cdn-a",
      generation: 1,
    };
    const json = JSON.stringify(cmd);
    const parsed = JSON.parse(json);
    expect(parsed.region).toBeNull();
  });
});

describe("SessionState JSON compatibility", () => {
  it("field names match edge format", () => {
    const state: SessionState = {
      priorities: ["cdn-a", "cdn-b"],
      throughput_map: [["cdn-a", 5_000_000]],
      min_bitrate: 783_322,
      max_bitrate: 4_530_860,
      duration: 596,
      position: 0,
      timestamp: 1700000000,
      override_gen: 0,
    };
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json);

    // Field names must match what edge's decode_state() expects
    expect(parsed.priorities).toEqual(["cdn-a", "cdn-b"]);
    // Rust Vec<(String, u64)> serializes as array of 2-element arrays
    expect(parsed.throughput_map).toEqual([["cdn-a", 5_000_000]]);
    expect(parsed.throughput_map[0]).toHaveLength(2);
    expect(parsed.min_bitrate).toBe(783_322);
    expect(parsed.max_bitrate).toBe(4_530_860);
    expect(parsed.duration).toBe(596);
    expect(parsed.position).toBe(0);
    expect(parsed.timestamp).toBe(1700000000);
    expect(parsed.override_gen).toBe(0);
  });

  it("empty state serializes with all fields present", () => {
    const state: SessionState = {
      priorities: [],
      throughput_map: [],
      min_bitrate: 0,
      max_bitrate: 0,
      duration: 0,
      position: 0,
      timestamp: 0,
      override_gen: 0,
    };
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json);
    expect(parsed.priorities).toEqual([]);
    expect(parsed.throughput_map).toEqual([]);
    expect(parsed.min_bitrate).toBe(0);
  });

  it("roundtrip preserves all fields", () => {
    const state: SessionState = {
      priorities: ["alpha", "beta"],
      throughput_map: [["alpha", 5_000_000], ["beta", 3_000_000]],
      min_bitrate: 500_000,
      max_bitrate: 8_000_000,
      duration: 3600,
      position: 120,
      timestamp: 1700000000,
      override_gen: 42,
    };
    const roundtripped: SessionState = JSON.parse(JSON.stringify(state));
    expect(roundtripped).toEqual(state);
  });
});

describe("defaultSessionState", () => {
  it("returns all fields zeroed", () => {
    const state = defaultSessionState();
    expect(state.priorities).toEqual([]);
    expect(state.throughput_map).toEqual([]);
    expect(state.min_bitrate).toBe(0);
    expect(state.max_bitrate).toBe(0);
    expect(state.duration).toBe(0);
    expect(state.position).toBe(0);
    expect(state.timestamp).toBe(0);
    expect(state.override_gen).toBe(0);
  });

  it("returns a new object each call (not shared reference)", () => {
    const a = defaultSessionState();
    const b = defaultSessionState();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.priorities.push("cdn-a");
    expect(b.priorities).toEqual([]);
  });

  it("serializes to valid JSON with all fields present", () => {
    const state = defaultSessionState();
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual([
      "duration", "max_bitrate", "min_bitrate", "override_gen",
      "position", "priorities", "throughput_map", "timestamp",
    ]);
  });
});

describe("ControlCommand edge cases", () => {
  it("set_priorities with empty priorities array serializes correctly", () => {
    const cmd: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: [],
      generation: 1,
      ttl_override: null,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.priorities).toEqual([]);
  });

  it("set_priorities with many priorities preserves order", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `cdn-${i}`);
    const cmd: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ids,
      generation: 1,
      ttl_override: null,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.priorities).toEqual(ids);
  });

  it("ttl_override of 0 is preserved (not coerced to null)", () => {
    const cmd: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ["cdn-a"],
      generation: 1,
      ttl_override: 0,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.ttl_override).toBe(0);
  });

  it("region with special characters roundtrips", () => {
    const cmd: ControlCommand = {
      type: "set_priorities",
      region: "ap-southeast-1",
      priorities: ["cdn-a"],
      generation: 1,
      ttl_override: null,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.region).toBe("ap-southeast-1");
  });

  it("large generation number serializes correctly", () => {
    const cmd: ControlCommand = {
      type: "clear_overrides",
      region: null,
      generation: Number.MAX_SAFE_INTEGER,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.generation).toBe(Number.MAX_SAFE_INTEGER);
  });
});
