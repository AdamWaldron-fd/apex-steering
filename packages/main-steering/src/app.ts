import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";

import { AppState } from "./state.js";
import { CdnRegistry, type CdnProvider } from "./cdn.js";
import { CommitTracker, type Contract, type ContractUsage } from "./contracts.js";
import { parseEdgePlatform, type EdgeInstance } from "./fleet.js";
import { buildManifestUpdateRequest } from "./sessions.js";
import { propagateCommand } from "./propagation.js";
import type {
  ControlCommand,
  SetPrioritiesRequest,
  ExcludePathwayRequest,
  ClearOverridesRequest,
  RegisterEdgeRequest,
  SessionInitParams,
} from "./types.js";

// ─── App Factory ─────────────────────────────────────────────────────────────

export function createApp(state: AppState): Hono {
  const app = new Hono();

  app.use("*", cors());

  // ── Health ───────────────────────────────────────────────────────────────

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      engine: "apex-main-steering",
      generation: state.generation,
      fleet_size: state.fleet.instances.length,
    });
  });

  // ── Session Init ─────────────────────────────────────────────────────────

  app.get("/session/init", (c) => {
    const params: SessionInitParams = {
      cdns: c.req.query("cdns") ?? "",
      region: c.req.query("region"),
      min_bitrate: c.req.query("min_bitrate"),
      max_bitrate: c.req.query("max_bitrate"),
      duration: c.req.query("duration"),
    };

    const steeringUri = c.req.query("steering_uri") ?? "";

    if (!params.cdns) {
      return c.json({ error: "cdns parameter is required" }, 400);
    }

    const cdnIds = params.cdns.split(",").map((s) => s.trim()).filter(Boolean);
    if (cdnIds.length === 0) {
      return c.json({ error: "at least one CDN ID is required" }, 400);
    }

    if (!steeringUri) {
      return c.json({ error: "steering_uri parameter is required" }, 400);
    }

    const request = buildManifestUpdateRequest(
      {
        cdn_ids: cdnIds,
        region: params.region,
        min_bitrate: parseInt(params.min_bitrate ?? "0", 10) || 0,
        max_bitrate: parseInt(params.max_bitrate ?? "0", 10) || 0,
        duration: parseInt(params.duration ?? "0", 10) || 0,
      },
      state.cdnRegistry,
      state.commitTracker,
      state.generation,
      steeringUri,
    );

    return c.json(request);
  });

  // ── Set Priorities ───────────────────────────────────────────────────────

  app.post("/priorities", async (c) => {
    const body = await c.req.json<SetPrioritiesRequest>();

    if (!body.priorities || body.priorities.length === 0) {
      return c.json({ error: "priorities array is required" }, 400);
    }

    const generation = state.nextGeneration();

    const command: ControlCommand = {
      type: "set_priorities",
      region: body.region ?? null,
      priorities: body.priorities,
      generation,
      ttl_override: body.ttl_override ?? null,
    };

    const result = await propagateCommand(
      state.fleet,
      command,
      body.region,
    );

    return c.json(result);
  });

  // ── Exclude Pathway ──────────────────────────────────────────────────────

  app.post("/exclude", async (c) => {
    const body = await c.req.json<ExcludePathwayRequest>();

    if (!body.pathway) {
      return c.json({ error: "pathway is required" }, 400);
    }

    const generation = state.nextGeneration();

    const command: ControlCommand = {
      type: "exclude_pathway",
      region: body.region ?? null,
      pathway: body.pathway,
      generation,
    };

    const result = await propagateCommand(
      state.fleet,
      command,
      body.region,
    );

    return c.json(result);
  });

  // ── Clear Overrides ──────────────────────────────────────────────────────

  app.post("/clear", async (c) => {
    const body = await c.req.json<ClearOverridesRequest>();

    const generation = state.nextGeneration();

    const command: ControlCommand = {
      type: "clear_overrides",
      region: body.region ?? null,
      generation,
    };

    const result = await propagateCommand(
      state.fleet,
      command,
      body.region,
    );

    return c.json(result);
  });

  // ── Fleet Management ─────────────────────────────────────────────────────

  app.post("/fleet/register", async (c) => {
    const body = await c.req.json<RegisterEdgeRequest>();

    if (!body.platform || !body.control_url) {
      return c.json(
        { error: "platform and control_url are required" },
        400,
      );
    }

    const platform = parseEdgePlatform(body.platform);
    if (!platform) {
      return c.json(
        {
          error: `invalid platform: ${body.platform}. Must be one of: akamai, cloudfront, cloudflare, fastly`,
        },
        400,
      );
    }

    const instance: EdgeInstance = {
      id: randomUUID(),
      platform,
      control_url: body.control_url,
      region: body.region ?? null,
      last_seen: new Date().toISOString(),
      healthy: true,
    };

    state.fleet.register(instance);

    return c.json(instance, 201);
  });

  app.delete("/fleet/:id", (c) => {
    const id = c.req.param("id");
    const removed = state.fleet.deregister(id);
    if (!removed) {
      return c.json({ error: "instance not found" }, 404);
    }
    return c.json({ status: "removed", id });
  });

  // ── Status ───────────────────────────────────────────────────────────────

  app.get("/status", (c) => {
    return c.json({
      generation: state.generation,
      cdn_providers: state.cdnRegistry.providers,
      contracts: state.commitTracker.contracts,
      contract_usage: state.commitTracker.usage,
      fleet: state.fleet.instances,
    });
  });

  app.get("/status/contracts", (c) => {
    return c.json({
      contracts: state.commitTracker.contracts,
      usage: state.commitTracker.usage,
    });
  });

  // ── Sandbox: Hot-swap Providers ───────────────────────────────────────────

  app.post("/providers", async (c) => {
    const providers = await c.req.json<CdnProvider[]>();

    if (!Array.isArray(providers) || providers.length === 0) {
      return c.json({ error: "providers array is required" }, 400);
    }

    state.setCdnRegistry(new CdnRegistry(providers));
    return c.json({ status: "ok", count: providers.length });
  });

  // ── Sandbox: Hot-swap Contracts ───────────────────────────────────────────

  app.post("/contracts", async (c) => {
    const body = await c.req.json<{
      contracts: Contract[];
      usage?: ContractUsage[];
    }>();

    if (!Array.isArray(body.contracts)) {
      return c.json({ error: "contracts array is required" }, 400);
    }

    state.commitTracker = new CommitTracker(
      body.contracts,
      body.usage ?? [],
    );
    return c.json({ status: "ok", count: body.contracts.length });
  });

  return app;
}
