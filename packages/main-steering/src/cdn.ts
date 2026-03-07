// ─── CDN Provider ────────────────────────────────────────────────────────────

/**
 * A CDN provider that delivers content to end users.
 *
 * This is distinct from the edge compute platform where steering WASM runs.
 * A CdnProvider corresponds to a pathway ID (e.g., "cdn-a", "cdn-b") that
 * appears in SessionState.priorities and ControlCommand payloads.
 */
export interface CdnProvider {
  /** Pathway ID — must match the pathway IDs used in edge steering. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** CDN delivery base URL, e.g. "https://cdn-a.example.com". */
  base_url: string;
  /** Regions where this CDN is available. Empty = available globally. */
  regions: string[];
  /** Pricing information for cost optimization. */
  pricing: PricingTier;
  /** Base traffic weight (0.0–1.0). Higher = more preferred as tiebreaker. */
  weight: number;
  /** Whether this CDN is enabled for traffic. */
  enabled: boolean;
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

export interface PricingTier {
  /** Cost per GB of delivered traffic within the commit volume. */
  cost_per_gb: number;
  /** Cost per GB for traffic above the commit volume (burst pricing). */
  burst_cost_per_gb: number;
  /** Currency code (e.g., "USD"). */
  currency: string;
}

export function defaultPricingTier(): PricingTier {
  return { cost_per_gb: 0, burst_cost_per_gb: 0, currency: "USD" };
}

// ─── CDN Registry ────────────────────────────────────────────────────────────

/** In-memory registry of all configured CDN providers. */
export class CdnRegistry {
  readonly providers: CdnProvider[];

  constructor(providers: CdnProvider[] = []) {
    this.providers = providers;
  }

  /** Get a provider by its pathway ID. */
  get(id: string): CdnProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  /** Get all enabled providers, optionally filtered by region. */
  enabledForRegion(region?: string): CdnProvider[] {
    return this.providers.filter((p) => {
      if (!p.enabled) return false;
      if (region && p.regions.length > 0) {
        return p.regions.includes(region);
      }
      return true;
    });
  }

  /** Get all enabled provider IDs, optionally filtered by region. */
  enabledIdsForRegion(region?: string): string[] {
    return this.enabledForRegion(region).map((p) => p.id);
  }
}
