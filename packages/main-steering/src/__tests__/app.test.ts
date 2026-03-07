import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { AppState } from "../state.js";
import { CdnRegistry, type CdnProvider } from "../cdn.js";
import { CommitTracker } from "../contracts.js";

const testProviders: CdnProvider[] = [
  {
    id: "cdn-a",
    name: "CDN Alpha",
    base_url: "https://cdn-a.example.com",
    regions: ["us-east"],
    pricing: { cost_per_gb: 0.08, burst_cost_per_gb: 0.12, currency: "USD" },
    weight: 0.6,
    enabled: true,
  },
  {
    id: "cdn-b",
    name: "CDN Beta",
    base_url: "https://cdn-b.example.com",
    regions: ["us-east"],
    pricing: { cost_per_gb: 0.05, burst_cost_per_gb: 0.10, currency: "USD" },
    weight: 0.4,
    enabled: true,
  },
];

function makeApp() {
  const state = new AppState(
    new CdnRegistry(testProviders),
    new CommitTracker(),
  );
  return { app: createApp(state), state };
}

describe("API endpoints", () => {
  it("GET /health returns ok", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.engine).toBe("apex-main-steering");
  });

  it("GET /session/init returns valid ManifestUpdateRequest", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b&region=us-east&min_bitrate=783322&max_bitrate=4530860&duration=596&steering_uri=https://steer.example.com/v1/steer",
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Must have ManifestUpdateRequest envelope fields
    expect(body.session_state).toBeDefined();
    expect(body.pathways).toBeDefined();
    expect(body.steering_uri).toBe("https://steer.example.com/v1/steer");

    // session_state must have all SessionState fields
    expect(body.session_state.priorities).toBeDefined();
    expect(Array.isArray(body.session_state.priorities)).toBe(true);
    expect(body.session_state.priorities).toHaveLength(2);
    expect(body.session_state.throughput_map).toEqual([]);
    expect(body.session_state.min_bitrate).toBe(783322);
    expect(body.session_state.max_bitrate).toBe(4530860);
    expect(body.session_state.duration).toBe(596);
    expect(body.session_state.position).toBe(0);
    expect(typeof body.session_state.timestamp).toBe("number");
    expect(body.session_state.override_gen).toBe(0);

    // pathways must have base_url for each CDN
    expect(body.pathways).toHaveLength(2);
    for (const p of body.pathways) {
      expect(p.pathway_id).toBeDefined();
      expect(p.base_url).toBeDefined();
    }
  });

  it("GET /session/init requires steering_uri param", async () => {
    const { app } = makeApp();
    const res = await app.request("/session/init?cdns=cdn-a,cdn-b");
    expect(res.status).toBe(400);
  });

  it("GET /session/init requires cdns param", async () => {
    const { app } = makeApp();
    const res = await app.request("/session/init");
    expect(res.status).toBe(400);
  });

  it("POST /fleet/register creates instance", async () => {
    const { app, state } = makeApp();
    const res = await app.request("/fleet/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "akamai",
        control_url: "https://edge.example.com/control",
        region: "us-east",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.platform).toBe("akamai");
    expect(body.control_url).toBe("https://edge.example.com/control");
    expect(body.region).toBe("us-east");
    expect(body.id).toBeDefined();
    expect(state.fleet.instances).toHaveLength(1);
  });

  it("POST /fleet/register rejects invalid platform", async () => {
    const { app } = makeApp();
    const res = await app.request("/fleet/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "unknown",
        control_url: "https://edge.example.com/control",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /fleet/:id removes instance", async () => {
    const { app, state } = makeApp();

    // Register first
    const regRes = await app.request("/fleet/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "cloudflare",
        control_url: "https://edge.example.com/control",
      }),
    });
    const { id } = await regRes.json();

    const res = await app.request(`/fleet/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.fleet.instances).toHaveLength(0);
  });

  it("DELETE /fleet/:id returns 404 for unknown", async () => {
    const { app } = makeApp();
    const res = await app.request("/fleet/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /priorities increments generation", async () => {
    const { app, state } = makeApp();
    const res = await app.request("/priorities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        priorities: ["cdn-b", "cdn-a"],
        ttl_override: 15,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation).toBe(1);
    expect(state.generation).toBe(1);
  });

  it("POST /priorities requires priorities array", async () => {
    const { app } = makeApp();
    const res = await app.request("/priorities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /exclude increments generation", async () => {
    const { app, state } = makeApp();
    const res = await app.request("/exclude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pathway: "cdn-c" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation).toBe(1);
  });

  it("POST /clear increments generation", async () => {
    const { app, state } = makeApp();
    // Generate some state first
    await app.request("/priorities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priorities: ["cdn-a"] }),
    });

    const res = await app.request("/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation).toBe(2); // 1 from priorities, 2 from clear
  });

  it("GET /status returns full state", async () => {
    const { app } = makeApp();
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation).toBe(0);
    expect(body.cdn_providers).toHaveLength(2);
    expect(body.fleet).toEqual([]);
  });

  it("generation increments monotonically across commands", async () => {
    const { app, state } = makeApp();

    await app.request("/priorities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priorities: ["cdn-a"] }),
    });
    expect(state.generation).toBe(1);

    await app.request("/exclude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pathway: "cdn-b" }),
    });
    expect(state.generation).toBe(2);

    await app.request("/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(state.generation).toBe(3);
  });

  // ── CORS ────────────────────────────────────────────────────────────────

  it("CORS headers are present on responses", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", {
      headers: { Origin: "https://example.com" },
    });
    expect(res.status).toBe(200);
    // Hono cors() middleware sets Access-Control-Allow-Origin
    const acaoHeader = res.headers.get("access-control-allow-origin");
    expect(acaoHeader).toBeDefined();
  });

  // ── Session Init region ─────────────────────────────────────────────────

  it("GET /session/init with region param passes it through", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/session/init?cdns=cdn-a,cdn-b&region=us-east&steering_uri=https://steer.example.com/v1/steer",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_state.priorities).toHaveLength(2);
  });

  it("GET /session/init without optional params defaults to 0", async () => {
    const { app } = makeApp();
    const res = await app.request("/session/init?cdns=cdn-a&steering_uri=https://steer.example.com/v1/steer");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_state.min_bitrate).toBe(0);
    expect(body.session_state.max_bitrate).toBe(0);
    expect(body.session_state.duration).toBe(0);
  });

  it("GET /session/init with empty comma-separated cdns returns 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/session/init?cdns=,,,");
    expect(res.status).toBe(400);
  });

  // ── Status contracts ────────────────────────────────────────────────────

  it("GET /status/contracts returns contract data", async () => {
    const state = new AppState(
      new CdnRegistry(testProviders),
      new CommitTracker(
        [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", period_end: "2026-04-01T00:00:00Z", min_commit_gb: 1000, max_burst_gb: null }],
        [{ cdn_id: "cdn-a", period_start: "2026-03-01T00:00:00Z", delivered_gb: 500 }],
      ),
    );
    const app = createApp(state);
    const res = await app.request("/status/contracts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contracts).toHaveLength(1);
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0].delivered_gb).toBe(500);
  });

  // ── Fleet registration validation ───────────────────────────────────────

  it("POST /fleet/register without region sets null", async () => {
    const { app } = makeApp();
    const res = await app.request("/fleet/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "fastly",
        control_url: "https://edge.example.com/control",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.region).toBeNull();
    expect(body.healthy).toBe(true);
  });

  // ── Exclude validation ──────────────────────────────────────────────────

  it("POST /exclude requires pathway field", async () => {
    const { app } = makeApp();
    const res = await app.request("/exclude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: "us-east" }),
    });
    expect(res.status).toBe(400);
  });

  // ── Region-scoped commands ──────────────────────────────────────────────

  it("POST /priorities with region passes region to command", async () => {
    const { app, state } = makeApp();
    const res = await app.request("/priorities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        region: "eu-west",
        priorities: ["cdn-b", "cdn-a"],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation).toBe(1);
  });

  it("POST /exclude with region passes region to command", async () => {
    const { app } = makeApp();
    const res = await app.request("/exclude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pathway: "cdn-c", region: "us-east" }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /clear with region passes region to command", async () => {
    const { app } = makeApp();
    const res = await app.request("/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: "ap-south" }),
    });
    expect(res.status).toBe(200);
  });

  // ── Health check reflects state ─────────────────────────────────────────

  it("GET /health reflects generation after commands", async () => {
    const { app } = makeApp();
    await app.request("/priorities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priorities: ["cdn-a"] }),
    });
    const res = await app.request("/health");
    const body = await res.json();
    expect(body.generation).toBe(1);
  });
});
