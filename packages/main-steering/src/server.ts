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
    pricing: { cost_per_gb: 0.04, burst_cost_per_gb: 0.08, currency: "USD" },
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
  console.log(`  main-steering ready on :${info.port}`);
});
