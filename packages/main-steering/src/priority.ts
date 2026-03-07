import type { CdnProvider, CdnRegistry } from "./cdn.js";
import {
  behindPace,
  burstExhausted,
  commitMet,
  commitPct,
  type CommitTracker,
} from "./contracts.js";

// ─── Priority Calculation ────────────────────────────────────────────────────

export interface PriorityInput {
  /** CDN pathway IDs to rank. */
  cdn_ids: string[];
  /** Region for regional filtering. */
  region?: string;
  /** Current time for contract period calculations. */
  now: Date;
}

export interface PriorityScore {
  cdn_id: string;
  /** Final composite score (higher = higher priority). */
  score: number;
  /** Breakdown of score components. */
  components: ScoreComponents;
}

export interface ScoreComponents {
  /** Score from contract fulfillment urgency (0–100). */
  contract_urgency: number;
  /** Score from cost efficiency (0–100). Higher = cheaper. */
  cost_efficiency: number;
  /** Score from operator-configured base weight (0–100). */
  base_weight: number;
}

/** Weights for each scoring component. */
export interface PriorityWeights {
  contract_urgency: number;
  cost_efficiency: number;
  base_weight: number;
}

export const DEFAULT_WEIGHTS: PriorityWeights = {
  contract_urgency: 0.5,
  cost_efficiency: 0.35,
  base_weight: 0.15,
};

/**
 * Calculate CDN priority order based on cost, contract obligations, and weights.
 *
 * Returns pathway IDs sorted from highest to lowest priority.
 */
export function calculatePriorities(
  input: PriorityInput,
  registry: CdnRegistry,
  tracker: CommitTracker,
  weights: PriorityWeights = DEFAULT_WEIGHTS,
): string[] {
  const scores = input.cdn_ids
    .map((id) => scoreCdn(id, registry, tracker, input.now, weights))
    .filter((s): s is PriorityScore => s !== null);

  // Sort descending by score
  scores.sort((a, b) => b.score - a.score);

  return scores.map((s) => s.cdn_id);
}

/**
 * Score a single CDN provider. Returns null if the CDN is not found or disabled.
 */
export function scoreCdn(
  cdnId: string,
  registry: CdnRegistry,
  tracker: CommitTracker,
  now: Date,
  weights: PriorityWeights = DEFAULT_WEIGHTS,
): PriorityScore | null {
  const provider = registry.get(cdnId);
  if (!provider || !provider.enabled) return null;

  const components = {
    contract_urgency: scoreContractUrgency(cdnId, tracker, now),
    cost_efficiency: scoreCostEfficiency(provider),
    base_weight: provider.weight * 100,
  };

  const score =
    components.contract_urgency * weights.contract_urgency +
    components.cost_efficiency * weights.cost_efficiency +
    components.base_weight * weights.base_weight;

  return { cdn_id: cdnId, score, components };
}

/**
 * Contract urgency score: how much do we need to steer traffic here
 * to meet the minimum commit?
 *
 * - 0 = commit fully met, no urgency
 * - 100 = critically behind pace on commit
 */
function scoreContractUrgency(
  cdnId: string,
  tracker: CommitTracker,
  now: Date,
): number {
  const contract = tracker.activeContract(cdnId, now);
  if (!contract) return 0; // No contract = no urgency

  const usage = tracker.currentUsage(cdnId);
  if (!usage) return 80; // Contract but no usage yet = high urgency

  if (commitMet(usage, contract)) return 0;
  if (burstExhausted(usage, contract)) return 0;

  const fulfilled = commitPct(usage, contract);
  const behind = behindPace(usage, contract, now);

  // Base urgency: inverse of fulfillment (0% fulfilled = 100 urgency)
  let urgency = (1 - fulfilled) * 60;

  // Boost if behind pace
  if (behind) {
    urgency += 40;
  }

  return Math.min(100, urgency);
}

/**
 * Cost efficiency score: how cheap is this CDN?
 *
 * Normalized so the cheapest CDN in the registry gets 100
 * and the most expensive gets 0.
 */
function scoreCostEfficiency(provider: CdnProvider): number {
  // Lower cost = higher score. Use inverse of cost_per_gb.
  // If cost is 0, it's free — max score.
  if (provider.pricing.cost_per_gb <= 0) return 100;

  // Simple inverse scoring. In practice you'd normalize across all providers,
  // but for the scaffold we use a reference point of $0.20/GB as "expensive".
  const reference_expensive = 0.20;
  const ratio = provider.pricing.cost_per_gb / reference_expensive;
  return Math.max(0, Math.min(100, (1 - ratio) * 100));
}
