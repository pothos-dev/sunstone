//! Server-side Concept rendering (slice: web-server-side-render).
//!
//! Renders a Concept's markdown BODY to read-only HTML for the web viewer, so
//! all knowledge semantics stay in Rust (no CodeMirror on the web). The BODY
//! only is rendered — frontmatter lives outside the document (ADR 0003) and is
//! returned separately for the read-only Properties view.
//!
//! Link resolution REUSES the existing core logic — `paths::resolve_internal`
//! for standard markdown links and `wikilink::resolve_wikilink` for `[[name]]`
//! wikilinks — so the web resolves links by the exact same rules as the desktop
//! (filename match, shortest-path/alphabetical tie-break, suffix match). The
//! rules are not reimplemented here; we only decide, per resolved target, how it
//! is emitted:
//!   - in-Bundle & existing  → `class="internal-link" data-path=… href="?path=…"`
//!     (the viewer intercepts the click and navigates WITHIN the app),
//!   - in-Bundle & missing   → the same plus `broken` (styled distinct, still
//!     present and clickable — broken links are tolerated per OKF),
//!   - external (`scheme:`)  → a normal anchor opening in a new tab.
//!
//! Pipeline: strip frontmatter → rewrite `[[wikilinks]]` to markdown links
//! carrying a resolution marker → parse with comrak → mark standard-link URLs
//! with the same markers (+ collect the heading outline) → render HTML → rewrite
//! the marker hrefs into the final anchor attributes.
//!
//! Mermaid fenced blocks are left as inert `<pre><code>` source here; their
//! client-side hydration is a later slice.
//!
//! This module is split into: the pipeline above (here), the CriticMarkup
//! sentinel pass (`critic.rs`), and the citation-superscript sentinel pass
//! (`citations.rs`); the two sentinel passes share their scan/substitute
//! plumbing via `sentinel::Sentinels`.

mod citations;
mod critic;
mod sentinel;

use std::path::Path;

use comrak::nodes::NodeValue;
use comrak::{format_html, parse_document, Arena, Options};
use regex::Regex;
use serde::Serialize;

use crate::bundle;
use crate::index::frontmatter::strip_frontmatter;
use crate::index::Index;
use sunstone_shared::frontmatter::{frontmatter_fields, FrontmatterField};
use sunstone_shared::outline::{scan_headings, OutlineHeading};
use sunstone_shared::paths::{is_external, resolve_internal};
use sunstone_shared::url::concept_url;
use sunstone_shared::wikilink::{self, parse_target};

use citations::{citations_to_sentinels, substitute_citation_sentinels};
use critic::{critic_to_sentinels, substitute_critic_sentinels};

/// The rendered read-only view of a Concept: body HTML plus the parsed
/// frontmatter and the document outline. Matches the TS shape consumed by the
/// web viewer (`serde rename_all = "camelCase"`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPayload {
    /// Rendered body HTML (frontmatter excluded).
    pub html: String,
    /// Frontmatter key → value(s), in document order (for the Properties view).
    pub frontmatter: Vec<FrontmatterField>,
    /// Headings in document order (ATX only; frontmatter + fenced code excluded).
    /// The shared `OutlineHeading` (ADR 0006 §6): `render.rs` re-points here and
    /// derives the outline from the pure `scan_headings` scan, not a comrak walk.
    pub outline: Vec<OutlineHeading>,
}

/// Render the Concept at `rel_path` (validated against the Bundle root, like the
/// other read routes) to a [`RenderPayload`], resolving links against `index`.
pub fn render_concept(
    root: &Path,
    index: &Index,
    rel_path: &str,
) -> Result<RenderPayload, String> {
    // read_concept validates the path (escape rejection) and reads the raw file.
    let content = bundle::read_concept(root, rel_path)?;
    let all_paths = index.concept_paths();
    Ok(render_body(&content, rel_path, &all_paths, &|p| {
        index.concept_exists(p)
    }))
}

/// Pure render over raw Concept `content` (frontmatter included). `source_path`
/// is the Concept's own path (for relative links / `[[#anchor]]`); `all_paths`
/// is every Concept path in the Bundle (for name-based wikilink resolution);
/// `exists` reports whether a resolved path is a real Concept (for broken-link
/// marking). Split out from `render_concept` so it is testable without disk.
pub fn render_body(
    content: &str,
    source_path: &str,
    all_paths: &[String],
    exists: &dyn Fn(&str) -> bool,
) -> RenderPayload {
    let frontmatter = frontmatter_fields(content);
    // Outline enumeration is the SAME pure ATX scan the editor runs over wasm
    // (ADR 0006 family 13): one algorithm feeds both the editor and this SSR
    // render, instead of the former comrak node-walk. Scanned on the RAW content
    // (so the frontmatter offset is applied); ATX-only (setext dropped).
    let outline = scan_headings(content);
    let body = strip_frontmatter(content);

    // 0. Replace CriticMarkup delimiters with sentinel tokens BEFORE comrak,
    //    leaving each mark's inner content in the markdown stream so it is still
    //    markdown-rendered (e.g. `{++**bold**++}` bolds inside the `<ins>`). The
    //    sentinels are substituted for our critic HTML tags AFTER comrak escapes
    //    everything, so `render.unsafe_` stays false and no other raw HTML leaks.
    let (body, critic_repls) = critic_to_sentinels(body);

    // 0b. Replace citation markers with sentinels too (citation-superscripts):
    //     inline `[n]` following a word becomes a superscript link to the `[n]`
    //     row of the citation table; that row's own `[n]` becomes the (literal,
    //     NOT superscript) jump target. Same sentinel technique as CriticMarkup
    //     (a distinct PUA pair), so `render.unsafe_` stays off. Consuming the
    //     brackets here also stops comrak from parsing `[6][7]` as a stray
    //     reference link (which is what made the middle number look highlighted).
    let (body, citation_repls) = citations_to_sentinels(&body);

    // 1. Rewrite `[[wikilinks]]` to markdown links carrying a resolution marker
    //    URL, so comrak parses them as ordinary links we finish uniformly below.
    let prepared = wikilink::replace_wikilinks(&body, |raw| {
        wikilink_to_markdown(raw, source_path, all_paths, exists)
    });

    // 2. Parse + walk: collect the heading outline, and mark standard-link URLs.
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    // Leave `render.unsafe_` false: raw HTML in the body is escaped (read-only,
    // no XSS). We inject nothing as raw HTML — link markers ride in hrefs.
    let root = parse_document(&arena, &prepared, &options);

    // comrak emits `<hN>` for BOTH ATX and setext headings, but the pure outline
    // scan is ATX-only, so record each heading's setext-ness in document order to
    // re-align id injection: a setext `<hN>` is skipped (no id, no outline slug),
    // every ATX `<hN>` takes the next outline slug (ADR 0006 family 13 sharp edge).
    let mut heading_is_setext: Vec<bool> = Vec::new();
    for node in root.descendants() {
        if let NodeValue::Heading(h) = &node.data.borrow().value {
            heading_is_setext.push(h.setext);
        }
    }

    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        if let NodeValue::Link(link) = &mut data.value {
            link.url = mark_link_url(&link.url, source_path, all_paths, exists);
        }
    }

    let mut buf = Vec::new();
    format_html(root, &options, &mut buf).expect("comrak html formatting");
    // Add `id="<slug>"` to each ATX heading (in document order, matching the
    // outline slugs) so the Outline section can scroll the rendered view to it.
    let html = inject_heading_ids(&String::from_utf8_lossy(&buf), &outline, &heading_is_setext);
    let html = rewrite_marker_hrefs(&html);
    // Finally, substitute the CriticMarkup sentinels comrak carried through
    // (untouched, since they are private-use unicode) with our critic HTML tags.
    let html = substitute_critic_sentinels(&html, &critic_repls);
    // Substitute the citation sentinels with their superscript-link / anchor HTML.
    let html = substitute_citation_sentinels(&html, &citation_repls);

    RenderPayload {
        html,
        frontmatter,
        outline,
    }
}

/// Add `id="<slug>"` to every ATX heading open tag (`<h1>`…`<h6>`) comrak
/// emitted, in document order, from the (de-duplicated) `outline` slugs. comrak
/// emits bare heading tags for BOTH ATX and setext headings; the outline is
/// ATX-only (ADR 0006 family 13), so `heading_is_setext` (comrak-heading order)
/// tells us which `<hN>` to skip — a setext heading gets no id and consumes no
/// outline slug, keeping the k-th ATX `<hN>` aligned with the k-th outline entry.
fn inject_heading_ids(html: &str, outline: &[OutlineHeading], heading_is_setext: &[bool]) -> String {
    let re = Regex::new(r"<(h[1-6])>").unwrap();
    let mut h_idx = 0usize; // index over ALL comrak headings (ATX + setext)
    let mut o_idx = 0usize; // index over the ATX-only outline
    re.replace_all(html, |caps: &regex::Captures| {
        let tag = &caps[1];
        let is_setext = heading_is_setext.get(h_idx).copied().unwrap_or(false);
        h_idx += 1;
        if is_setext {
            return format!("<{tag}>"); // setext: dropped from the outline
        }
        let out = match outline.get(o_idx) {
            Some(h) if !h.slug.is_empty() => format!(r#"<{tag} id="{}">"#, attr_escape(&h.slug)),
            _ => format!("<{tag}>"),
        };
        o_idx += 1;
        out
    })
    .into_owned()
}

// --- Link marking -----------------------------------------------------------

const M_INTERNAL: &str = "sapint:";
const M_BROKEN: &str = "sapbroken:";
const M_EXTERNAL: &str = "sapext:";

/// Convert one wikilink inner text (`[[ raw ]]`) into markdown-link syntax whose
/// destination carries a resolution marker. Reuses `resolve_wikilink` (name
/// rules), so a resolved target is `sapint:PATH`, an unresolved one `sapbroken:`.
fn wikilink_to_markdown(
    raw: &str,
    source_path: &str,
    all_paths: &[String],
    exists: &dyn Fn(&str) -> bool,
) -> String {
    let target = parse_target(raw);
    // Obsidian shows the alias if present, else the name (or the bare anchor for
    // a pure `[[#heading]]`).
    let display = target
        .alias
        .clone()
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| {
            if target.name.is_empty() {
                target
                    .anchor
                    .clone()
                    .map(|a| format!("#{a}"))
                    .unwrap_or_default()
            } else {
                target.name.clone()
            }
        });

    let marker = match wikilink::resolve_wikilink(all_paths, source_path, raw) {
        // A resolved target that (defensively) also exists is internal; a
        // resolved-but-missing path is broken (same treatment as markdown links).
        Some(path) if exists(&path) => format!("{M_INTERNAL}{path}"),
        Some(path) => format!("{M_BROKEN}{path}"),
        None => format!("{M_BROKEN}{}", target.name),
    };

    // Angle-bracket destination tolerates spaces in the marker/path.
    format!("[{}](<{}>)", escape_link_text(&display), marker)
}

/// Decide the marker URL for a STANDARD markdown link destination, or return it
/// unchanged when it is already marked (from wikilink preprocessing) or is a
/// pure same-page anchor / empty link (left to the browser).
fn mark_link_url(
    url: &str,
    source_path: &str,
    _all_paths: &[String],
    exists: &dyn Fn(&str) -> bool,
) -> String {
    if url.starts_with(M_INTERNAL) || url.starts_with(M_BROKEN) || url.starts_with(M_EXTERNAL) {
        return url.to_string(); // already classified via wikilink preprocessing
    }
    if is_external(url) {
        return format!("{M_EXTERNAL}{url}");
    }
    if url.is_empty() || url.starts_with('#') {
        return url.to_string(); // in-page anchor / empty — leave to the browser
    }
    match resolve_internal(source_path, url) {
        Some(path) if exists(&path) => format!("{M_INTERNAL}{path}"),
        Some(path) => format!("{M_BROKEN}{path}"),
        None => url.to_string(),
    }
}

/// Rewrite the marker hrefs comrak emitted into the final anchor attributes.
fn rewrite_marker_hrefs(html: &str) -> String {
    let re = Regex::new(r#"href="(sapint|sapbroken|sapext):([^"]*)""#).unwrap();
    re.replace_all(html, |caps: &regex::Captures| {
        let payload = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        match &caps[1] {
            "sapint" => {
                let path = percent_decode(payload);
                format!(
                    r#"class="internal-link" data-path="{}" href="{}""#,
                    attr_escape(&path),
                    concept_url(&path),
                )
            }
            "sapbroken" => {
                let path = percent_decode(payload);
                format!(
                    r#"class="internal-link broken" data-path="{}" data-broken="true" href="{}""#,
                    attr_escape(&path),
                    concept_url(&path),
                )
            }
            // External: keep comrak's already-encoded href, just drop the marker
            // scheme and open in a new tab.
            _ => format!(
                r#"href="{}" target="_blank" rel="noopener noreferrer""#,
                payload
            ),
        }
    })
    .into_owned()
}

// --- Small escaping helpers -------------------------------------------------

/// Escape the characters that would break a markdown link TEXT (`[ ... ]`).
fn escape_link_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '\\' | '[' | ']') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Escape a string for use inside an HTML double-quoted attribute value.
fn attr_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Decode `%XX` percent-escapes (comrak percent-encodes hrefs, e.g. space →
/// `%20`). Invalid escapes are passed through verbatim.
fn percent_decode(s: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    fn render(body: &str, source: &str, all: &[&str]) -> RenderPayload {
        let all = paths(all);
        let set: Vec<String> = all.clone();
        render_body(body, source, &all, &move |p| set.iter().any(|x| x == p))
    }

    #[test]
    fn renders_basic_markdown_elements() {
        let p = render("# Title\n\nA paragraph.\n", "a.md", &["a.md"]);
        assert!(p.html.contains("<h1 id="));
        assert!(p.html.contains("<p>"));
        assert!(p.html.contains("A paragraph."));
    }

    #[test]
    fn resolved_markdown_link_becomes_internal_nav() {
        let p = render("[go](/good.md)", "a.md", &["a.md", "good.md"]);
        assert!(p.html.contains(r#"class="internal-link""#));
        assert!(p.html.contains(r#"data-path="good.md""#));
        assert!(p.html.contains(r#"href="/good""#));
        assert!(!p.html.contains("broken"));
    }

    #[test]
    fn relative_markdown_link_resolves_against_source_dir() {
        let p = render("[x](./sib.md)", "dir/cur.md", &["dir/sib.md"]);
        assert!(p.html.contains(r#"data-path="dir/sib.md""#));
        assert!(!p.html.contains("broken"));
    }

    #[test]
    fn resolved_wikilink_becomes_internal_nav() {
        // Bare name resolves by basename against the whole bundle.
        let p = render("see [[good]]", "a.md", &["a.md", "sub/good.md"]);
        assert!(p.html.contains(r#"class="internal-link""#));
        assert!(p.html.contains(r#"data-path="sub/good.md""#));
        // Display text is the wikilink name.
        assert!(p.html.contains(">good<"));
    }

    #[test]
    fn broken_markdown_link_is_marked_but_present() {
        let p = render("[gone](/missing.md)", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"class="internal-link broken""#));
        assert!(p.html.contains(r#"data-broken="true""#));
        assert!(p.html.contains(r#"data-path="missing.md""#));
    }

    #[test]
    fn broken_wikilink_is_marked_but_present() {
        let p = render("see [[nope]]", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"class="internal-link broken""#));
        assert!(p.html.contains(r#"data-path="nope""#));
    }

    #[test]
    fn external_link_untouched_opens_new_tab() {
        let p = render("[e](https://example.com)", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"href="https://example.com""#));
        assert!(p.html.contains(r#"target="_blank""#));
        assert!(!p.html.contains("internal-link"));
    }

    #[test]
    fn outline_lists_headings_in_order_with_slugs() {
        let p = render("# One\n\ntext\n\n## Two\n\n## Two\n", "a.md", &["a.md"]);
        let got: Vec<(u8, &str, &str)> = p
            .outline
            .iter()
            .map(|h| (h.level, h.text.as_str(), h.slug.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![(1, "One", "one"), (2, "Two", "two"), (2, "Two", "two-1")]
        );
    }

    #[test]
    fn headings_carry_id_slugs_matching_the_outline() {
        let p = render("# One\n\n## Two\n\n## Two\n", "a.md", &["a.md"]);
        // Each heading gets an id equal to its (de-duplicated) outline slug, so
        // the Outline can scroll the rendered view to it.
        assert!(p.html.contains(r#"<h1 id="one">"#));
        assert!(p.html.contains(r#"<h2 id="two">"#));
        assert!(p.html.contains(r#"<h2 id="two-1">"#));
        let slugs: Vec<&str> = p.outline.iter().map(|h| h.slug.as_str()).collect();
        assert_eq!(slugs, vec!["one", "two", "two-1"]);
    }

    #[test]
    fn fenced_code_headings_excluded_from_outline() {
        let p = render("# Real\n\n```\n# not a heading\n```\n", "a.md", &["a.md"]);
        assert_eq!(p.outline.len(), 1);
        assert_eq!(p.outline[0].text, "Real");
    }

    #[test]
    fn frontmatter_is_parsed_in_order_and_body_excludes_it() {
        let md = "---\ntype: concept\ntitle: Hello\ntags:\n  - a\n  - b\n---\n# Body\n";
        let p = render(md, "a.md", &["a.md"]);
        let keys: Vec<&str> = p.frontmatter.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["type", "title", "tags"]);
        let tags = &p.frontmatter.iter().find(|f| f.key == "tags").unwrap().values;
        assert_eq!(tags, &vec!["a".to_string(), "b".to_string()]);
        // The `---` frontmatter fences must not leak into the rendered body.
        assert!(!p.html.contains("type: concept"));
        assert!(p.html.contains("<h1 id="));
    }

    #[test]
    fn wikilink_inside_code_is_not_a_link() {
        let p = render("`[[good]]`", "a.md", &["a.md", "good.md"]);
        assert!(!p.html.contains("internal-link"));
        assert!(p.html.contains("<code>"));
    }

    #[test]
    fn mermaid_fence_emits_language_class_and_is_left_inert() {
        // comrak leaves a ```mermaid fence as an inert code block; the web island
        // hydrates it client-side. Confirm the stable `language-mermaid` marker
        // the island targets, and that the source is preserved verbatim.
        let p = render("```mermaid\ngraph TD;\nA-->B;\n```\n", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"class="language-mermaid""#));
        assert!(p.html.contains("graph TD"));
        // A fenced code block is not a heading → excluded from the outline.
        assert!(p.outline.is_empty());
    }
}
