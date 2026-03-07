import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createApp } from "../app.js";
import { AppState } from "../state.js";
import { CdnRegistry, type CdnProvider } from "../cdn.js";
import { CommitTracker } from "../contracts.js";
import type { ControlCommand } from "../types.js";

// ─── Mock Edge Server ────────────────────────────────────────────────────────

interface ReceivedCommand {
  body: ControlCommand;
}

function createMockEdge() {
  const received: ReceivedCommand[] = [];
  const app = new Hono();
  app.post("/control", async (c) => {
    const body = await c.req.json<ControlCommand>();
    received.push({ body });
    return c.json({ status: "ok" });
  });
  return { app, received, clear: () => { received.length = 0; } };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const testProviders: CdnProvider[] = [
  {
    id: "cdn-a",
    name: "CDN Alpha",
    base_url: "https://cdn-a.example.com",
    regions: ["us-east", "us-west"],
    pricing: { cost_per_gb: 0.08, burst_cost_per_gb: 0.12, currency: "USD" },
    weight: 0.6,
    enabled: true,
  },
  {
    id: "cdn-b",
    name: "CDN Beta",
    base_url: "https://cdn-b.example.com",
    regions: ["us-east", "eu-west"],
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

// ─── Integration Tests ───────────────────────────────────────────────────────

describe("Full integration: master → edge propagation", () => {
  const mockEdge1 = createMockEdge();
  const mockEdge2 = createMockEdge();
  let edgeServer1: ReturnType<typeof serve>;
  let edgeServer2: ReturnType<typeof serve>;
  let edgePort1: number;
  let edgePort2: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      edgeServer1 = serve({ fetch: mockEdge1.app.fetch, port: 0 }, (info) => {
        edgePort1 = info.port;
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      edgeServer2 = serve({ fetch: mockEdge2.app.fetch, port: 0 }, (info) => {
        edgePort2 = info.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    edgeServer1?.close();
    edgeServer2?.close();
  });

  function makeTestApp() {
    const state = new AppState(
      new CdnRegistry(testProviders),
      new CommitTracker(),
    );
    return { app: createApp(state), state };
  }

  async function registerEdge(
    app: ReturnType<typeof createApp>,
    platform: string,
    port: number,
    region: string | null = null,
  ) {
    const res = await app.request("/fleet/register", json({
      platform,
      control_url: `http://localhost:${port}/control`,
      region,
    }));
    return res.json();
  }

  // ─── Session Init ────────────────────────────────────────────────────

  it("session init returns edge-compatible ManifestUpdateRequest JSON", async () => {
    const { app } = makeTestApp();
    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b&min_bitrate=783322&max_bitrate=4530860&duration=596&steering_uri=https://steer.example.com/v1/steer",
    );
    const body = await res.json();

    // Verify ManifestUpdateRequest envelope
    expect(body).toHaveProperty("session_state");
    expect(body).toHaveProperty("pathways");
    expect(body).toHaveProperty("steering_uri");

    // Verify all SessionState fields the edge server expects
    expect(body.session_state).toHaveProperty("priorities");
    expect(body.session_state).toHaveProperty("throughput_map");
    expect(body.session_state).toHaveProperty("min_bitrate");
    expect(body.session_state).toHaveProperty("max_bitrate");
    expect(body.session_state).toHaveProperty("duration");
    expect(body.session_state).toHaveProperty("position");
    expect(body.session_state).toHaveProperty("timestamp");
    expect(body.session_state).toHaveProperty("override_gen");

    // throughput_map must be an array of tuples (edge Rust expects Vec<(String, u64)>)
    expect(Array.isArray(body.session_state.throughput_map)).toBe(true);

    // pathways must have base_url for each CDN
    expect(body.pathways).toHaveLength(2);
    for (const p of body.pathways) {
      expect(p).toHaveProperty("pathway_id");
      expect(p).toHaveProperty("base_url");
    }
  });

  it("session init with region only includes region-available CDNs in priority calc", async () => {
    const { app } = makeTestApp();
    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b,cdn-c&region=eu-west&steering_uri=https://steer.example.com/v1/steer",
    );
    const body = await res.json();
    // All 3 CDNs should be in priorities (cdn-c is global)
    expect(body.session_state.priorities).toHaveLength(3);
  });

  it("session init with unknown CDNs falls back to input order", async () => {
    const { app } = makeTestApp();
    const res = await app.request(
      "/session/init?cdns=unknown-x,unknown-y&steering_uri=https://steer.example.com/v1/steer",
    );
    const body = await res.json();
    expect(body.session_state.priorities).toEqual(["unknown-x", "unknown-y"]);
  });

  it("session init without optional params defaults to 0", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/session/init?cdns=cdn-a&steering_uri=https://steer.example.com/v1/steer");
    const body = await res.json();
    expect(body.session_state.min_bitrate).toBe(0);
    expect(body.session_state.max_bitrate).toBe(0);
    expect(body.session_state.duration).toBe(0);
  });

  // ─── Fleet registration across all 4 platforms ──────────────────────

  it("registers all four edge platform types", async () => {
    const { app, state } = makeTestApp();

    for (const platform of ["akamai", "cloudfront", "cloudflare", "fastly"]) {
      const res = await app.request("/fleet/register", json({
        platform,
        control_url: `https://${platform}-edge.example.com/control`,
        region: "us-east",
      }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.platform).toBe(platform);
    }

    expect(state.fleet.instances).toHaveLength(4);
  });

  it("rejects case-insensitive invalid platform", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/fleet/register", json({
      platform: "azure",
      control_url: "https://example.com/control",
    }));
    expect(res.status).toBe(400);
  });

  it("accepts case-insensitive platform names", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/fleet/register", json({
      platform: "CloudFront",
      control_url: "https://example.com/control",
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.platform).toBe("cloudfront");
  });

  it("fleet register without region sets null", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/fleet/register", json({
      platform: "akamai",
      control_url: "https://example.com/control",
    }));
    const body = await res.json();
    expect(body.region).toBeNull();
  });

  // ─── End-to-end: set priorities → verify edge received ──────────────

  it("set_priorities propagates to registered edge instances", async () => {
    mockEdge1.clear();
    mockEdge2.clear();
    const { app } = makeTestApp();

    // Register two edge instances on different platforms
    await registerEdge(app, "akamai", edgePort1, "us-east");
    await registerEdge(app, "cloudflare", edgePort2, "us-east");

    // Push priorities
    const res = await app.request("/priorities", json({
      priorities: ["cdn-b", "cdn-a"],
      ttl_override: 15,
    }));
    const body = await res.json();
    expect(body.generation).toBe(1);
    expect(body.propagated).toBe(2);
    expect(body.failed).toBe(0);

    // Verify both edges received the command
    expect(mockEdge1.received).toHaveLength(1);
    expect(mockEdge1.received[0].body).toEqual({
      type: "set_priorities",
      region: null,
      priorities: ["cdn-b", "cdn-a"],
      generation: 1,
      ttl_override: 15,
    });
    expect(mockEdge2.received[0].body).toEqual(mockEdge1.received[0].body);
  });

  it("exclude_pathway propagates with correct JSON", async () => {
    mockEdge1.clear();
    const { app } = makeTestApp();
    await registerEdge(app, "fastly", edgePort1);

    const res = await app.request("/exclude", json({
      pathway: "cdn-c",
    }));
    const body = await res.json();
    expect(body.propagated).toBe(1);

    expect(mockEdge1.received[0].body).toEqual({
      type: "exclude_pathway",
      region: null,
      pathway: "cdn-c",
      generation: 1,
    });
  });

  it("clear_overrides propagates with correct JSON", async () => {
    mockEdge1.clear();
    const { app } = makeTestApp();
    await registerEdge(app, "cloudfront", edgePort1);

    // First set something, then clear
    await app.request("/priorities", json({ priorities: ["cdn-a"] }));

    const res = await app.request("/clear", json({}));
    const body = await res.json();
    expect(body.generation).toBe(2);
    expect(body.propagated).toBe(1);

    expect(mockEdge1.received[1].body).toEqual({
      type: "clear_overrides",
      region: null,
      generation: 2,
    });
  });

  // ─── Region-scoped commands ─────────────────────────────────────────

  it("region-scoped priorities only target matching edge instances", async () => {
    mockEdge1.clear();
    mockEdge2.clear();
    const { app } = makeTestApp();

    await registerEdge(app, "akamai", edgePort1, "us-east");
    await registerEdge(app, "cloudflare", edgePort2, "eu-west");

    const res = await app.request("/priorities", json({
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
    }));
    const body = await res.json();
    expect(body.propagated).toBe(1); // Only us-east edge

    expect(mockEdge1.received).toHaveLength(1);
    expect(mockEdge2.received).toHaveLength(0);
  });

  it("region-scoped exclude only targets matching edge instances", async () => {
    mockEdge1.clear();
    mockEdge2.clear();
    const { app } = makeTestApp();

    await registerEdge(app, "akamai", edgePort1, "us-east");
    await registerEdge(app, "cloudflare", edgePort2, "eu-west");

    await app.request("/exclude", json({
      region: "eu-west",
      pathway: "cdn-c",
    }));

    expect(mockEdge1.received).toHaveLength(0); // us-east not targeted
    expect(mockEdge2.received).toHaveLength(1);
  });

  // ─── Generation monotonicity ────────────────────────────────────────

  it("generation increases monotonically across mixed commands", async () => {
    mockEdge1.clear();
    const { app } = makeTestApp();
    await registerEdge(app, "akamai", edgePort1);

    await app.request("/priorities", json({ priorities: ["cdn-a"] }));
    await app.request("/exclude", json({ pathway: "cdn-b" }));
    await app.request("/priorities", json({ priorities: ["cdn-c"] }));
    await app.request("/clear", json({}));

    expect(mockEdge1.received).toHaveLength(4);
    expect(mockEdge1.received[0].body.generation).toBe(1);
    expect(mockEdge1.received[1].body.generation).toBe(2);
    expect(mockEdge1.received[2].body.generation).toBe(3);
    expect(mockEdge1.received[3].body.generation).toBe(4);
  });

  // ─── Status endpoint reflects state ─────────────────────────────────

  it("status reflects fleet and generation after operations", async () => {
    const { app } = makeTestApp();
    await registerEdge(app, "akamai", edgePort1, "us-east");
    await app.request("/priorities", json({ priorities: ["cdn-a"] }));
    await app.request("/exclude", json({ pathway: "cdn-b" }));

    const res = await app.request("/status");
    const body = await res.json();
    expect(body.generation).toBe(2);
    expect(body.fleet).toHaveLength(1);
    expect(body.fleet[0].platform).toBe("akamai");
    expect(body.cdn_providers).toHaveLength(3);
  });

  it("status/contracts returns contract data", async () => {
    const state = new AppState(
      new CdnRegistry(testProviders),
      new CommitTracker(
        [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null }],
        [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 500 }],
      ),
    );
    const app = createApp(state);
    const res = await app.request("/status/contracts");
    const body = await res.json();
    expect(body.contracts).toHaveLength(1);
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0].delivered_gb).toBe(500);
  });

  // ─── Health check ───────────────────────────────────────────────────

  it("health check reflects fleet size", async () => {
    const { app } = makeTestApp();
    await registerEdge(app, "akamai", edgePort1);
    await registerEdge(app, "cloudflare", edgePort2);

    const res = await app.request("/health");
    const body = await res.json();
    expect(body.fleet_size).toBe(2);
    expect(body.generation).toBe(0);
  });

  // ─── Fleet deregistration ──────────────────────────────────────────

  it("deregistered edge instance no longer receives commands", async () => {
    mockEdge1.clear();
    mockEdge2.clear();
    const { app } = makeTestApp();

    const reg1 = await registerEdge(app, "akamai", edgePort1);
    await registerEdge(app, "cloudflare", edgePort2);

    // Deregister first instance
    const delRes = await app.request(`/fleet/${reg1.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    // Push command — only edge2 should receive it
    await app.request("/priorities", json({ priorities: ["cdn-a"] }));
    expect(mockEdge1.received).toHaveLength(0);
    expect(mockEdge2.received).toHaveLength(1);
  });

  // ─── Edge JSON format validation ───────────────────────────────────

  it("propagated JSON matches exact edge-expected format", async () => {
    mockEdge1.clear();
    const { app } = makeTestApp();
    await registerEdge(app, "akamai", edgePort1, "us-east");

    await app.request("/priorities", json({
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
      ttl_override: 30,
    }));

    const received = mockEdge1.received[0].body;
    // These exact field names and values are what the edge Rust serde expects
    expect(received).toHaveProperty("type", "set_priorities");
    expect(received).toHaveProperty("region", "us-east");
    expect(received).toHaveProperty("priorities");
    expect(received).toHaveProperty("generation");
    expect(received).toHaveProperty("ttl_override", 30);
    // No extra fields
    expect(Object.keys(received).sort()).toEqual(
      ["generation", "priorities", "region", "ttl_override", "type"].sort(),
    );
  });

  it("exclude command JSON has exact edge-expected fields", async () => {
    mockEdge1.clear();
    const { app } = makeTestApp();
    await registerEdge(app, "akamai", edgePort1);

    await app.request("/exclude", json({ pathway: "cdn-c", region: null }));

    const received = mockEdge1.received[0].body;
    expect(Object.keys(received).sort()).toEqual(
      ["generation", "pathway", "region", "type"].sort(),
    );
  });

  it("clear command JSON has exact edge-expected fields", async () => {
    mockEdge1.clear();
    const { app } = makeTestApp();
    await registerEdge(app, "akamai", edgePort1);

    await app.request("/clear", json({ region: null }));

    const received = mockEdge1.received[0].body;
    expect(Object.keys(received).sort()).toEqual(
      ["generation", "region", "type"].sort(),
    );
  });

  // ─── Error handling ─────────────────────────────────────────────────

  it("empty cdns param returns 400", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/session/init?cdns=&steering_uri=https://steer.example.com/v1/steer");
    expect(res.status).toBe(400);
  });

  it("empty priorities array returns 400", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/priorities", json({ priorities: [] }));
    expect(res.status).toBe(400);
  });

  it("missing pathway in exclude returns 400", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/exclude", json({}));
    expect(res.status).toBe(400);
  });

  it("missing platform in fleet register returns 400", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/fleet/register", json({
      control_url: "https://example.com/control",
    }));
    expect(res.status).toBe(400);
  });

  it("missing control_url in fleet register returns 400", async () => {
    const { app } = makeTestApp();
    const res = await app.request("/fleet/register", json({
      platform: "akamai",
    }));
    expect(res.status).toBe(400);
  });

  // ─── Contract-aware session init ────────────────────────────────────

  it("session init prioritizes CDN with behind-pace contract", async () => {
    const state = new AppState(
      new CdnRegistry(testProviders),
      new CommitTracker(
        [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 5000, max_burst_gb: null }],
        [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", delivered_gb: 100 }],
      ),
    );
    const app = createApp(state);

    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b,cdn-c&steering_uri=https://steer.example.com/v1/steer",
    );
    const body = await res.json();
    // cdn-c has massive unfulfilled contract, should be prioritized first
    expect(body.session_state.priorities[0]).toBe("cdn-c");
  });

  it("session init with met contract does not boost CDN", async () => {
    const state = new AppState(
      new CdnRegistry(testProviders),
      new CommitTracker(
        [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 100, max_burst_gb: null }],
        [{ cdn_id: "cdn-c", period_start: "2026-03-01T00:00:00Z", delivered_gb: 200 }],
      ),
    );
    const app = createApp(state);

    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b,cdn-c&steering_uri=https://steer.example.com/v1/steer",
    );
    const body = await res.json();
    // cdn-c commit met, should not be first (it's most expensive)
    expect(body.session_state.priorities[0]).not.toBe("cdn-c");
  });

  // ─── Full lifecycle test ────────────────────────────────────────────

  it("full lifecycle: register → priorities → exclude → clear → deregister", async () => {
    mockEdge1.clear();
    const { app } = makeTestApp();

    // 1. Register an edge instance
    const regRes = await app.request("/fleet/register", json({
      platform: "akamai",
      control_url: `http://localhost:${edgePort1}/control`,
      region: "us-east",
    }));
    expect(regRes.status).toBe(201);
    const { id: instanceId } = await regRes.json();

    // 2. Verify health shows 1 fleet member
    const healthRes = await app.request("/health");
    const health = await healthRes.json();
    expect(health.fleet_size).toBe(1);

    // 3. Push priorities
    let res = await app.request("/priorities", json({
      priorities: ["cdn-b", "cdn-a"],
      ttl_override: 30,
    }));
    let body = await res.json();
    expect(body.generation).toBe(1);
    expect(body.propagated).toBe(1);

    // 4. Init a session (should reflect generation)
    res = await app.request("/session/init?cdns=cdn-a,cdn-b&min_bitrate=500000&max_bitrate=4000000&duration=3600&steering_uri=https://steer.example.com/v1/steer");
    body = await res.json();
    expect(body.session_state.override_gen).toBe(1);
    expect(body.session_state.min_bitrate).toBe(500000);

    // 5. Exclude a pathway
    res = await app.request("/exclude", json({ pathway: "cdn-c" }));
    body = await res.json();
    expect(body.generation).toBe(2);

    // 6. Clear overrides
    res = await app.request("/clear", json({}));
    body = await res.json();
    expect(body.generation).toBe(3);

    // 7. Check status reflects everything
    res = await app.request("/status");
    body = await res.json();
    expect(body.generation).toBe(3);
    expect(body.fleet).toHaveLength(1);

    // 8. Edge received all 3 commands with correct generations
    expect(mockEdge1.received).toHaveLength(3);
    expect(mockEdge1.received[0].body.generation).toBe(1);
    expect(mockEdge1.received[1].body.generation).toBe(2);
    expect(mockEdge1.received[2].body.generation).toBe(3);

    // 9. Deregister the edge instance
    res = await app.request(`/fleet/${instanceId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    // 10. Further commands propagate to 0 instances
    mockEdge1.clear();
    res = await app.request("/priorities", json({ priorities: ["cdn-a"] }));
    body = await res.json();
    expect(body.propagated).toBe(0);
    expect(mockEdge1.received).toHaveLength(0);
  });

  // ─── Multi-region fleet test ────────────────────────────────────────

  it("multi-region fleet: global command reaches all, scoped command reaches one", async () => {
    mockEdge1.clear();
    mockEdge2.clear();
    const { app } = makeTestApp();

    // Register two edge instances in different regions
    await registerEdge(app, "akamai", edgePort1, "us-east");
    await registerEdge(app, "cloudflare", edgePort2, "eu-west");

    // Global command (no region) reaches both
    let res = await app.request("/priorities", json({
      priorities: ["cdn-a", "cdn-b"],
    }));
    let body = await res.json();
    expect(body.propagated).toBe(2);
    expect(mockEdge1.received).toHaveLength(1);
    expect(mockEdge2.received).toHaveLength(1);

    // Scoped command reaches only us-east
    mockEdge1.clear();
    mockEdge2.clear();
    res = await app.request("/exclude", json({
      pathway: "cdn-c",
      region: "us-east",
    }));
    body = await res.json();
    expect(body.propagated).toBe(1);
    expect(mockEdge1.received).toHaveLength(1);
    expect(mockEdge2.received).toHaveLength(0);
  });

  // ─── SessionState field types match edge Rust ───────────────────────

  it("session/init response has correct ManifestUpdateRequest structure", async () => {
    const { app } = makeTestApp();
    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b&min_bitrate=100&max_bitrate=200&duration=30&steering_uri=https://steer.example.com/v1/steer",
    );
    const body = await res.json();
    const expectedTopFields = ["session_state", "pathways", "steering_uri"].sort();
    expect(Object.keys(body).sort()).toEqual(expectedTopFields);

    const expectedStateFields = [
      "priorities", "throughput_map", "min_bitrate", "max_bitrate",
      "duration", "position", "timestamp", "override_gen",
    ].sort();
    expect(Object.keys(body.session_state).sort()).toEqual(expectedStateFields);
  });

  // ─── Propagation result structure ───────────────────────────────────

  it("propagation result has generation, propagated, failed, failures fields", async () => {
    mockEdge1.clear();
    const { app } = makeTestApp();
    await registerEdge(app, "akamai", edgePort1);

    const res = await app.request("/priorities", json({
      priorities: ["cdn-a"],
    }));
    const body = await res.json();
    expect(body).toHaveProperty("generation");
    expect(body).toHaveProperty("propagated");
    expect(body).toHaveProperty("failed");
    expect(body).toHaveProperty("failures");
    expect(typeof body.generation).toBe("number");
    expect(typeof body.propagated).toBe("number");
    expect(typeof body.failed).toBe("number");
    expect(Array.isArray(body.failures)).toBe(true);
  });
});
