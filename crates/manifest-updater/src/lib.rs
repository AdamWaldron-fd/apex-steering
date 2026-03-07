mod types;
mod encode;
pub mod hls;
pub mod dash;

pub use types::{SessionState, PathwayMapping, ManifestUpdateRequest};
pub use encode::{encode_session_state, build_steering_url};

use wasm_bindgen::prelude::*;

/// Auto-detect manifest type (HLS vs DASH) and apply full steering transformation.
///
/// `manifest`: Raw manifest text (M3U8 or MPD XML).
/// `request_json`: JSON-serialized `ManifestUpdateRequest`.
///
/// Returns the modified manifest with content steering tags and
/// pathway-specific variants/BaseURLs injected.
#[wasm_bindgen]
pub fn update_manifest(manifest: &str, request_json: &str) -> Result<String, JsValue> {
    let trimmed = manifest.trim_start();
    if trimmed.starts_with("#EXTM3U") {
        update_hls(manifest, request_json)
    } else if trimmed.contains("<MPD") {
        update_dash(manifest, request_json)
    } else {
        Err(JsValue::from_str(
            "Unknown manifest format: expected HLS (#EXTM3U) or DASH (<MPD>)",
        ))
    }
}

/// Transform an HLS multivariant playlist for content steering.
///
/// `manifest`: Raw M3U8 text.
/// `request_json`: JSON-serialized `ManifestUpdateRequest`.
#[wasm_bindgen]
pub fn update_hls(manifest: &str, request_json: &str) -> Result<String, JsValue> {
    let req = parse_request(request_json)?;
    let encoded = encode_session_state(&req.session_state)
        .map_err(|e| JsValue::from_str(&e))?;
    let url = build_steering_url(&req.steering_uri, &encoded, &req.extra_params);
    Ok(hls::transform(manifest, &url, &req.pathways))
}

/// Transform a DASH MPD manifest for content steering.
///
/// `manifest`: Raw MPD XML text.
/// `request_json`: JSON-serialized `ManifestUpdateRequest`.
#[wasm_bindgen]
pub fn update_dash(manifest: &str, request_json: &str) -> Result<String, JsValue> {
    let req = parse_request(request_json)?;
    let encoded = encode_session_state(&req.session_state)
        .map_err(|e| JsValue::from_str(&e))?;
    let url = build_steering_url(&req.steering_uri, &encoded, &req.extra_params);
    Ok(dash::transform(manifest, &url, &req.pathways))
}

/// Encode a SessionState to URL-safe base64 (no padding).
///
/// `state_json`: JSON-serialized `SessionState`.
///
/// Returns the base64-encoded string suitable for the `_ss=` parameter.
#[wasm_bindgen]
pub fn encode_state(state_json: &str) -> Result<String, JsValue> {
    let state: SessionState = serde_json::from_str(state_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid SessionState JSON: {e}")))?;
    encode_session_state(&state).map_err(|e| JsValue::from_str(&e))
}

/// Parse request JSON into ManifestUpdateRequest.
fn parse_request(request_json: &str) -> Result<ManifestUpdateRequest, JsValue> {
    serde_json::from_str(request_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid ManifestUpdateRequest JSON: {e}")))
}
