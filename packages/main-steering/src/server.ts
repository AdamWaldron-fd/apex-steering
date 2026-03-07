import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { AppState } from "./state.js";
import { CdnRegistry, type CdnProvider } from "./cdn.js";
import { CommitTracker } from "./contracts.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(
  process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "4000",
  10,
);

// Default CDN providers for development. In production, load from config file
// or environment variables.
const defaultProviders: CdnProvider[] = [
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
];

// ─── Main ────────────────────────────────────────────────────────────────────

const state = new AppState(
  new CdnRegistry(defaultProviders),
  new CommitTracker(),
);

const app = createApp(state);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\napex-main-steering listening on http://localhost:${info.port}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health             Health check`);
  console.log(`  GET  /session/init       Generate session state for manifest updaters`);
  console.log(`  POST /priorities         Force CDN priority order → propagate to edge fleet`);
  console.log(`  POST /exclude            Exclude a CDN pathway → propagate to edge fleet`);
  console.log(`  POST /clear              Clear all overrides → propagate to edge fleet`);
  console.log(`  POST /fleet/register     Register an edge instance`);
  console.log(`  DELETE /fleet/:id        Remove an edge instance`);
  console.log(`  GET  /status             Full system state`);
  console.log(`  GET  /status/contracts   Contract usage summary`);
  console.log(`  GET  /ui                Dev UI`);
  console.log(`\nDev UI: http://localhost:${info.port}/ui`);
  console.log();
});
