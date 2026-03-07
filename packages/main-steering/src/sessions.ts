import type { CdnRegistry } from "./cdn.js";
import type { CommitTracker } from "./contracts.js";
import { calculatePriorities, DEFAULT_WEIGHTS } from "./priority.js";
import type { SessionState, ManifestUpdateRequest, PathwayMapping } from "./types.js";

// ─── Session Initialization ──────────────────────────────────────────────────

export interface SessionInitInput {
  /** CDN pathway IDs available for this session. */
  cdn_ids: string[];
  /** Region for region-aware priority calculation. */
  region?: string;
  /** Minimum bitrate in the encoding ladder (bps). */
  min_bitrate: number;
  /** Maximum bitrate in the encoding ladder (bps). */
  max_bitrate: number;
  /** Media duration in seconds (0 = live/unknown). */
  duration: number;
}

/**
 * Generate a SessionState for a new streaming session.
 *
 * This is the JSON that gets base64-encoded into the `_ss` parameter
 * of the manifest's SERVER-URI. The edge steering server decodes it
 * on the first steering request.
 */
export function buildSessionState(
  input: SessionInitInput,
  registry: CdnRegistry,
  tracker: CommitTracker,
  currentGeneration: number,
): SessionState {
  // Calculate priority order based on cost, contracts, and weights
  const priorities = calculatePriorities(
    {
      cdn_ids: input.cdn_ids,
      region: input.region,
      now: new Date(),
    },
    registry,
    tracker,
    DEFAULT_WEIGHTS,
  );

  // If priority calculation returned nothing (all CDNs disabled/unknown),
  // fall back to the input order.
  const finalPriorities = priorities.length > 0 ? priorities : input.cdn_ids;

  return {
    priorities: finalPriorities,
    throughput_map: [],
    min_bitrate: input.min_bitrate,
    max_bitrate: input.max_bitrate,
    duration: input.duration,
    position: 0,
    timestamp: Math.floor(Date.now() / 1000),
    override_gen: currentGeneration,
  };
}

/**
 * Build a full ManifestUpdateRequest for the edge manifest updater.
 *
 * Combines SessionState with CDN pathway→URL mappings and the steering URI.
 */
export function buildManifestUpdateRequest(
  input: SessionInitInput,
  registry: CdnRegistry,
  tracker: CommitTracker,
  currentGeneration: number,
  steeringUri: string,
): ManifestUpdateRequest {
  const sessionState = buildSessionState(input, registry, tracker, currentGeneration);

  // Build pathway mappings in priority order
  const pathways: PathwayMapping[] = sessionState.priorities
    .map((id) => {
      const provider = registry.get(id);
      return provider
        ? { pathway_id: id, base_url: provider.base_url }
        : null;
    })
    .filter((p): p is PathwayMapping => p !== null);

  return {
    session_state: sessionState,
    pathways,
    steering_uri: steeringUri,
  };
}
