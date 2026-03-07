import type { CdnRegistry } from "./cdn.js";
import {
  burstExhausted,
  commitMet,
  type CommitTracker,
} from "./contracts.js";

// ─── COGS Optimization ──────────────────────────────────────────────────────

/**
 * COGS (Cost of Goods Sold) optimization.
 *
 * Given a set of CDN providers and their current contract states,
 * determine the most cost-effective CDN to serve traffic while
 * respecting contract commitments.
 */

export interface CostEstimate {
  cdn_id: string;
  /** Effective cost per GB for the next unit of traffic. */
  effective_cost_per_gb: number;
  /** Whether this CDN is within its commit volume (cheaper rate). */
  within_commit: boolean;
  /** Whether this CDN has exhausted its burst ceiling. */
  burst_exhausted: boolean;
}

/**
 * Calculate effective cost per GB for each CDN, accounting for
 * contract commit status.
 *
 * - Within commit: use commit rate (already paid for, so effective cost is 0
 *   or the sunk cost rate)
 * - Above commit, within burst: use burst rate
 * - Burst exhausted: effectively infinite cost (exclude from consideration)
 */
export function estimateCosts(
  cdnIds: string[],
  registry: CdnRegistry,
  tracker: CommitTracker,
  now: Date,
): CostEstimate[] {
  return cdnIds
    .map((id) => estimateCdnCost(id, registry, tracker, now))
    .filter((e): e is CostEstimate => e !== null);
}

function estimateCdnCost(
  cdnId: string,
  registry: CdnRegistry,
  tracker: CommitTracker,
  now: Date,
): CostEstimate | null {
  const provider = registry.get(cdnId);
  if (!provider || !provider.enabled) return null;

  const contract = tracker.activeContract(cdnId, now);
  const usage = tracker.currentUsage(cdnId);

  // No contract: use base pricing
  if (!contract) {
    return {
      cdn_id: cdnId,
      effective_cost_per_gb: provider.pricing.cost_per_gb,
      within_commit: false,
      burst_exhausted: false,
    };
  }

  const isBurstExhausted = usage
    ? burstExhausted(usage, contract)
    : false;
  const isCommitMet = usage ? commitMet(usage, contract) : false;

  if (isBurstExhausted) {
    return {
      cdn_id: cdnId,
      effective_cost_per_gb: Infinity,
      within_commit: false,
      burst_exhausted: true,
    };
  }

  if (!isCommitMet) {
    // Within commit: traffic is "already paid for" — effective cost is the
    // commit rate, but we treat it as cheaper to incentivize filling the commit.
    return {
      cdn_id: cdnId,
      effective_cost_per_gb: provider.pricing.cost_per_gb * 0.5,
      within_commit: true,
      burst_exhausted: false,
    };
  }

  // Above commit: burst pricing
  return {
    cdn_id: cdnId,
    effective_cost_per_gb: provider.pricing.burst_cost_per_gb,
    within_commit: false,
    burst_exhausted: false,
  };
}

/**
 * Get CDN IDs sorted by effective cost (cheapest first),
 * excluding burst-exhausted CDNs.
 */
export function cheapestFirst(
  cdnIds: string[],
  registry: CdnRegistry,
  tracker: CommitTracker,
  now: Date,
): string[] {
  const estimates = estimateCosts(cdnIds, registry, tracker, now);
  return estimates
    .filter((e) => !e.burst_exhausted)
    .sort((a, b) => a.effective_cost_per_gb - b.effective_cost_per_gb)
    .map((e) => e.cdn_id);
}
