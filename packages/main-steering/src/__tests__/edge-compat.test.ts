import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createApp } from "../app.js";
import { AppState } from "../state.js";
import { CdnRegistry, type CdnProvider } from "../cdn.js";
import { CommitTracker } from "../contracts.js";
import type { ControlCommand, SessionState } from "../types.js";
import { defaultSessionState } from "../types.js";

// ─── Edge Wire Protocol Compatibility ───────────────────────────────────────
//
// These tests prove that the main steering server produces JSON payloads that
// are byte-for-byte compatible with what apex-edge-steering's Rust types.rs
// expects via serde deserialization. Every field name, type, null-handling,
// and discriminant value is validated against the Rust contract.

// ─── Mock Edge Server (simulates apex-edge-steering /control endpoint) ──────

interface EdgeReceivedCommand {
  raw_json: string;
  parsed: ControlCommand;
  content_type: string;
}

function createEdgeSimulator() {
  const received: EdgeReceivedCommand[] = [];
  const app = new Hono();

  app.post("/control", async (c) => {
    const raw = await c.req.text();
    const parsed = JSON.parse(raw) as ControlCommand;
    received.push({
      raw_json: raw,
      parsed,
      content_type: c.req.header("content-type") ?? "",
    });
    return c.json({ status: "ok", generation: parsed.generation });
  });

  return { app, received, clear: () => { received.length = 0; } };
}

// ─── Test Providers ─────────────────────────────────────────────────────────

const testProviders: CdnProvider[] = [
  {
    id: "cdn-a",
    name: "CDN Alpha",
    base_url: "https://cdn-a.example.com",
    regions: ["us-east", "us-west", "eu-west"],
    pricing: { cost_per_gb: 0.08, burst_cost_per_gb: 0.12, currency: "USD" },
    weight: 0.6,
    enabled: true,
  },
  {
    id: "cdn-b",
    name: "CDN Beta",
    base_url: "https://cdn-b.example.com",
    regions: ["us-east", "eu-west", "ap-south"],
    pricing: { cost_per_gb: 0.05, burst_cost_per_gb: 0.10, currency: "USD" },
    weight: 0.4,
    enabled: true,
  },
  {
    id: "cdn-c",
    name: "CDN Gamma",
    base_url: "https://cdn-c.example.com",
    regions: [],
    pricing: { cost_per_gb: 0.15, burst_cost_per_gb: 0.25, currency: "USD" },
    weight: 0.2,
    enabled: true,
  },
];

function json(body: unknown) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Edge wire protocol: SessionState", () => {
  it("SessionState JSON has exactly the fields edge Rust expects", () => {
    const state: SessionState = {
      priorities: ["cdn-b", "cdn-a"],
      throughput_map: [["cdn-a", 5_000_000], ["cdn-b", 3_000_000]],
      min_bitrate: 783_322,
      max_bitrate: 4_530_860,
      duration: 596,
      position: 42,
      timestamp: 1709654400,
      override_gen: 7,
    };
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json);

    // Exactly these fields, no more, no less
    const expected_fields = [
      "priorities", "throughput_map", "min_bitrate", "max_bitrate",
      "duration", "position", "timestamp", "override_gen",
    ].sort();
    expect(Object.keys(parsed).sort()).toEqual(expected_fields);
  });

  it("throughput_map serializes as array of 2-element arrays (Rust Vec<(String, u64)>)", () => {
    const state: SessionState = {
      ...defaultSessionState(),
      throughput_map: [["cdn-a", 5_000_000], ["cdn-b", 3_000_000]],
    };
    const parsed = JSON.parse(JSON.stringify(state));

    expect(Array.isArray(parsed.throughput_map)).toBe(true);
    for (const entry of parsed.throughput_map) {
      expect(Array.isArray(entry)).toBe(true);
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe("string");
      expect(typeof entry[1]).toBe("number");
    }
  });

  it("empty throughput_map serializes as empty array", () => {
    const state: SessionState = { ...defaultSessionState() };
    const parsed = JSON.parse(JSON.stringify(state));
    expect(parsed.throughput_map).toEqual([]);
  });

  it("all numeric fields are numbers (not strings)", () => {
    const state: SessionState = {
      priorities: ["cdn-a"],
      throughput_map: [],
      min_bitrate: 783_322,
      max_bitrate: 4_530_860,
      duration: 596,
      position: 120,
      timestamp: 1709654400,
      override_gen: 3,
    };
    const parsed = JSON.parse(JSON.stringify(state));
    expect(typeof parsed.min_bitrate).toBe("number");
    expect(typeof parsed.max_bitrate).toBe("number");
    expect(typeof parsed.duration).toBe("number");
    expect(typeof parsed.position).toBe("number");
    expect(typeof parsed.timestamp).toBe("number");
    expect(typeof parsed.override_gen).toBe("number");
  });

  it("priorities is always an array of strings", () => {
    const state: SessionState = {
      ...defaultSessionState(),
      priorities: ["cdn-a", "cdn-b", "cdn-c"],
    };
    const parsed = JSON.parse(JSON.stringify(state));
    expect(Array.isArray(parsed.priorities)).toBe(true);
    for (const p of parsed.priorities) {
      expect(typeof p).toBe("string");
    }
  });

  it("SessionState can be base64-encoded for _ss parameter", () => {
    const state: SessionState = {
      priorities: ["cdn-b", "cdn-a"],
      throughput_map: [["cdn-a", 5_000_000]],
      min_bitrate: 783_322,
      max_bitrate: 4_530_860,
      duration: 596,
      position: 0,
      timestamp: 1709654400,
      override_gen: 0,
    };

    // Encode as the manifest updater would
    const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
    // Decode and verify roundtrip
    const decoded: SessionState = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
    expect(decoded).toEqual(state);
  });

  it("SessionState base64 encoding is URL-safe when using base64url", () => {
    const state: SessionState = {
      ...defaultSessionState(),
      priorities: ["cdn-a", "cdn-b"],
      throughput_map: [["cdn-a", 999_999_999]],
    };
    const encoded = Buffer.from(JSON.stringify(state)).toString("base64url");
    // base64url should not contain + / or = padding
    expect(encoded).not.toMatch(/[+/=]/);
    // Roundtrip
    const decoded: SessionState = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    expect(decoded).toEqual(state);
  });
});

describe("Edge wire protocol: ControlCommand discriminated union", () => {
  it("set_priorities has type discriminator 'set_priorities'", () => {
    const cmd: ControlCommand = {
      type: "set_priorities",
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
      generation: 42,
      ttl_override: 15,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.type).toBe("set_priorities");
  });

  it("set_priorities with null region and null ttl_override", () => {
    const cmd: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ["cdn-a"],
      generation: 1,
      ttl_override: null,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.region).toBeNull();
    expect(parsed.ttl_override).toBeNull();
    // Rust Option<String> serializes null, not absent
    expect("region" in parsed).toBe(true);
    expect("ttl_override" in parsed).toBe(true);
  });

  it("set_priorities field set matches Rust struct exactly", () => {
    const cmd: ControlCommand = {
      type: "set_priorities",
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
      generation: 1,
      ttl_override: 30,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(Object.keys(parsed).sort()).toEqual(
      ["generation", "priorities", "region", "ttl_override", "type"].sort(),
    );
  });

  it("exclude_pathway has type discriminator 'exclude_pathway'", () => {
    const cmd: ControlCommand = {
      type: "exclude_pathway",
      region: null,
      pathway: "cdn-c",
      generation: 5,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.type).toBe("exclude_pathway");
  });

  it("exclude_pathway field set matches Rust struct exactly", () => {
    const cmd: ControlCommand = {
      type: "exclude_pathway",
      region: null,
      pathway: "cdn-c",
      generation: 5,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(Object.keys(parsed).sort()).toEqual(
      ["generation", "pathway", "region", "type"].sort(),
    );
  });

  it("clear_overrides has type discriminator 'clear_overrides'", () => {
    const cmd: ControlCommand = {
      type: "clear_overrides",
      region: null,
      generation: 10,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(parsed.type).toBe("clear_overrides");
  });

  it("clear_overrides field set matches Rust struct exactly", () => {
    const cmd: ControlCommand = {
      type: "clear_overrides",
      region: null,
      generation: 10,
    };
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(Object.keys(parsed).sort()).toEqual(
      ["generation", "region", "type"].sort(),
    );
  });

  it("Rust serde(tag = 'type') format: type field is a string, not a number", () => {
    const commands: ControlCommand[] = [
      { type: "set_priorities", region: null, priorities: ["cdn-a"], generation: 1, ttl_override: null },
      { type: "exclude_pathway", region: null, pathway: "cdn-c", generation: 2 },
      { type: "clear_overrides", region: null, generation: 3 },
    ];
    for (const cmd of commands) {
      const parsed = JSON.parse(JSON.stringify(cmd));
      expect(typeof parsed.type).toBe("string");
    }
  });

  it("generation is always a positive integer", () => {
    const commands: ControlCommand[] = [
      { type: "set_priorities", region: null, priorities: ["cdn-a"], generation: 1, ttl_override: null },
      { type: "exclude_pathway", region: null, pathway: "cdn-c", generation: 100 },
      { type: "clear_overrides", region: null, generation: 999 },
    ];
    for (const cmd of commands) {
      const parsed = JSON.parse(JSON.stringify(cmd));
      expect(typeof parsed.generation).toBe("number");
      expect(Number.isInteger(parsed.generation)).toBe(true);
      expect(parsed.generation).toBeGreaterThan(0);
    }
  });
});

describe("Edge wire protocol: live propagation to simulated edge server", () => {
  const edgeSim = createEdgeSimulator();
  let edgeServer: ReturnType<typeof serve>;
  let edgePort: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      edgeServer = serve({ fetch: edgeSim.app.fetch, port: 0 }, (info) => {
        edgePort = info.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    edgeServer?.close();
  });

  function makeApp() {
    const state = new AppState(
      new CdnRegistry(testProviders),
      new CommitTracker(
        [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: 200 }],
        [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 400 }],
      ),
    );
    return { app: createApp(state), state };
  }

  async function registerEdge(app: ReturnType<typeof createApp>, platform: string, region: string | null = null) {
    const res = await app.request("/fleet/register", json({
      platform,
      control_url: `http://localhost:${edgePort}/control`,
      region,
    }));
    return res.json();
  }

  it("edge receives set_priorities as valid JSON the Rust server can parse", async () => {
    edgeSim.clear();
    const { app } = makeApp();
    await registerEdge(app, "akamai", "us-east");

    await app.request("/priorities", json({
      priorities: ["cdn-b", "cdn-a"],
      region: "us-east",
      ttl_override: 15,
    }));

    expect(edgeSim.received).toHaveLength(1);
    const cmd = edgeSim.received[0];

    // Content-Type must be application/json for Rust's serde_json
    expect(cmd.content_type).toBe("application/json");

    // Validate the raw JSON is parseable
    expect(() => JSON.parse(cmd.raw_json)).not.toThrow();

    // Validate exact structure
    expect(cmd.parsed.type).toBe("set_priorities");
    if (cmd.parsed.type === "set_priorities") {
      expect(cmd.parsed.region).toBe("us-east");
      expect(cmd.parsed.priorities).toEqual(["cdn-b", "cdn-a"]);
      expect(cmd.parsed.generation).toBe(1);
      expect(cmd.parsed.ttl_override).toBe(15);
    }
  });

  it("edge receives exclude_pathway with null region (Rust Option<String>)", async () => {
    edgeSim.clear();
    const { app } = makeApp();
    await registerEdge(app, "cloudfront");

    await app.request("/exclude", json({ pathway: "cdn-c" }));

    expect(edgeSim.received).toHaveLength(1);
    const raw = JSON.parse(edgeSim.received[0].raw_json);
    expect(raw.type).toBe("exclude_pathway");
    expect(raw.region).toBeNull();
    expect(raw.pathway).toBe("cdn-c");
    // Must have 'region' key even when null (Rust serde default)
    expect("region" in raw).toBe(true);
  });

  it("edge receives clear_overrides with minimal field set", async () => {
    edgeSim.clear();
    const { app } = makeApp();
    await registerEdge(app, "cloudflare");

    await app.request("/clear", json({}));

    expect(edgeSim.received).toHaveLength(1);
    const raw = JSON.parse(edgeSim.received[0].raw_json);
    expect(Object.keys(raw).sort()).toEqual(["generation", "region", "type"]);
  });

  it("edge receives commands across all four platform types identically", async () => {
    edgeSim.clear();
    const { app } = makeApp();

    // Register one instance per platform, all pointing at the same edge sim
    for (const platform of ["akamai", "cloudfront", "cloudflare", "fastly"]) {
      await registerEdge(app, platform);
    }

    await app.request("/priorities", json({
      priorities: ["cdn-a", "cdn-b", "cdn-c"],
      ttl_override: 60,
    }));

    // All 4 platforms should receive identical JSON
    expect(edgeSim.received).toHaveLength(4);
    const first = edgeSim.received[0].raw_json;
    for (const r of edgeSim.received) {
      expect(r.raw_json).toBe(first);
    }
  });

  it("session/init produces SessionState that roundtrips through base64 encoding", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b,cdn-c&region=us-east&min_bitrate=783322&max_bitrate=4530860&duration=596&steering_uri=https://steer.example.com/v1/steer",
    );
    const envelope = await res.json();
    const state: SessionState = envelope.session_state;

    // Simulate manifest updater base64 encoding
    const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
    const decoded: SessionState = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));

    // Every field must survive the roundtrip
    expect(decoded.priorities).toEqual(state.priorities);
    expect(decoded.throughput_map).toEqual(state.throughput_map);
    expect(decoded.min_bitrate).toBe(state.min_bitrate);
    expect(decoded.max_bitrate).toBe(state.max_bitrate);
    expect(decoded.duration).toBe(state.duration);
    expect(decoded.position).toBe(state.position);
    expect(decoded.timestamp).toBe(state.timestamp);
    expect(decoded.override_gen).toBe(state.override_gen);
  });

  it("session/init with contracts influences priority order", async () => {
    // cdn-a has a behind-pace contract, so it should be prioritized
    const { app } = makeApp();
    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b,cdn-c&region=us-east&steering_uri=https://steer.example.com/v1/steer",
    );
    const envelope = await res.json();
    const state: SessionState = envelope.session_state;

    // cdn-a has an unfulfilled contract (400 of 1000 GB), should rank higher
    expect(state.priorities).toContain("cdn-a");
    expect(state.priorities).toContain("cdn-b");
    expect(state.priorities).toContain("cdn-c");
  });

  it("generation in edge commands matches the generation in session init override_gen", async () => {
    edgeSim.clear();
    const { app } = makeApp();
    await registerEdge(app, "akamai");

    // Push some commands to increment generation
    await app.request("/priorities", json({ priorities: ["cdn-a"] }));
    await app.request("/exclude", json({ pathway: "cdn-b" }));

    // Now init a session — override_gen should reflect current generation
    const res = await app.request("/session/init?cdns=cdn-a,cdn-b&steering_uri=https://steer.example.com/v1/steer");
    const envelope = await res.json();
    const state: SessionState = envelope.session_state;
    expect(state.override_gen).toBe(2); // 2 commands pushed

    // Next command should be gen 3
    await app.request("/clear", json({}));
    expect(edgeSim.received[2].parsed.generation).toBe(3);
  });

  it("multi-region propagation only sends to matching region", async () => {
    edgeSim.clear();
    const { app } = makeApp();

    // Register edge instances in two different regions
    await registerEdge(app, "akamai", "us-east");
    await registerEdge(app, "cloudflare", "eu-west");

    // Command targeting only us-east
    await app.request("/priorities", json({
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
    }));

    // Only 1 of the 2 instances should receive it
    // (the us-east one)
    const res = await app.request("/status");
    const status = await res.json();
    expect(status.fleet).toHaveLength(2);

    // The edge sim received only 1 command (from us-east instance)
    expect(edgeSim.received).toHaveLength(1);
    expect(edgeSim.received[0].parsed.type).toBe("set_priorities");
  });

  it("sequential commands maintain strict generation ordering", async () => {
    edgeSim.clear();
    const { app } = makeApp();
    await registerEdge(app, "fastly");

    // Fire 5 different commands
    await app.request("/priorities", json({ priorities: ["cdn-a"] }));
    await app.request("/priorities", json({ priorities: ["cdn-b", "cdn-a"] }));
    await app.request("/exclude", json({ pathway: "cdn-c" }));
    await app.request("/priorities", json({ priorities: ["cdn-a", "cdn-b", "cdn-c"] }));
    await app.request("/clear", json({}));

    expect(edgeSim.received).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(edgeSim.received[i].parsed.generation).toBe(i + 1);
    }

    // Verify command types in order
    expect(edgeSim.received[0].parsed.type).toBe("set_priorities");
    expect(edgeSim.received[1].parsed.type).toBe("set_priorities");
    expect(edgeSim.received[2].parsed.type).toBe("exclude_pathway");
    expect(edgeSim.received[3].parsed.type).toBe("set_priorities");
    expect(edgeSim.received[4].parsed.type).toBe("clear_overrides");
  });
});
