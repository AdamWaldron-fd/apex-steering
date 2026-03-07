// ─── Session State (JSON-compatible with apex-edge-steering) ─────────────────

/**
 * All state variables that the edge server needs to persist across requests.
 * Encoded into the RELOAD-URI `_ss` parameter so the edge server remains stateless.
 *
 * IMPORTANT: This type must serialize to identical JSON as
 * `apex-edge-steering/src/types.rs::SessionState`. The edge server's
 * `decode_state()` deserializes this JSON. Any field name or format change
 * will break the edge ↔ master contract.
 */
export interface SessionState {
  /** Pathway priority list as set by the steering master. */
  priorities: string[];
  /** Per-pathway throughput observations as [pathway_id, bits_per_sec] tuples. */
  throughput_map: [string, number][];
  /** Minimum bitrate in the encoding ladder (bits/sec). */
  min_bitrate: number;
  /** Maximum bitrate in the encoding ladder (bits/sec). */
  max_bitrate: number;
  /** Media duration in seconds (0 = live/unknown). */
  duration: number;
  /** Approximate playback position in seconds. */
  position: number;
  /** Epoch timestamp (seconds) when this state was created. */
  timestamp: number;
  /** Override generation — incremented when master forces an update. */
  override_gen: number;
}

/** Create a default SessionState with all fields zeroed. */
export function defaultSessionState(): SessionState {
  return {
    priorities: [],
    throughput_map: [],
    min_bitrate: 0,
    max_bitrate: 0,
    duration: 0,
    position: 0,
    timestamp: 0,
    override_gen: 0,
  };
}

// ─── Control Commands (JSON-compatible with apex-edge-steering) ──────────────

/**
 * A command pushed from the master steering server to edge servers.
 *
 * IMPORTANT: The `type` field discriminator and its values must exactly match
 * `apex-edge-steering/src/types.rs::ControlCommand`. Edge servers deserialize
 * this JSON at `POST /control`.
 */
export type ControlCommand =
  | SetPrioritiesCommand
  | ExcludePathwayCommand
  | ClearOverridesCommand;

export interface SetPrioritiesCommand {
  type: "set_priorities";
  /** Optional region filter. null = global. */
  region: string | null;
  /** New priority order. */
  priorities: string[];
  /** Override generation (monotonically increasing). */
  generation: number;
  /** TTL override in seconds. null = use default. */
  ttl_override: number | null;
}

export interface ExcludePathwayCommand {
  type: "exclude_pathway";
  region: string | null;
  pathway: string;
  generation: number;
}

export interface ClearOverridesCommand {
  type: "clear_overrides";
  region: string | null;
  generation: number;
}

// ─── Propagation Result ──────────────────────────────────────────────────────

/** Result of propagating a control command to the edge fleet. */
export interface PropagationResult {
  /** The generation number assigned to this command. */
  generation: number;
  /** Number of edge instances that accepted the command. */
  propagated: number;
  /** Number of edge instances that failed. */
  failed: number;
  /** Details of each failure. */
  failures: PropagationFailure[];
}

export interface PropagationFailure {
  instance_id: string;
  control_url: string;
  error: string;
}

// ─── API Request Types ───────────────────────────────────────────────────────

/** Request body for POST /priorities. */
export interface SetPrioritiesRequest {
  region?: string | null;
  priorities: string[];
  ttl_override?: number | null;
}

/** Request body for POST /exclude. */
export interface ExcludePathwayRequest {
  region?: string | null;
  pathway: string;
}

/** Request body for POST /clear. */
export interface ClearOverridesRequest {
  region?: string | null;
}

/** Query params for GET /session/init. */
export interface SessionInitParams {
  /** Comma-separated CDN pathway IDs (e.g. "cdn-a,cdn-b"). */
  cdns: string;
  /** Optional region for region-aware priority calculation. */
  region?: string;
  /** Minimum bitrate in the encoding ladder (bps). */
  min_bitrate?: string;
  /** Maximum bitrate in the encoding ladder (bps). */
  max_bitrate?: string;
  /** Media duration in seconds (0 = live/unknown). */
  duration?: string;
}

/** Request body for POST /fleet/register. */
export interface RegisterEdgeRequest {
  platform: string;
  control_url: string;
  region?: string | null;
}

// ─── Manifest Update Request (for apex-manifest-updater) ────────────────────

/** A CDN pathway with its delivery base URL. */
export interface PathwayMapping {
  /** Pathway ID matching SessionState.priorities entries. */
  pathway_id: string;
  /** CDN delivery base URL, e.g. "https://cdn-a.example.com". */
  base_url: string;
}

/**
 * Full request envelope for the manifest updater WASM module.
 *
 * Returned by GET /session/init. Contains everything the edge manifest
 * updater needs to inject content steering into a manifest.
 */
export interface ManifestUpdateRequest {
  /** Session state to be base64-encoded into the steering SERVER-URI. */
  session_state: SessionState;
  /** CDN pathways in priority order, with delivery base URLs. */
  pathways: PathwayMapping[];
  /** Edge steering server base URI for the SERVER-URI / ContentSteering element. */
  steering_uri: string;
}
