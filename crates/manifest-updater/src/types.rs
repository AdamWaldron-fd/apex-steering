use serde::{Deserialize, Serialize};

// ─── Session State (wire-compatible with apex-edge-steering) ─────────────────

/// All state variables that the edge server needs to persist across requests.
/// Encoded into the RELOAD-URI `_ss` parameter so the edge server remains stateless.
///
/// IMPORTANT: Field names, types, and declaration order must exactly match
/// `apex-edge-steering/src/types.rs::SessionState`. The edge server's
/// `decode_state()` deserializes this JSON.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionState {
    /// Pathway priority list as set by the steering master.
    pub priorities: Vec<String>,

    /// Per-pathway throughput observations as (pathway_id, bits_per_sec) tuples.
    #[serde(default)]
    pub throughput_map: Vec<(String, u64)>,

    /// Minimum bitrate in the encoding ladder (bits/sec).
    #[serde(default)]
    pub min_bitrate: u64,

    /// Maximum bitrate in the encoding ladder (bits/sec).
    #[serde(default)]
    pub max_bitrate: u64,

    /// Media duration in seconds (0 = live/unknown).
    #[serde(default)]
    pub duration: u64,

    /// Approximate playback position in seconds.
    #[serde(default)]
    pub position: u64,

    /// Epoch timestamp (seconds) when this state was created.
    #[serde(default)]
    pub timestamp: u64,

    /// Override generation — incremented when master forces an update.
    #[serde(default)]
    pub override_gen: u64,
}

// ─── Pathway Mapping ─────────────────────────────────────────────────────────

/// A CDN pathway with its delivery base URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathwayMapping {
    /// Pathway ID matching SessionState.priorities entries.
    pub pathway_id: String,

    /// CDN delivery base URL, e.g. "https://cdn-a.example.com".
    pub base_url: String,
}

// ─── Manifest Update Request ─────────────────────────────────────────────────

/// Full request envelope from apex-main-steering's GET /session/init.
/// Contains everything the edge manifest updater needs to inject content
/// steering into a manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestUpdateRequest {
    /// Session state to be base64-encoded into the steering SERVER-URI.
    pub session_state: SessionState,

    /// CDN pathways in priority order, with delivery base URLs.
    pub pathways: Vec<PathwayMapping>,

    /// Edge steering server base URI for the SERVER-URI / ContentSteering element.
    pub steering_uri: String,

    /// Optional extra query params to append to the steering URI (CDN tokens, etc.).
    #[serde(default)]
    pub extra_params: Vec<(String, String)>,
}
