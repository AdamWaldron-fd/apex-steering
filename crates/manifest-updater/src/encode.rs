use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

use crate::types::SessionState;

/// Serialize session state to JSON, then base64url-encode (no padding).
/// This produces the same encoding as `apex-edge-steering/src/state.rs::encode_state`.
pub fn encode_session_state(state: &SessionState) -> Result<String, String> {
    let json = serde_json::to_vec(state).map_err(|e| format!("serialize: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(&json))
}

/// Build the full steering URI with `_ss=` query param and optional extras.
///
/// If `base_uri` already contains `?`, uses `&` as separator.
/// Extra params are appended after `_ss`.
pub fn build_steering_url(
    base_uri: &str,
    encoded_state: &str,
    extra_params: &[(String, String)],
) -> String {
    let sep = if base_uri.contains('?') { "&" } else { "?" };
    let mut url = format!("{base_uri}{sep}_ss={encoded_state}");
    for (k, v) in extra_params {
        url.push('&');
        url.push_str(k);
        url.push('=');
        url.push_str(v);
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_roundtrip() {
        let state = SessionState {
            priorities: vec!["alpha".into(), "beta".into()],
            throughput_map: vec![("alpha".into(), 5_000_000)],
            min_bitrate: 783_322,
            max_bitrate: 4_530_860,
            duration: 596,
            position: 0,
            timestamp: 1_700_000_000,
            override_gen: 7,
        };
        let encoded = encode_session_state(&state).unwrap();
        // URL-safe: no +, /, or =
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
        assert!(!encoded.contains('='));

        // Decode and verify roundtrip
        let bytes = URL_SAFE_NO_PAD.decode(&encoded).unwrap();
        let decoded: SessionState = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.priorities, state.priorities);
        assert_eq!(decoded.throughput_map, state.throughput_map);
        assert_eq!(decoded.min_bitrate, state.min_bitrate);
        assert_eq!(decoded.max_bitrate, state.max_bitrate);
        assert_eq!(decoded.duration, state.duration);
        assert_eq!(decoded.timestamp, state.timestamp);
        assert_eq!(decoded.override_gen, state.override_gen);
    }

    #[test]
    fn encode_default_state() {
        let state = SessionState::default();
        let encoded = encode_session_state(&state).unwrap();
        let bytes = URL_SAFE_NO_PAD.decode(&encoded).unwrap();
        let decoded: SessionState = serde_json::from_slice(&bytes).unwrap();
        assert!(decoded.priorities.is_empty());
        assert_eq!(decoded.min_bitrate, 0);
    }

    #[test]
    fn build_url_no_existing_query() {
        let url = build_steering_url("https://steer.example.com/v1", "abc123", &[]);
        assert_eq!(url, "https://steer.example.com/v1?_ss=abc123");
    }

    #[test]
    fn build_url_with_existing_query() {
        let url = build_steering_url("https://steer.example.com/v1?token=xyz", "abc123", &[]);
        assert_eq!(url, "https://steer.example.com/v1?token=xyz&_ss=abc123");
    }

    #[test]
    fn build_url_with_extra_params() {
        let extras = vec![
            ("start".into(), "12345".into()),
            ("userId".into(), "99".into()),
        ];
        let url = build_steering_url("https://steer.example.com/v1", "abc123", &extras);
        assert_eq!(
            url,
            "https://steer.example.com/v1?_ss=abc123&start=12345&userId=99"
        );
    }
}
