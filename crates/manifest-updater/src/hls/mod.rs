use regex::Regex;

use crate::types::PathwayMapping;

/// Transform an HLS multivariant playlist for content steering.
///
/// 1. Injects or replaces `#EXT-X-CONTENT-STEERING` tag
/// 2. Clones `#EXT-X-STREAM-INF` variants for each pathway with `PATHWAY-ID` and `STABLE-VARIANT-ID`
/// 3. Clones `#EXT-X-MEDIA` renditions for each pathway with `PATHWAY-ID`
pub fn transform(
    manifest: &str,
    steering_url: &str,
    pathways: &[PathwayMapping],
) -> String {
    if pathways.is_empty() {
        return manifest.to_string();
    }

    let default_pathway = &pathways[0].pathway_id;

    // Step 1: inject/replace steering tag
    let with_tag = inject_steering_tag(manifest, steering_url, default_pathway);

    // Step 2: clone variants per pathway
    let with_variants = clone_stream_inf_variants(&with_tag, pathways);

    // Step 3: clone media renditions per pathway
    clone_media_renditions(&with_variants, pathways)
}

/// Inject or replace the `#EXT-X-CONTENT-STEERING` tag.
fn inject_steering_tag(manifest: &str, steering_url: &str, default_pathway: &str) -> String {
    let tag = format!(
        "#EXT-X-CONTENT-STEERING:SERVER-URI=\"{}\",PATHWAY-ID=\"{}\"",
        steering_url, default_pathway
    );

    // Case 1: replace existing tag
    let re = Regex::new(r"(?m)^#EXT-X-CONTENT-STEERING:.*$").unwrap();
    if re.is_match(manifest) {
        return re.replace(manifest, tag.as_str()).into_owned();
    }

    // Case 2: insert after #EXTM3U (and optional #EXT-X-VERSION)
    let insert_re = Regex::new(r"(?m)(^#EXTM3U\s*\n(?:#EXT-X-VERSION:\d+\s*\n)?)").unwrap();
    if let Some(m) = insert_re.find(manifest) {
        let pos = m.end();
        let mut result = String::with_capacity(manifest.len() + tag.len() + 1);
        result.push_str(&manifest[..pos]);
        result.push_str(&tag);
        result.push('\n');
        result.push_str(&manifest[pos..]);
        return result;
    }

    // Fallback: prepend
    format!("{}\n{}", tag, manifest)
}

/// Clone each `#EXT-X-STREAM-INF` + URI pair for every pathway.
///
/// For each original variant, produces one copy per pathway with:
/// - `PATHWAY-ID="<pathway_id>"` attribute added
/// - `STABLE-VARIANT-ID="<id>"` attribute derived from original attributes
/// - URI rewritten with the pathway's base_url prefix
fn clone_stream_inf_variants(manifest: &str, pathways: &[PathwayMapping]) -> String {
    let stream_inf_re =
        Regex::new(r"(?m)^(#EXT-X-STREAM-INF:.+)\n(.+)$").unwrap();

    if !stream_inf_re.is_match(manifest) {
        return manifest.to_string();
    }

    // Collect non-variant lines (everything before/between/after variant blocks)
    // and variant blocks separately
    let mut result = String::with_capacity(manifest.len() * pathways.len());
    let mut last_end = 0;
    let mut variant_id: u32 = 0;
    let mut variants: Vec<(String, String)> = Vec::new(); // (attributes, uri)

    for cap in stream_inf_re.captures_iter(manifest) {
        let full_match = cap.get(0).unwrap();

        // Append everything before this variant
        result.push_str(&manifest[last_end..full_match.start()]);

        let attrs = cap.get(1).unwrap().as_str();
        let uri = cap.get(2).unwrap().as_str();

        variants.push((attrs.to_string(), uri.to_string()));

        // Generate one variant per pathway
        let stable_id = format!("v{}", variant_id);
        for pathway in pathways {
            // Strip any existing PATHWAY-ID or STABLE-VARIANT-ID
            let clean_attrs = strip_attribute(attrs, "PATHWAY-ID");
            let clean_attrs = strip_attribute(&clean_attrs, "STABLE-VARIANT-ID");

            result.push_str(&format!(
                "{},PATHWAY-ID=\"{}\",STABLE-VARIANT-ID=\"{}\"\n{}\n",
                clean_attrs,
                pathway.pathway_id,
                stable_id,
                rewrite_uri(uri, &pathway.base_url),
            ));
        }

        variant_id += 1;
        last_end = full_match.end();
    }

    // Append remaining content after last variant
    result.push_str(&manifest[last_end..]);

    // Clean up any trailing double newlines
    while result.ends_with("\n\n") {
        result.pop();
    }
    if !result.ends_with('\n') {
        result.push('\n');
    }

    result
}

/// Clone `#EXT-X-MEDIA` tags for each pathway.
///
/// Each media tag gets duplicated per pathway with:
/// - `PATHWAY-ID="<pathway_id>"` added
/// - `URI` rewritten with the pathway's base_url prefix
fn clone_media_renditions(manifest: &str, pathways: &[PathwayMapping]) -> String {
    let media_re = Regex::new(r"(?m)^(#EXT-X-MEDIA:.+)$").unwrap();

    if !media_re.is_match(manifest) {
        return manifest.to_string();
    }

    let mut result = String::with_capacity(manifest.len() * pathways.len());
    let mut last_end = 0;

    for cap in media_re.captures_iter(manifest) {
        let full_match = cap.get(0).unwrap();
        result.push_str(&manifest[last_end..full_match.start()]);

        let tag = cap.get(1).unwrap().as_str();

        for pathway in pathways {
            let clean_tag = strip_attribute(tag, "PATHWAY-ID");
            let rewritten = rewrite_media_uri(&clean_tag, &pathway.base_url);
            result.push_str(&format!(
                "{},PATHWAY-ID=\"{}\"\n",
                rewritten, pathway.pathway_id,
            ));
        }

        last_end = full_match.end();
        // Skip the newline after the original tag if present
        if manifest[last_end..].starts_with('\n') {
            last_end += 1;
        }
    }

    result.push_str(&manifest[last_end..]);
    result
}

/// Strip an attribute from an HLS tag string.
/// E.g., strip_attribute("#EXT-X-STREAM-INF:BANDWIDTH=2000,PATHWAY-ID=\"a\"", "PATHWAY-ID")
/// → "#EXT-X-STREAM-INF:BANDWIDTH=2000"
fn strip_attribute(tag: &str, attr_name: &str) -> String {
    // Match ,ATTR="value" or ,ATTR=value (with or without quotes)
    let pattern = format!(r#",\s*{}="[^"]*""#, regex::escape(attr_name));
    let re = Regex::new(&pattern).unwrap();
    let result = re.replace(tag, "").into_owned();

    // Also try unquoted values
    let pattern2 = format!(r",\s*{}=[^,]*", regex::escape(attr_name));
    let re2 = Regex::new(&pattern2).unwrap();
    re2.replace(&result, "").into_owned()
}

/// Rewrite a URI by prepending a CDN base URL.
///
/// If the URI is already absolute (starts with http:// or https://), replace the origin.
/// Otherwise, prepend the base_url.
fn rewrite_uri(uri: &str, base_url: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        // Replace origin: extract path from URI and prepend base_url
        if let Some(path_start) = uri.find("://").and_then(|i| uri[i + 3..].find('/').map(|j| i + 3 + j)) {
            let path = &uri[path_start..];
            let base = base_url.trim_end_matches('/');
            format!("{}{}", base, path)
        } else {
            format!("{}/{}", base_url.trim_end_matches('/'), uri)
        }
    } else {
        let base = base_url.trim_end_matches('/');
        let path = if uri.starts_with('/') { uri.to_string() } else { format!("/{}", uri) };
        format!("{}{}", base, path)
    }
}

/// Rewrite the URI attribute inside an `#EXT-X-MEDIA` tag.
fn rewrite_media_uri(tag: &str, base_url: &str) -> String {
    let uri_re = Regex::new(r#"URI="([^"]*)""#).unwrap();
    if let Some(cap) = uri_re.captures(tag) {
        let original_uri = cap.get(1).unwrap().as_str();
        let new_uri = rewrite_uri(original_uri, base_url);
        uri_re
            .replace(tag, format!("URI=\"{}\"", new_uri).as_str())
            .into_owned()
    } else {
        tag.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_pathways() -> Vec<PathwayMapping> {
        vec![
            PathwayMapping {
                pathway_id: "cdn-a".into(),
                base_url: "https://cdn-a.example.com".into(),
            },
            PathwayMapping {
                pathway_id: "cdn-b".into(),
                base_url: "https://cdn-b.example.com".into(),
            },
        ]
    }

    #[test]
    fn inject_new_steering_tag() {
        let manifest = "#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nvideo.m3u8\n";
        let result = inject_steering_tag(manifest, "https://steer.example.com/v1?_ss=abc", "cdn-a");
        assert!(result.contains("#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://steer.example.com/v1?_ss=abc\",PATHWAY-ID=\"cdn-a\""));
        // Should be after #EXT-X-VERSION
        let tag_pos = result.find("#EXT-X-CONTENT-STEERING").unwrap();
        let version_pos = result.find("#EXT-X-VERSION").unwrap();
        assert!(tag_pos > version_pos);
    }

    #[test]
    fn replace_existing_steering_tag() {
        let manifest = "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"old\",PATHWAY-ID=\"old\"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nvideo.m3u8\n";
        let result = inject_steering_tag(manifest, "https://new.example.com", "cdn-new");
        assert!(result.contains("SERVER-URI=\"https://new.example.com\""));
        assert!(result.contains("PATHWAY-ID=\"cdn-new\""));
        assert!(!result.contains("old"));
    }

    #[test]
    fn clone_variants_two_pathways() {
        let manifest = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nvideo/2M/playlist.m3u8\n";
        let pathways = two_pathways();
        let result = clone_stream_inf_variants(manifest, &pathways);

        // Should have 2 STREAM-INF entries (one per pathway)
        let count = result.matches("#EXT-X-STREAM-INF").count();
        assert_eq!(count, 2);

        assert!(result.contains("PATHWAY-ID=\"cdn-a\""));
        assert!(result.contains("PATHWAY-ID=\"cdn-b\""));
        assert!(result.contains("https://cdn-a.example.com/video/2M/playlist.m3u8"));
        assert!(result.contains("https://cdn-b.example.com/video/2M/playlist.m3u8"));
    }

    #[test]
    fn clone_variants_preserves_stable_variant_id() {
        let manifest = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nvideo.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nvideo_hd.m3u8\n";
        let pathways = two_pathways();
        let result = clone_stream_inf_variants(manifest, &pathways);

        // 2 variants × 2 pathways = 4 STREAM-INF entries
        let count = result.matches("#EXT-X-STREAM-INF").count();
        assert_eq!(count, 4);

        // Both pathways should have STABLE-VARIANT-ID="v0" for first variant
        assert!(result.contains("STABLE-VARIANT-ID=\"v0\""));
        assert!(result.contains("STABLE-VARIANT-ID=\"v1\""));
    }

    #[test]
    fn rewrite_relative_uri() {
        assert_eq!(
            rewrite_uri("video/2M/playlist.m3u8", "https://cdn-a.example.com"),
            "https://cdn-a.example.com/video/2M/playlist.m3u8"
        );
    }

    #[test]
    fn rewrite_absolute_uri() {
        assert_eq!(
            rewrite_uri("https://origin.example.com/video/2M/playlist.m3u8", "https://cdn-a.example.com"),
            "https://cdn-a.example.com/video/2M/playlist.m3u8"
        );
    }

    #[test]
    fn rewrite_root_relative_uri() {
        assert_eq!(
            rewrite_uri("/video/2M/playlist.m3u8", "https://cdn-a.example.com"),
            "https://cdn-a.example.com/video/2M/playlist.m3u8"
        );
    }

    #[test]
    fn strip_attribute_removes_quoted() {
        let tag = "#EXT-X-STREAM-INF:BANDWIDTH=2000,PATHWAY-ID=\"old\"";
        let result = strip_attribute(tag, "PATHWAY-ID");
        assert_eq!(result, "#EXT-X-STREAM-INF:BANDWIDTH=2000");
    }

    #[test]
    fn clone_media_renditions_two_pathways() {
        let manifest = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English\",URI=\"audio/en.m3u8\"\n";
        let pathways = two_pathways();
        let result = clone_media_renditions(manifest, &pathways);

        let count = result.matches("#EXT-X-MEDIA").count();
        assert_eq!(count, 2);
        assert!(result.contains("PATHWAY-ID=\"cdn-a\""));
        assert!(result.contains("PATHWAY-ID=\"cdn-b\""));
        assert!(result.contains("https://cdn-a.example.com/audio/en.m3u8"));
        assert!(result.contains("https://cdn-b.example.com/audio/en.m3u8"));
    }

    #[test]
    fn full_transform() {
        let manifest = concat!(
            "#EXTM3U\n",
            "#EXT-X-VERSION:4\n",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English\",URI=\"audio/en.m3u8\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO=\"audio\"\n",
            "video/2M/playlist.m3u8\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO=\"audio\"\n",
            "video/5M/playlist.m3u8\n",
        );
        let pathways = two_pathways();
        let result = transform(manifest, "https://steer.example.com/v1?_ss=abc", &pathways);

        // Steering tag present
        assert!(result.contains("#EXT-X-CONTENT-STEERING"));
        assert!(result.contains("PATHWAY-ID=\"cdn-a\""));

        // 2 variants × 2 pathways = 4 STREAM-INF entries
        assert_eq!(result.matches("#EXT-X-STREAM-INF").count(), 4);

        // 1 media × 2 pathways = 2 MEDIA entries
        assert_eq!(result.matches("#EXT-X-MEDIA").count(), 2);
    }
}
