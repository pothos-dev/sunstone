//! Concept ↔ pretty-URL mapping for Sunstone Web (ADR 0006 family 13).
//!
//! The ONE source of truth for the web viewer's path↔URL scheme, folding the
//! former TS `web/conceptUrl.ts::{conceptToUrl, urlToConcept, collectFilePaths}`
//! and the native `render.rs::concept_url` twin (native `render.rs` now calls
//! [`concept_url`] for its resolved-link hrefs). The web viewer addresses a
//! Concept by its LOCATION in the URL path (not a `?path=` query), dropping the
//! `.md` extension and a trailing `/index`:
//!
//!   index.md                          -> /
//!   providers/index.md                -> /providers
//!   research/providers/mistral-ai.md  -> /research/providers/mistral-ai

use std::collections::HashSet;

/// Percent-encode a value for one URL path segment or query value (like
/// `encodeURIComponent`: the RFC 3986 unreserved set passes through, `%XX`
/// everything else, including `/`).
pub fn query_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Decode `%XX` percent-escapes (e.g. `%20` → space). Invalid escapes are
/// passed through verbatim. Inverse of [`query_encode`] for its output.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A Concept's bundle path → its pretty URL pathname. Drops `.md` and a trailing
/// `/index`; the root `index.md` becomes `/`. Each segment is URL-encoded.
/// (The former TS `conceptToUrl` + native `render.rs::concept_url`.)
pub fn concept_url(path: &str) -> String {
    let p = if path.len() >= 3 && path[path.len() - 3..].eq_ignore_ascii_case(".md") {
        &path[..path.len() - 3]
    } else {
        path
    };
    if p == "index" {
        return "/".to_string();
    }
    let p = p.strip_suffix("/index").unwrap_or(p);
    let encoded: Vec<String> = p.split('/').map(query_encode).collect();
    format!("/{}", encoded.join("/"))
}

/// A pretty URL path (already percent-DECODED — e.g. a SvelteKit route param) →
/// the matching Concept bundle path in `concept_paths`, or `None`. A folder
/// index (`<p>/index.md`) is preferred over a same-named leaf (`<p>.md`). The
/// former TS `urlToConcept`, now resolving against the concept set the wasm
/// `BundleIndex` handle owns (ADR 0006 §3 — retires `collectFilePaths`).
pub fn url_to_concept(url_path: &str, concept_paths: &[String]) -> Option<String> {
    let set: HashSet<&str> = concept_paths.iter().map(|s| s.as_str()).collect();
    let segs: Vec<&str> = url_path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return set.contains("index.md").then(|| "index.md".to_string());
    }
    let p = segs.join("/");
    for candidate in [format!("{p}/index.md"), format!("{p}.md")] {
        if set.contains(candidate.as_str()) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn concept_url_drops_md_and_index() {
        assert_eq!(concept_url("index.md"), "/");
        assert_eq!(concept_url("good.md"), "/good");
        assert_eq!(concept_url("providers/index.md"), "/providers");
        assert_eq!(
            concept_url("research/providers/mistral-ai.md"),
            "/research/providers/mistral-ai"
        );
        assert_eq!(concept_url("a b/c d.md"), "/a%20b/c%20d");
    }

    #[test]
    fn url_to_concept_root_resolves_index() {
        let set = paths(&["index.md", "good.md"]);
        assert_eq!(url_to_concept("", &set).as_deref(), Some("index.md"));
        assert_eq!(url_to_concept("/", &set).as_deref(), Some("index.md"));
    }

    #[test]
    fn url_to_concept_prefers_folder_index_over_leaf() {
        let set = paths(&["providers/index.md", "providers.md"]);
        assert_eq!(url_to_concept("providers", &set).as_deref(), Some("providers/index.md"));
    }

    #[test]
    fn url_to_concept_falls_back_to_leaf() {
        let set = paths(&["good.md"]);
        assert_eq!(url_to_concept("good", &set).as_deref(), Some("good.md"));
    }

    #[test]
    fn url_to_concept_nested_and_missing() {
        let set = paths(&["research/providers/mistral-ai.md"]);
        assert_eq!(
            url_to_concept("research/providers/mistral-ai", &set).as_deref(),
            Some("research/providers/mistral-ai.md")
        );
        assert_eq!(url_to_concept("nope", &set), None);
        assert_eq!(url_to_concept("", &set), None); // no index.md
    }

    #[test]
    fn round_trips_with_concept_url() {
        let set = paths(&["research/providers/mistral-ai.md", "index.md"]);
        for p in &set {
            let url = concept_url(p);
            // concept_url encodes; the route param arrives decoded. These fixtures
            // have no reserved chars, so the trimmed url path resolves back.
            let decoded = url.trim_start_matches('/');
            assert_eq!(url_to_concept(decoded, &set).as_deref(), Some(p.as_str()));
        }
    }
}
