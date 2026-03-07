import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { propagateCommand } from "../propagation.js";
import { EdgeFleet, type EdgeInstance } from "../fleet.js";
import type { ControlCommand } from "../types.js";

// ─── Mock Edge Server ────────────────────────────────────────────────────────

interface ReceivedCommand {
  body: ControlCommand;
  headers: Record<string, string>;
}

function createMockEdgeServer() {
  const received: ReceivedCommand[] = [];
  let failNext = false;

  const app = new Hono();

  app.post("/control", async (c) => {
    if (failNext) {
      failNext = false;
      return c.json({ error: "simulated failure" }, 500);
    }
    const body = await c.req.json<ControlCommand>();
    received.push({
      body,
      headers: Object.fromEntries(
        [...c.req.raw.headers.entries()].map(([k, v]) => [k, v]),
      ),
    });
    return c.json({ status: "ok" });
  });

  return {
    app,
    received,
    setFailNext: () => { failNext = true; },
    clear: () => { received.length = 0; },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Propagation with mock edge server", () => {
  const mock1 = createMockEdgeServer();
  const mock2 = createMockEdgeServer();
  let server1: ReturnType<typeof serve>;
  let server2: ReturnType<typeof serve>;
  let port1: number;
  let port2: number;

  beforeAll(async () => {
    // Start mock edge servers on random ports
    await new Promise<void>((resolve) => {
      server1 = serve({ fetch: mock1.app.fetch, port: 0 }, (info) => {
        port1 = info.port;
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      server2 = serve({ fetch: mock2.app.fetch, port: 0 }, (info) => {
        port2 = info.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server1?.close();
    server2?.close();
  });

  function makeFleet(): EdgeFleet {
    const fleet = new EdgeFleet();
    fleet.register({
      id: "edge-akamai-1",
      platform: "akamai",
      control_url: `http://localhost:${port1}/control`,
      region: "us-east",
      last_seen: new Date().toISOString(),
      healthy: true,
    });
    fleet.register({
      id: "edge-cloudflare-1",
      platform: "cloudflare",
      control_url: `http://localhost:${port2}/control`,
      region: "us-east",
      last_seen: new Date().toISOString(),
      healthy: true,
    });
    return fleet;
  }

  it("propagates set_priorities to all healthy instances", async () => {
    mock1.clear();
    mock2.clear();
    const fleet = makeFleet();
    const command: ControlCommand = {
      type: "set_priorities",
      region: "us-east",
      priorities: ["cdn-b", "cdn-a"],
      generation: 1,
      ttl_override: 15,
    };

    const result = await propagateCommand(fleet, command);

    expect(result.generation).toBe(1);
    expect(result.propagated).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);

    // Verify both mock edge servers received the correct command
    expect(mock1.received).toHaveLength(1);
    expect(mock1.received[0].body.type).toBe("set_priorities");
    expect(mock1.received[0].body.generation).toBe(1);
    if (mock1.received[0].body.type === "set_priorities") {
      expect(mock1.received[0].body.priorities).toEqual(["cdn-b", "cdn-a"]);
      expect(mock1.received[0].body.ttl_override).toBe(15);
    }

    expect(mock2.received).toHaveLength(1);
    expect(mock2.received[0].body.type).toBe("set_priorities");
  });

  it("propagates exclude_pathway with correct JSON format", async () => {
    mock1.clear();
    mock2.clear();
    const fleet = makeFleet();
    const command: ControlCommand = {
      type: "exclude_pathway",
      region: null,
      pathway: "cdn-c",
      generation: 5,
    };

    const result = await propagateCommand(fleet, command);
    expect(result.propagated).toBe(2);

    expect(mock1.received[0].body).toEqual({
      type: "exclude_pathway",
      region: null,
      pathway: "cdn-c",
      generation: 5,
    });
  });

  it("propagates clear_overrides with correct JSON format", async () => {
    mock1.clear();
    mock2.clear();
    const fleet = makeFleet();
    const command: ControlCommand = {
      type: "clear_overrides",
      region: null,
      generation: 10,
    };

    const result = await propagateCommand(fleet, command);
    expect(result.propagated).toBe(2);

    expect(mock1.received[0].body).toEqual({
      type: "clear_overrides",
      region: null,
      generation: 10,
    });
  });

  it("sends Content-Type application/json", async () => {
    mock1.clear();
    const fleet = makeFleet();
    const command: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ["cdn-a"],
      generation: 1,
      ttl_override: null,
    };

    await propagateCommand(fleet, command);
    expect(mock1.received[0].headers["content-type"]).toBe("application/json");
  });

  it("reports failures when edge server returns error", async () => {
    mock1.clear();
    mock2.clear();
    mock1.setFailNext(); // Make first mock fail
    const fleet = makeFleet();
    const command: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ["cdn-a"],
      generation: 2,
      ttl_override: null,
    };

    const result = await propagateCommand(fleet, command);
    expect(result.propagated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].instance_id).toBe("edge-akamai-1");
    expect(result.failures[0].error).toContain("500");
  });

  it("returns empty result when no healthy instances", async () => {
    const fleet = new EdgeFleet();
    fleet.register({
      id: "unhealthy",
      platform: "akamai",
      control_url: `http://localhost:${port1}/control`,
      region: "us-east",
      last_seen: new Date().toISOString(),
      healthy: false,
    });

    const command: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ["cdn-a"],
      generation: 1,
      ttl_override: null,
    };

    const result = await propagateCommand(fleet, command);
    expect(result.propagated).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("filters by region when specified", async () => {
    mock1.clear();
    mock2.clear();
    const fleet = new EdgeFleet();
    fleet.register({
      id: "edge-us",
      platform: "akamai",
      control_url: `http://localhost:${port1}/control`,
      region: "us-east",
      last_seen: new Date().toISOString(),
      healthy: true,
    });
    fleet.register({
      id: "edge-eu",
      platform: "cloudflare",
      control_url: `http://localhost:${port2}/control`,
      region: "eu-west",
      last_seen: new Date().toISOString(),
      healthy: true,
    });

    const command: ControlCommand = {
      type: "set_priorities",
      region: "us-east",
      priorities: ["cdn-a"],
      generation: 1,
      ttl_override: null,
    };

    const result = await propagateCommand(fleet, command, "us-east");
    expect(result.propagated).toBe(1);
    expect(mock1.received).toHaveLength(1);
    expect(mock2.received).toHaveLength(0); // eu-west not targeted
  });

  it("reports failure for unreachable instances", async () => {
    const fleet = new EdgeFleet();
    fleet.register({
      id: "unreachable",
      platform: "fastly",
      control_url: "http://localhost:1/control", // port 1 = unreachable
      region: null,
      last_seen: new Date().toISOString(),
      healthy: true,
    });

    const command: ControlCommand = {
      type: "clear_overrides",
      region: null,
      generation: 1,
    };

    const result = await propagateCommand(fleet, command);
    expect(result.propagated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures[0].instance_id).toBe("unreachable");
  });

  it("handles concurrent fan-out to multiple platforms", async () => {
    mock1.clear();
    mock2.clear();
    const fleet = new EdgeFleet();
    // Register instances across all 4 platform types, 2 pointing at mock1, 2 at mock2
    fleet.register({ id: "akamai-1", platform: "akamai", control_url: `http://localhost:${port1}/control`, region: null, last_seen: new Date().toISOString(), healthy: true });
    fleet.register({ id: "cloudfront-1", platform: "cloudfront", control_url: `http://localhost:${port1}/control`, region: null, last_seen: new Date().toISOString(), healthy: true });
    fleet.register({ id: "cloudflare-1", platform: "cloudflare", control_url: `http://localhost:${port2}/control`, region: null, last_seen: new Date().toISOString(), healthy: true });
    fleet.register({ id: "fastly-1", platform: "fastly", control_url: `http://localhost:${port2}/control`, region: null, last_seen: new Date().toISOString(), healthy: true });

    const command: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ["cdn-b", "cdn-a"],
      generation: 99,
      ttl_override: null,
    };

    const result = await propagateCommand(fleet, command);
    expect(result.propagated).toBe(4);
    expect(result.failed).toBe(0);
    expect(mock1.received).toHaveLength(2);
    expect(mock2.received).toHaveLength(2);
    // All received same generation
    for (const r of [...mock1.received, ...mock2.received]) {
      expect(r.body.generation).toBe(99);
    }
  });

  it("mixed success and failure — partial propagation", async () => {
    mock1.clear();
    mock2.clear();
    mock1.setFailNext();
    mock2.setFailNext();

    const fleet = new EdgeFleet();
    fleet.register({ id: "ok-1", platform: "akamai", control_url: `http://localhost:${port1}/control`, region: null, last_seen: new Date().toISOString(), healthy: true });
    fleet.register({ id: "ok-2", platform: "cloudfront", control_url: `http://localhost:${port2}/control`, region: null, last_seen: new Date().toISOString(), healthy: true });

    // First call: both fail
    const command: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ["cdn-a"],
      generation: 1,
      ttl_override: null,
    };
    const result1 = await propagateCommand(fleet, command);
    expect(result1.propagated).toBe(0);
    expect(result1.failed).toBe(2);
    expect(result1.failures).toHaveLength(2);

    // Second call: both succeed (failNext resets after one failure)
    const result2 = await propagateCommand(fleet, { ...command, generation: 2 });
    expect(result2.propagated).toBe(2);
    expect(result2.failed).toBe(0);
  });

  it("empty fleet returns zero propagated and zero failed", async () => {
    const fleet = new EdgeFleet();
    const command: ControlCommand = {
      type: "set_priorities",
      region: null,
      priorities: ["cdn-a"],
      generation: 1,
      ttl_override: null,
    };
    const result = await propagateCommand(fleet, command);
    expect(result.propagated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.generation).toBe(1);
  });

  it("propagation result always contains the correct generation", async () => {
    mock1.clear();
    const fleet = makeFleet();

    for (const gen of [1, 42, 100, 999]) {
      const command: ControlCommand = {
        type: "clear_overrides",
        region: null,
        generation: gen,
      };
      const result = await propagateCommand(fleet, command);
      expect(result.generation).toBe(gen);
    }
  });
});
