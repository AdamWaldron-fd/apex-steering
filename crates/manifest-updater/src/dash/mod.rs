use regex::Regex;

use crate::types::PathwayMapping;

/// Transform a DASH MPD manifest for content steering.
///
/// 1. Injects or replaces `<ContentSteering>` element
/// 2. Adds `<BaseURL serviceLocation="...">` entries per pathway
pub fn transform(
    manifest: &str,
    steering_url: &str,
    pathways: &[PathwayMapping],
) -> String {
    if pathways.is_empty() {
        return manifest.to_string();
    }

    let default_pathway = &pathways[0].pathway_id;

    // Step 1: inject/replace ContentSteering element
    let with_steering = inject_content_steering(manifest, steering_url, default_pathway);

    // Step 2: add BaseURL entries per pathway
    inject_base_urls(&with_steering, pathways)
}

/// Inject or replace the `<ContentSteering>` element inside `<MPD>`.
fn inject_content_steering(
    manifest: &str,
    steering_url: &str,
    default_pathway: &str,
) -> String {
    let element = format!(
        "<ContentSteering defaultServiceLocation=\"{}\" queryBeforeStart=\"true\">{}</ContentSteering>",
        xml_escape(default_pathway),
        xml_escape(steering_url),
    );

    // Case 1: replace existing element
    let re = Regex::new(r"(?s)<ContentSteering[^>]*>.*?</ContentSteering>").unwrap();
    if re.is_match(manifest) {
        return re.replace(manifest, element.as_str()).into_owned();
    }

    // Case 2: insert after opening <MPD ...> tag
    let mpd_re = Regex::new(r"(<MPD[^>]*>)").unwrap();
    if let Some(m) = mpd_re.find(manifest) {
        let pos = m.end();
        let mut result = String::with_capacity(manifest.len() + element.len() + 4);
        result.push_str(&manifest[..pos]);
        result.push('\n');
        result.push_str("  ");
        result.push_str(&element);
        result.push_str(&manifest[pos..]);
        return result;
    }

    // Fallback
    format!("{}\n{}", manifest, element)
}

/// Add `<BaseURL serviceLocation="...">` entries for each pathway.
///
/// Inserts BaseURL elements after each opening `<AdaptationSet>` tag,
/// or after `<MPD>` if no AdaptationSets exist.
fn inject_base_urls(manifest: &str, pathways: &[PathwayMapping]) -> String {
    let adapt_re = Regex::new(r"(<AdaptationSet[^>]*>)").unwrap();

    if adapt_re.is_match(manifest) {
        // Insert BaseURL entries after each AdaptationSet opening tag
        let mut result = String::with_capacity(manifest.len() + pathways.len() * 80);
        let mut last_end = 0;

        for cap in adapt_re.captures_iter(manifest) {
            let m = cap.get(0).unwrap();
            result.push_str(&manifest[last_end..m.end()]);

            for pathway in pathways {
                result.push_str(&format!(
                    "\n      <BaseURL serviceLocation=\"{}\">{}</BaseURL>",
                    xml_escape(&pathway.pathway_id),
                    xml_escape(&pathway.base_url),
                ));
            }

            last_end = m.end();
        }
        result.push_str(&manifest[last_end..]);
        result
    } else {
        // No AdaptationSets — insert after <MPD> tag
        let mpd_re = Regex::new(r"(<MPD[^>]*>)").unwrap();
        if let Some(m) = mpd_re.find(manifest) {
            let pos = m.end();
            let mut result = String::with_capacity(manifest.len() + pathways.len() * 80);
            result.push_str(&manifest[..pos]);

            for pathway in pathways {
                result.push_str(&format!(
                    "\n  <BaseURL serviceLocation=\"{}\">{}</BaseURL>",
                    xml_escape(&pathway.pathway_id),
                    xml_escape(&pathway.base_url),
                ));
            }

            result.push_str(&manifest[pos..]);
            result
        } else {
            manifest.to_string()
        }
    }
}

/// Escape special XML characters in text content and attribute values.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_pathways() -> Vec<PathwayMapping> {
        vec![
            PathwayMapping {
                pathway_id: "cdn-a".into(),
                base_url: "https://cdn-a.example.com/".into(),
            },
            PathwayMapping {
                pathway_id: "cdn-b".into(),
                base_url: "https://cdn-b.example.com/".into(),
            },
        ]
    }

    #[test]
    fn inject_new_content_steering() {
        let manifest = r#"<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
</MPD>"#;
        let result = inject_content_steering(manifest, "https://steer.example.com/v1?_ss=abc", "cdn-a");
        assert!(result.contains("<ContentSteering"));
        assert!(result.contains("defaultServiceLocation=\"cdn-a\""));
        assert!(result.contains("queryBeforeStart=\"true\""));
        assert!(result.contains("https://steer.example.com/v1?_ss=abc"));
    }

    #[test]
    fn replace_existing_content_steering() {
        let manifest = r#"<MPD>
  <ContentSteering defaultServiceLocation="old">https://old.example.com</ContentSteering>
  <Period/>
</MPD>"#;
        let result = inject_content_steering(manifest, "https://new.example.com", "cdn-new");
        assert!(result.contains("defaultServiceLocation=\"cdn-new\""));
        assert!(result.contains("https://new.example.com"));
        assert!(!result.contains("old"));
    }

    #[test]
    fn xml_escape_ampersand_in_url() {
        let result = inject_content_steering(
            "<MPD></MPD>",
            "https://steer.example.com/v1?_ss=abc&token=xyz",
            "cdn-a",
        );
        assert!(result.contains("_ss=abc&amp;token=xyz"));
    }

    #[test]
    fn inject_base_urls_in_adaptation_set() {
        let manifest = r#"<MPD>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
</MPD>"#;
        let pathways = two_pathways();
        let result = inject_base_urls(manifest, &pathways);
        assert!(result.contains(r#"<BaseURL serviceLocation="cdn-a">https://cdn-a.example.com/</BaseURL>"#));
        assert!(result.contains(r#"<BaseURL serviceLocation="cdn-b">https://cdn-b.example.com/</BaseURL>"#));
    }

    #[test]
    fn full_transform() {
        let manifest = r#"<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
</MPD>"#;
        let pathways = two_pathways();
        let result = transform(manifest, "https://steer.example.com/v1?_ss=abc", &pathways);

        // ContentSteering present
        assert!(result.contains("<ContentSteering"));

        // BaseURL entries for both pathways
        assert!(result.contains(r#"serviceLocation="cdn-a""#));
        assert!(result.contains(r#"serviceLocation="cdn-b""#));

        // Original content preserved
        assert!(result.contains("Representation bandwidth=\"2000000\""));
    }
}
