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

use std::collections::HashMap;
use std::path::Path;

use comrak::nodes::NodeValue;
use comrak::{format_html, parse_document, Arena, Options};
use regex::Regex;
use serde::Serialize;

use crate::bundle;
use crate::index::frontmatter::{frontmatter_block, strip_frontmatter};
use crate::index::Index;
use crate::paths::{is_external, resolve_internal};
use crate::slug::slugify;
use crate::wikilink::{self, parse_target};

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
    /// Headings in document order (frontmatter + fenced code excluded).
    pub outline: Vec<OutlineHeading>,
}

/// One frontmatter entry for the read-only Properties view. A scalar has a
/// single value; a sequence (e.g. `tags`) has several.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterField {
    pub key: String,
    pub values: Vec<String>,
}

/// One outline heading: level (1–6), text, and its de-duplicated GitHub slug.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineHeading {
    pub level: u8,
    pub text: String,
    pub slug: String,
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

    let mut headings: Vec<(u8, String)> = Vec::new();
    for node in root.descendants() {
        let level = match &node.data.borrow().value {
            NodeValue::Heading(h) => h.level,
            _ => continue,
        };
        headings.push((level, node_text(node)));
    }

    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        if let NodeValue::Link(link) = &mut data.value {
            link.url = mark_link_url(&link.url, source_path, all_paths, exists);
        }
    }

    let outline = build_outline(headings);

    let mut buf = Vec::new();
    format_html(root, &options, &mut buf).expect("comrak html formatting");
    // Add `id="<slug>"` to each heading (in document order, matching the outline
    // slugs) so the Outline section can scroll the rendered view to a heading.
    let html = inject_heading_ids(&String::from_utf8_lossy(&buf), &outline);
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

/// Add `id="<slug>"` to every heading open tag (`<h1>`…`<h6>`) comrak emitted,
/// in document order, from the (de-duplicated) `outline` slugs. comrak emits
/// bare heading tags; headings and the outline are both in document order, so
/// the k-th `<hN>` gets the k-th outline slug — the anchor the Outline links to.
fn inject_heading_ids(html: &str, outline: &[OutlineHeading]) -> String {
    let re = Regex::new(r"<(h[1-6])>").unwrap();
    let mut idx = 0usize;
    re.replace_all(html, |caps: &regex::Captures| {
        let tag = &caps[1];
        let out = match outline.get(idx) {
            Some(h) if !h.slug.is_empty() => format!(r#"<{tag} id="{}">"#, attr_escape(&h.slug)),
            _ => format!("<{tag}>"),
        };
        idx += 1;
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

// --- CriticMarkup -----------------------------------------------------------
//
// A pure Rust scanner mirroring the TS `parseCriticMarks` in
// `src/lib/editor/criticMarkup.ts` (house pattern: cf. `index/frontmatter.rs`
// mirrors `frontmatter.ts`). It renders the five CriticMarkup marks to the HTML
// the downstream CSS depends on (matching the desktop CM view's vocabulary:
// green add / red del / amber highlight, NO underline/strikethrough):
//
//   {++X++}       -> <ins class="critic-add">X</ins>
//   {--X--}       -> <del class="critic-del">X</del>
//   {~~O~>N~~}    -> <del class="critic-del">O</del><ins class="critic-add">N</ins>
//   {==X==}       -> <mark class="critic-highlight">X</mark>
//   {>>NOTE<<}    -> an inline, print-safe bordered callout carrying NOTE
//
// The delimiter-sentinel technique keeps `render.unsafe_` OFF: only the
// delimiters (never the inner content) are swapped for sentinel tokens before
// comrak, so the inner text is still markdown-rendered/escaped by comrak; the
// sentinels are then swapped for our tags after comrak. Sentinels are a
// private-use-area pair around a decimal id (`\u{E000}<id>\u{E001}`) — comrak
// treats them as ordinary text and neither escapes nor mangles them.
//
// CriticMarkup marks apply to the BODY only; frontmatter/outline/wikilinks are
// untouched. An unterminated open (no matching close) is NOT a mark: it stays as
// literal text (comrak escapes it like any other text).

const SENT_OPEN: char = '\u{E000}';
const SENT_CLOSE: char = '\u{E001}';

const CRITIC_INS_OPEN: &str = r#"<ins class="critic-add">"#;
const CRITIC_INS_CLOSE: &str = "</ins>";
const CRITIC_DEL_OPEN: &str = r#"<del class="critic-del">"#;
const CRITIC_DEL_CLOSE: &str = "</del>";
const CRITIC_MARK_OPEN: &str = r#"<mark class="critic-highlight">"#;
const CRITIC_MARK_CLOSE: &str = "</mark>";
/// Substitution's middle: close the deleted `<del>` and open the inserted
/// `<ins>`, adjacent, so `{~~O~>N~~}` renders `…O</del><ins …>N…`.
const CRITIC_SUB_MID: &str = r#"</del><ins class="critic-add">"#;

/// Speech-bubble icon (mirrors `COMMENT_ICON_SVG` in `criticMarkupView.ts`) —
/// the visual vocabulary for a comment, reused so print matches the editor.
const CRITIC_COMMENT_SVG: &str = concat!(
    r#"<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">"#,
    r#"<path fill="currentColor" d="M2.5 2.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6.6L3.7 14a.5.5 0 0 1-.85-.35V11.5H2.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z"/>"#,
    r#"</svg>"#,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CriticKind {
    Addition,
    Deletion,
    Substitution,
    Comment,
    Highlight,
}

/// The 3-char opening delimiter at `chars[i..]`, if any, and its mark kind.
fn critic_open_at(chars: &[char], i: usize) -> Option<CriticKind> {
    if i + 3 > chars.len() {
        return None;
    }
    match (chars[i], chars[i + 1], chars[i + 2]) {
        ('{', '+', '+') => Some(CriticKind::Addition),
        ('{', '-', '-') => Some(CriticKind::Deletion),
        ('{', '~', '~') => Some(CriticKind::Substitution),
        ('{', '>', '>') => Some(CriticKind::Comment),
        ('{', '=', '=') => Some(CriticKind::Highlight),
        _ => None,
    }
}

/// The 3-char closing delimiter for a mark kind.
fn critic_close(kind: CriticKind) -> [char; 3] {
    match kind {
        CriticKind::Addition => ['+', '+', '}'],
        CriticKind::Deletion => ['-', '-', '}'],
        CriticKind::Substitution => ['~', '~', '}'],
        CriticKind::Comment => ['<', '<', '}'],
        CriticKind::Highlight => ['=', '=', '}'],
    }
}

/// Index of the closing `seq` at or after `start`, or `None`.
fn find_close(chars: &[char], start: usize, seq: [char; 3]) -> Option<usize> {
    if chars.len() < 3 {
        return None;
    }
    let mut i = start;
    while i + 3 <= chars.len() {
        if chars[i] == seq[0] && chars[i + 1] == seq[1] && chars[i + 2] == seq[2] {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Scan `body` for CriticMarkup marks (non-overlapping, left-to-right, mirroring
/// `parseCriticMarks`) and rewrite each mark's DELIMITERS to sentinel tokens,
/// keeping its inner content in the markdown stream. Returns the prepared body
/// plus the replacement HTML for each sentinel (indexed by the sentinel's id).
fn critic_to_sentinels(body: &str) -> (String, Vec<String>) {
    let chars: Vec<char> = body.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(body.len());
    let mut repls: Vec<String> = Vec::new();

    // Emit a sentinel for `html`, recording the replacement under a fresh id.
    let sentinel = |out: &mut String, repls: &mut Vec<String>, html: &str| {
        let id = repls.len();
        repls.push(html.to_string());
        out.push(SENT_OPEN);
        out.push_str(&id.to_string());
        out.push(SENT_CLOSE);
    };

    let mut i = 0;
    while i < n {
        if let Some(kind) = critic_open_at(&chars, i) {
            if let Some(close_idx) = find_close(&chars, i + 3, critic_close(kind)) {
                let content: String = chars[i + 3..close_idx].iter().collect();
                match kind {
                    CriticKind::Addition => {
                        sentinel(&mut out, &mut repls, CRITIC_INS_OPEN);
                        out.push_str(&content);
                        sentinel(&mut out, &mut repls, CRITIC_INS_CLOSE);
                    }
                    CriticKind::Deletion => {
                        sentinel(&mut out, &mut repls, CRITIC_DEL_OPEN);
                        out.push_str(&content);
                        sentinel(&mut out, &mut repls, CRITIC_DEL_CLOSE);
                    }
                    CriticKind::Highlight => {
                        sentinel(&mut out, &mut repls, CRITIC_MARK_OPEN);
                        out.push_str(&content);
                        sentinel(&mut out, &mut repls, CRITIC_MARK_CLOSE);
                    }
                    CriticKind::Substitution => {
                        // The FIRST `~>` splits old/new (as in the TS scanner);
                        // with none present, render the whole inner as a deletion.
                        if let Some(pos) = content.find("~>") {
                            let (deleted, inserted) = (&content[..pos], &content[pos + 2..]);
                            sentinel(&mut out, &mut repls, CRITIC_DEL_OPEN);
                            out.push_str(deleted);
                            sentinel(&mut out, &mut repls, CRITIC_SUB_MID);
                            out.push_str(inserted);
                            sentinel(&mut out, &mut repls, CRITIC_INS_CLOSE);
                        } else {
                            sentinel(&mut out, &mut repls, CRITIC_DEL_OPEN);
                            out.push_str(&content);
                            sentinel(&mut out, &mut repls, CRITIC_DEL_CLOSE);
                        }
                    }
                    CriticKind::Comment => {
                        // The note is plain text (NOT markdown-rendered), escaped
                        // into a self-contained callout injected whole. Placed at
                        // the comment's own position: for a bound comment (right
                        // after a highlight) that is directly after the highlight's
                        // `</mark>`; for a point comment, at the comment's spot.
                        sentinel(&mut out, &mut repls, &critic_comment_callout(&content));
                    }
                }
                i = close_idx + 3;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }

    (out, repls)
}

/// Build the inline, print-safe comment callout carrying the (HTML-escaped)
/// `note`. Inline (a `<span>`, not a block) so it nests validly inside comrak's
/// `<p>` wrappers; visible (not hover-only) so the PDF export shows it.
fn critic_comment_callout(note: &str) -> String {
    format!(
        r#"<span class="critic-comment"><span class="critic-comment-icon" aria-hidden="true">{svg}</span><span class="critic-comment-text">{note}</span></span>"#,
        svg = CRITIC_COMMENT_SVG,
        note = attr_escape(note),
    )
}

/// Substitute the CriticMarkup sentinels (`\u{E000}<id>\u{E001}`) comrak carried
/// through with their recorded HTML replacements. This injects OUR critic tags
/// only — nothing else in the body is emitted as raw HTML.
fn substitute_critic_sentinels(html: &str, repls: &[String]) -> String {
    if repls.is_empty() {
        return html.to_string();
    }
    let re = Regex::new("\u{E000}(\\d+)\u{E001}").unwrap();
    re.replace_all(html, |caps: &regex::Captures| {
        caps[1]
            .parse::<usize>()
            .ok()
            .and_then(|id| repls.get(id))
            .cloned()
            .unwrap_or_default()
    })
    .into_owned()
}

// --- Citation references (citation-superscripts) ----------------------------
//
// Mirrors the pure TS rules in `src/lib/citations.ts` so the exported PDF / web
// render matches the live editor:
//   - an inline `[n]` that FOLLOWS a word (preceded by a non-whitespace char
//     that is not `[`, and not trailed by `]`/`(`/`:`) → a superscript link to
//     the citation-table row;
//   - a line-start `[n]` (the table rows) → the literal `[n]` jump TARGET
//     carrying `id="cite-n"` (NOT superscript — a superscript row head reads
//     wrong);
//   - anything else → left untouched.
// A distinct PUA sentinel pair (from the CriticMarkup one) keeps the two
// substitution passes independent.

const CITE_OPEN: char = '\u{E002}';
const CITE_CLOSE: char = '\u{E003}';

/// Superscript link standing in for an inline `[n]` reference.
fn citation_ref_html(num: &str) -> String {
    format!(r##"<sup class="citation-ref"><a href="#cite-{num}">[{num}]</a></sup>"##)
}

/// Literal, anchored `[n]` for a citation-table row (the jump target).
fn citation_def_html(num: &str) -> String {
    format!(r#"<a id="cite-{num}" class="citation-def">[{num}]</a>"#)
}

/// Rewrite citation markers in `body` to sentinel tokens, returning the prepared
/// body plus the replacement HTML for each sentinel id.
fn citations_to_sentinels(body: &str) -> (String, Vec<String>) {
    let chars: Vec<char> = body.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(body.len());
    let mut repls: Vec<String> = Vec::new();

    let sentinel = |out: &mut String, repls: &mut Vec<String>, html: String| {
        let id = repls.len();
        repls.push(html);
        out.push(CITE_OPEN);
        out.push_str(&id.to_string());
        out.push(CITE_CLOSE);
    };

    let mut i = 0;
    while i < n {
        if chars[i] == '[' {
            // Match `[` <digits> `]`.
            let mut j = i + 1;
            while j < n && chars[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && j < n && chars[j] == ']' {
                let num: String = chars[i + 1..j].iter().collect();
                let before = if i > 0 { Some(chars[i - 1]) } else { None };
                let after = if j + 1 < n { Some(chars[j + 1]) } else { None };

                // Line-start `[n]` (only whitespace back to the newline) = table row.
                let mut k = i;
                let mut at_line_start = true;
                while k > 0 {
                    let c = chars[k - 1];
                    if c == '\n' {
                        break;
                    }
                    if !c.is_whitespace() {
                        at_line_start = false;
                        break;
                    }
                    k -= 1;
                }

                if at_line_start {
                    sentinel(&mut out, &mut repls, citation_def_html(&num));
                    i = j + 1;
                    continue;
                }

                // Reference: follows a word, and no disambiguating trailer.
                let trailer_ok = !matches!(after, Some(']') | Some('(') | Some(':'));
                let follows_word = matches!(before, Some(b) if !b.is_whitespace() && b != '[');
                if trailer_ok && follows_word {
                    sentinel(&mut out, &mut repls, citation_ref_html(&num));
                    i = j + 1;
                    continue;
                }
                // Neither: fall through and emit the `[` literally.
            }
        }
        out.push(chars[i]);
        i += 1;
    }

    (out, repls)
}

/// Substitute the citation sentinels (`\u{E002}<id>\u{E003}`) with their HTML.
fn substitute_citation_sentinels(html: &str, repls: &[String]) -> String {
    if repls.is_empty() {
        return html.to_string();
    }
    let re = Regex::new("\u{E002}(\\d+)\u{E003}").unwrap();
    re.replace_all(html, |caps: &regex::Captures| {
        caps[1]
            .parse::<usize>()
            .ok()
            .and_then(|id| repls.get(id))
            .cloned()
            .unwrap_or_default()
    })
    .into_owned()
}

// --- Frontmatter + outline --------------------------------------------------

fn frontmatter_fields(content: &str) -> Vec<FrontmatterField> {
    let Some(block) = frontmatter_block(content) else {
        return Vec::new();
    };
    let value: serde_yaml::Value = match serde_yaml::from_str(block) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(map) = value.as_mapping() else {
        return Vec::new();
    };
    // serde_yaml::Mapping preserves insertion order.
    map.iter()
        .filter_map(|(k, v)| {
            k.as_str().map(|key| FrontmatterField {
                key: key.to_string(),
                values: yaml_values(v),
            })
        })
        .collect()
}

fn yaml_values(v: &serde_yaml::Value) -> Vec<String> {
    match v {
        serde_yaml::Value::Sequence(seq) => seq.iter().map(scalar_string).collect(),
        _ => vec![scalar_string(v)],
    }
}

fn scalar_string(v: &serde_yaml::Value) -> String {
    match v {
        serde_yaml::Value::String(s) => s.clone(),
        serde_yaml::Value::Bool(b) => b.to_string(),
        serde_yaml::Value::Number(n) => n.to_string(),
        serde_yaml::Value::Null => String::new(),
        other => serde_yaml::to_string(other)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

/// De-duplicate heading slugs in document order (`notes`, `notes-1`, …), the
/// same rule as the desktop `slugifyHeadings`.
fn build_outline(headings: Vec<(u8, String)>) -> Vec<OutlineHeading> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    headings
        .into_iter()
        .map(|(level, text)| {
            let base = slugify(&text);
            let n = counts.entry(base.clone()).or_insert(0);
            let slug = if *n == 0 {
                base.clone()
            } else {
                format!("{base}-{n}")
            };
            *n += 1;
            OutlineHeading { level, text, slug }
        })
        .collect()
}

/// Concatenate the visible text of a node's inline descendants (Text + inline
/// Code), trimmed. Used to derive a heading's outline text.
fn node_text<'a>(node: &'a comrak::nodes::AstNode<'a>) -> String {
    let mut s = String::new();
    for d in node.descendants() {
        match &d.data.borrow().value {
            NodeValue::Text(t) => s.push_str(t),
            NodeValue::Code(c) => s.push_str(&c.literal),
            _ => {}
        }
    }
    s.trim().to_string()
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

/// Percent-encode a value for a query-string parameter (like encodeURIComponent:
/// keep unreserved chars, `%XX` everything else, including `/`).
fn query_encode(s: &str) -> String {
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

/// A Concept's bundle path → its pretty viewer URL pathname, mirroring the
/// frontend `conceptToUrl`: drop a trailing `.md` and a trailing `/index`, map
/// the root `index.md` to `/`, and percent-encode each path segment. So
/// `providers/index.md` → `/providers` and `research/providers/x.md` →
/// `/research/providers/x`.
fn concept_url(path: &str) -> String {
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

    // --- CriticMarkup rendering ---------------------------------------------
    // The exact HTML emitted here is the contract downstream CSS/tests match.

    #[test]
    fn critic_addition_renders_ins() {
        let p = render("{++added++}", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"<ins class="critic-add">added</ins>"#));
        // Delimiters are stripped — raw CriticMarkup never surfaces.
        assert!(!p.html.contains("{++"));
    }

    #[test]
    fn critic_deletion_renders_del() {
        let p = render("{--removed--}", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"<del class="critic-del">removed</del>"#));
        assert!(!p.html.contains("{--"));
    }

    #[test]
    fn critic_substitution_renders_del_then_ins_adjacent() {
        let p = render("{~~old~>new~~}", "a.md", &["a.md"]);
        assert!(p.html.contains(
            r#"<del class="critic-del">old</del><ins class="critic-add">new</ins>"#
        ));
        assert!(!p.html.contains("~>"));
    }

    #[test]
    fn critic_substitution_without_arrow_is_a_deletion() {
        let p = render("{~~gone~~}", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"<del class="critic-del">gone</del>"#));
        assert!(!p.html.contains("critic-add"));
    }

    #[test]
    fn critic_highlight_renders_mark() {
        let p = render("{==important==}", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"<mark class="critic-highlight">important</mark>"#));
        assert!(!p.html.contains("{=="));
    }

    #[test]
    fn critic_point_comment_renders_inline_callout() {
        let p = render("before {>>a note<<} after", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"<span class="critic-comment">"#));
        assert!(p.html.contains(r#"<span class="critic-comment-icon" aria-hidden="true">"#));
        assert!(p.html.contains(r#"<span class="critic-comment-text">a note</span>"#));
        assert!(!p.html.contains("{>>"));
        // The surrounding prose is preserved around the point callout.
        assert!(p.html.contains("before "));
        assert!(p.html.contains(" after"));
    }

    #[test]
    fn critic_bound_comment_follows_the_highlight_content() {
        // A comment directly after a highlight (bound) lands right after the
        // highlight's `</mark>`, ahead of the callout span.
        let p = render("{==term==}{>>see me<<}", "a.md", &["a.md"]);
        assert!(p.html.contains(
            r#"<mark class="critic-highlight">term</mark><span class="critic-comment">"#
        ));
        assert!(p.html.contains(r#"<span class="critic-comment-text">see me</span>"#));
    }

    #[test]
    fn markdown_inside_a_mark_is_still_rendered() {
        // Only the delimiters become sentinels; the inner content stays in the
        // markdown stream, so comrak bolds it inside the <ins>.
        let p = render("{++**bold**++}", "a.md", &["a.md"]);
        assert!(p.html.contains(r#"<ins class="critic-add"><strong>bold</strong></ins>"#));
    }

    #[test]
    fn unterminated_open_is_not_a_mark() {
        // No matching close → not a mark: the text stays literal (comrak escapes
        // it as ordinary text) and no critic tag is injected.
        let p = render("{++ dangling with no close", "a.md", &["a.md"]);
        assert!(!p.html.contains("critic-add"));
        assert!(p.html.contains("{++ dangling with no close"));
    }

    #[test]
    fn comment_note_text_is_html_escaped() {
        let p = render("{>>a < b & c > d<<}", "a.md", &["a.md"]);
        assert!(p.html.contains("a &lt; b &amp; c &gt; d"));
        // The raw angle/amp must not leak into the note text.
        assert!(!p.html.contains("a < b & c"));
    }

    #[test]
    fn critic_sentinels_do_not_survive_into_output() {
        let p = render("{++x++} {==y==}{>>z<<} {~~o~>n~~}", "a.md", &["a.md"]);
        assert!(!p.html.contains(SENT_OPEN));
        assert!(!p.html.contains(SENT_CLOSE));
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

    #[test]
    fn inline_citation_becomes_superscript_link() {
        let p = render("deepen umami and body.[6][7][8]\n", "a.md", &["a.md"]);
        // Each reference is its own superscript link to the matching row, with
        // the `[n]` brackets kept around the clickable number.
        assert!(p
            .html
            .contains(r##"<sup class="citation-ref"><a href="#cite-6">[6]</a></sup>"##));
        assert!(p.html.contains(r##"href="#cite-7">[7]<"##));
        assert!(p.html.contains(r##"href="#cite-8">[8]<"##));
        // comrak's stray URL-less reference link is gone — the only `[7]` left is
        // the one inside our superscript anchor, never bare text.
        assert!(!p.html.contains(">[7]</a></sup>[7]"));
    }

    #[test]
    fn citation_table_row_is_literal_anchor_not_superscript() {
        let p = render("body.[6]\n\n[6] Kokumi source. https://x.y\n", "a.md", &["a.md"]);
        // The table row keeps literal `[6]` and carries the jump-target id.
        assert!(p
            .html
            .contains(r#"<a id="cite-6" class="citation-def">[6]</a>"#));
        // …and is NOT wrapped in a superscript.
        assert!(!p.html.contains(r##"<sup class="citation-ref"><a href="#cite-6">[6]</a></sup> Kokumi"##));
    }

    #[test]
    fn bracketed_number_not_following_a_word_is_left_alone() {
        // Space-preceded `[6]` is neither a reference nor a table row: untouched.
        let p = render("a paragraph [6] mid-sentence\n", "a.md", &["a.md"]);
        assert!(p.html.contains("[6]"));
        assert!(!p.html.contains("citation-ref"));
        assert!(!p.html.contains("citation-def"));
    }
}
