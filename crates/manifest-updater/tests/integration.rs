use apex_manifest_updater::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

// ─── Encoding Tests ──────────────────────────────────────────────────────────

#[test]
fn encode_state_roundtrip_matches_edge_steering_format() {
    let state = SessionState {
        priorities: vec!["cdn-a".into(), "cdn-b".into()],
        throughput_map: vec![("cdn-a".into(), 5_000_000)],
        min_bitrate: 783_322,
        max_bitrate: 4_530_860,
        duration: 596,
        position: 0,
        timestamp: 1_700_000_000,
        override_gen: 0,
    };

    let encoded = encode_session_state(&state).unwrap();

    // URL-safe base64: no +, /, or = padding
    assert!(!encoded.contains('+'), "encoded contains +");
    assert!(!encoded.contains('/'), "encoded contains /");
    assert!(!encoded.contains('='), "encoded contains =");

    // Decode and verify roundtrip (simulates what apex-edge-steering does)
    let bytes = URL_SAFE_NO_PAD.decode(&encoded).unwrap();
    let decoded: SessionState = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(decoded.priorities, state.priorities);
    assert_eq!(decoded.throughput_map, state.throughput_map);
    assert_eq!(decoded.min_bitrate, state.min_bitrate);
    assert_eq!(decoded.max_bitrate, state.max_bitrate);
    assert_eq!(decoded.duration, state.duration);
    assert_eq!(decoded.position, state.position);
    assert_eq!(decoded.timestamp, state.timestamp);
    assert_eq!(decoded.override_gen, state.override_gen);
}

#[test]
fn encode_state_field_names_match_edge_steering() {
    let state = SessionState {
        priorities: vec!["a".into()],
        ..Default::default()
    };
    let json = serde_json::to_value(&state).unwrap();
    let obj = json.as_object().unwrap();

    // These exact field names are required by apex-edge-steering's serde
    let expected_fields = [
        "priorities", "throughput_map", "min_bitrate", "max_bitrate",
        "duration", "position", "timestamp", "override_gen",
    ];
    for field in &expected_fields {
        assert!(obj.contains_key(*field), "missing field: {}", field);
    }
    assert_eq!(obj.len(), expected_fields.len(), "unexpected extra fields");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn make_request() -> ManifestUpdateRequest {
    ManifestUpdateRequest {
        session_state: SessionState {
            priorities: vec!["cdn-a".into(), "cdn-b".into()],
            min_bitrate: 783_322,
            max_bitrate: 4_530_860,
            duration: 596,
            ..Default::default()
        },
        pathways: vec![
            PathwayMapping {
                pathway_id: "cdn-a".into(),
                base_url: "https://cdn-a.example.com".into(),
            },
            PathwayMapping {
                pathway_id: "cdn-b".into(),
                base_url: "https://cdn-b.example.com".into(),
            },
        ],
        steering_uri: "https://steer.example.com/v1/steer".into(),
        extra_params: vec![],
    }
}

fn build_url(req: &ManifestUpdateRequest) -> String {
    let encoded = encode_session_state(&req.session_state).unwrap();
    build_steering_url(&req.steering_uri, &encoded, &req.extra_params)
}

// ─── HLS End-to-End Tests ────────────────────────────────────────────────────

#[test]
fn hls_end_to_end_realistic_manifest() {
    let manifest = concat!(
        "#EXTM3U\n",
        "#EXT-X-VERSION:4\n",
        "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English\",DEFAULT=YES,URI=\"audio/en/playlist.m3u8\"\n",
        "#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS=\"avc1.4d401f,mp4a.40.2\",AUDIO=\"audio\"\n",
        "video/2M/playlist.m3u8\n",
        "#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS=\"avc1.640028,mp4a.40.2\",AUDIO=\"audio\"\n",
        "video/5M/playlist.m3u8\n",
    );

    let req = make_request();
    let url = build_url(&req);
    let result = hls::transform(manifest, &url, &req.pathways);

    // Steering tag present
    assert!(result.contains("#EXT-X-CONTENT-STEERING:SERVER-URI="));
    assert!(result.contains("PATHWAY-ID=\"cdn-a\""));

    // 2 original variants × 2 pathways = 4 STREAM-INF entries
    assert_eq!(result.matches("#EXT-X-STREAM-INF").count(), 4);

    // 1 audio rendition × 2 pathways = 2 MEDIA entries
    assert_eq!(result.matches("#EXT-X-MEDIA").count(), 2);

    // CDN-specific URIs present
    assert!(result.contains("https://cdn-a.example.com/video/2M/playlist.m3u8"));
    assert!(result.contains("https://cdn-b.example.com/video/2M/playlist.m3u8"));
    assert!(result.contains("https://cdn-a.example.com/video/5M/playlist.m3u8"));
    assert!(result.contains("https://cdn-b.example.com/video/5M/playlist.m3u8"));
    assert!(result.contains("https://cdn-a.example.com/audio/en/playlist.m3u8"));
    assert!(result.contains("https://cdn-b.example.com/audio/en/playlist.m3u8"));

    // STABLE-VARIANT-ID present and consistent
    assert!(result.contains("STABLE-VARIANT-ID=\"v0\""));
    assert!(result.contains("STABLE-VARIANT-ID=\"v1\""));

    // Original content preserved
    assert!(result.contains("CODECS=\"avc1.4d401f,mp4a.40.2\""));
}

#[test]
fn hls_three_pathways_triple_variants() {
    let manifest = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nvideo.m3u8\n";
    let mut req = make_request();
    req.pathways.push(PathwayMapping {
        pathway_id: "cdn-c".into(),
        base_url: "https://cdn-c.example.com".into(),
    });
    let url = build_url(&req);
    let result = hls::transform(manifest, &url, &req.pathways);

    // 1 variant × 3 pathways = 3 STREAM-INF entries
    assert_eq!(result.matches("#EXT-X-STREAM-INF").count(), 3);
    assert!(result.contains("PATHWAY-ID=\"cdn-c\""));
}

// ─── DASH End-to-End Tests ───────────────────────────────────────────────────

#[test]
fn dash_end_to_end_realistic_manifest() {
    let manifest = r#"<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT596S">
  <Period>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
      <Representation id="v0" bandwidth="2000000" width="1280" height="720"/>
      <Representation id="v1" bandwidth="5000000" width="1920" height="1080"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en">
      <Representation id="a0" bandwidth="128000"/>
    </AdaptationSet>
  </Period>
</MPD>"#;

    let req = make_request();
    let url = build_url(&req);
    let result = dash::transform(manifest, &url, &req.pathways);

    // ContentSteering element present
    assert!(result.contains("<ContentSteering"));
    assert!(result.contains("defaultServiceLocation=\"cdn-a\""));
    assert!(result.contains("queryBeforeStart=\"true\""));

    // BaseURL entries for both pathways in both AdaptationSets
    // 2 AdaptationSets × 2 pathways = 4 BaseURL entries
    assert_eq!(result.matches("serviceLocation=\"cdn-a\"").count(), 2);
    assert_eq!(result.matches("serviceLocation=\"cdn-b\"").count(), 2);

    // Original content preserved
    assert!(result.contains("bandwidth=\"2000000\""));
    assert!(result.contains("bandwidth=\"5000000\""));
    assert!(result.contains("lang=\"en\""));
}

// ─── Edge Steering Wire Compatibility ────────────────────────────────────────

#[test]
fn encoded_state_decodable_by_edge_steering_format() {
    let state = SessionState {
        priorities: vec!["cdn-a".into(), "cdn-b".into(), "cdn-c".into()],
        throughput_map: vec![
            ("cdn-a".into(), 5_140_000),
            ("cdn-b".into(), 3_200_000),
        ],
        min_bitrate: 783_322,
        max_bitrate: 4_530_860,
        duration: 3600,
        position: 120,
        timestamp: 1_709_654_400,
        override_gen: 42,
    };

    let encoded = encode_session_state(&state).unwrap();

    // Simulate apex-edge-steering's decode_state()
    let bytes = URL_SAFE_NO_PAD.decode(&encoded).unwrap();
    let decoded: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    // Verify JSON structure matches what Rust serde expects
    assert!(decoded["priorities"].is_array());
    assert!(decoded["throughput_map"].is_array());
    assert!(decoded["min_bitrate"].is_u64());
    assert!(decoded["max_bitrate"].is_u64());
    assert!(decoded["duration"].is_u64());
    assert!(decoded["position"].is_u64());
    assert!(decoded["timestamp"].is_u64());
    assert!(decoded["override_gen"].is_u64());

    // Verify throughput_map entries are [string, number] tuples
    let tmap = decoded["throughput_map"].as_array().unwrap();
    assert_eq!(tmap.len(), 2);
    assert!(tmap[0][0].is_string());
    assert!(tmap[0][1].is_u64());
}

#[test]
fn manifest_update_request_deserializes_from_main_steering_format() {
    // Simulate JSON as produced by apex-main-steering /session/init
    let json = r#"{
        "session_state": {
            "priorities": ["cdn-a", "cdn-b"],
            "throughput_map": [],
            "min_bitrate": 783322,
            "max_bitrate": 4530860,
            "duration": 596,
            "position": 0,
            "timestamp": 1700000000,
            "override_gen": 0
        },
        "pathways": [
            {"pathway_id": "cdn-a", "base_url": "https://cdn-a.example.com"},
            {"pathway_id": "cdn-b", "base_url": "https://cdn-b.example.com"}
        ],
        "steering_uri": "https://steer.example.com/v1/steer"
    }"#;

    let req: ManifestUpdateRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.session_state.priorities, vec!["cdn-a", "cdn-b"]);
    assert_eq!(req.pathways.len(), 2);
    assert_eq!(req.pathways[0].pathway_id, "cdn-a");
    assert_eq!(req.pathways[0].base_url, "https://cdn-a.example.com");
    assert_eq!(req.steering_uri, "https://steer.example.com/v1/steer");
    assert!(req.extra_params.is_empty());
}
