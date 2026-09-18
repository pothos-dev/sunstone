//! The **Embed** pass of the SSR render (ei-1, ADR-0010/ADR-0011).
//!
//! An Embed (`![alt](path.png)` / `![[name.png]]`) points at an **Attachment** —
//! a non-`.md` file in the Bundle. comrak emits the author's raw relative `src`
//! for the first form and does not know the second at all, so both 404 in the
//! web viewer and in the desktop print/PDF window. This pass gives every Embed a
//! `src` the surrounding shell can actually fetch.
//!
//! ## Why a mapper and not a prefix
//!
//! ADR-0011 wrote "an asset-URL **prefix** parameter". That turned out to be
//! wrong: the two shells' URL shapes are not prefix-compatible.
//!
//! * desktop — `sunstone-asset://localhost/<encodeURIComponent(path)>`, where
//!   the WHOLE path is one percent-encoded segment (`a/b.png` → `a%2Fb.png`);
//! * web — `/api/asset?path=<percent-encoded path>`, a query value.
//!
//! No string prefix produces both, so the renderer takes a
//! `&dyn Fn(&str) -> String` mapping a bundle-relative path to a URL and each
//! shell supplies its own. See [`super::render_concept`]'s callers.
//!
//! ## Two stages, mirroring `critic.rs` / `citations.rs`
//!
//! `render.unsafe_` is deliberately `false` in this pipeline, so nothing may be
//! injected as raw HTML *into the markdown*. Instead:
//!
//! 1. **Before comrak** ([`embeds_to_markers`]) every Embed found by
//!    [`embed::scan_embeds`] is replaced — in the markdown stream, by byte span —
//!    with `![](sapembed:N)`, an ordinary markdown image whose destination is an
//!    index into a side table. This is also how `![[ … ]]` reaches comrak at all:
//!    `wikilink::replace_wikilinks` deliberately SKIPS embeds (see the asymmetry
//!    note in `sunstone_shared::embed`) and `wikilink.rs` stays untouched.
//! 2. **After comrak** ([`rewrite_embed_markers`]) each emitted
//!    `<img src="sapembed:N" …>` is replaced by the final markup for table entry
//!    `N` — exactly the technique `rewrite_marker_hrefs` uses for links.
//!
//! Every value interpolated into that markup is attribute-escaped here, since it
//! is author-controlled text arriving after comrak has stopped escaping.
//!
//! ## What renders as what (ADR-0011's failure states)
//!
//! | target | result |
//! |---|---|
//! | in-Bundle image that exists | `<img class="embed-image" src="<mapped>">` |
//! | in-Bundle image that does not | `<span class="embed-broken" data-broken="true">` |
//! | `http:` / `https:` | `<button class="embed-remote">` — click-to-load, never auto-fetched |
//! | `data:` | nothing at all |
//! | any other `scheme:`, or a non-image extension | left exactly as the author wrote it (out of scope until `al-1`) |
//!
//! The remote case is the one with teeth: on the web shell the author and the
//! reader are different people, so opening a Concept must not fire a tracking
//! pixel from the reader's browser and IP.

use std::sync::LazyLock;

use regex::Regex;

use sunstone_shared::embed::{self, EmbedKind, EmbedTargetKind};

/// The marker scheme an Embed's destination carries through comrak. Chosen to
/// match the `sap…:` family the link markers already use.
const M_EMBED: &str = "sapembed:";

/// What one Embed renders as, once resolved. One entry per marker index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum EmbedRender {
    /// A resolved in-Bundle Attachment: a real `<img>` at a shell-mapped URL.
    Image {
        /// The URL the shell's mapper produced.
        src: String,
        /// The accessible name the kernel already resolved (`Embed.alt`).
        alt: String,
        /// `width` / `height` as a CSS declaration list, never HTML attributes —
        /// an HTML attribute would corrupt the editor's URL-keyed
        /// `dimensionCache`, which stores NATURAL dimensions (ticket decision).
        style: Option<String>,
    },
    /// Unresolvable: a visible placeholder, never an abort.
    Broken {
        /// What the author asked for, shown so the mistake is findable.
        target: String,
        alt: String,
    },
    /// `http:` / `https:`: a neutral click-to-load affordance that fetches
    /// nothing until a reader asks for it.
    Remote {
        src: String,
        alt: String,
        style: Option<String>,
    },
    /// A `data:` URI — renders nothing at all.
    Dropped,
}

/// Build the CSS declarations for a requested size, or `None` when the author
/// asked for no size. Height without width is not expressible in the Embed
/// syntax (`|300x200` always carries the width), so only these two shapes exist.
fn size_style(width: Option<u32>, height: Option<u32>) -> Option<String> {
    match (width, height) {
        (Some(w), Some(h)) => Some(format!("width:{w}px;height:{h}px")),
        (Some(w), None) => Some(format!("width:{w}px")),
        _ => None,
    }
}

/// Replace every Embed in `body` with a `![](sapembed:N)` marker image, and
/// return the rewritten body plus the side table the markers index.
///
/// * `source_path` — the embedding Concept, for relative path resolution;
/// * `attachments` — every Attachment path in the Bundle (the separate index
///   ei-1 keeps apart from `all_paths`), used BOTH to resolve `![[name.png]]` by
///   name and to decide whether a path-resolved Embed actually exists;
/// * `asset_url` — the shell's bundle-relative-path → URL mapper.
///
/// Runs on the raw (frontmatter-stripped) body, BEFORE the CriticMarkup and
/// citation sentinel passes: those rewrite bytes, and an Embed's alt text must
/// not pick up a private-use sentinel that a later pass would expand into HTML
/// tags inside an attribute value.
pub(super) fn embeds_to_markers(
    body: &str,
    source_path: &str,
    attachments: &[String],
    asset_url: &dyn Fn(&str) -> String,
) -> (String, Vec<EmbedRender>) {
    let found = embed::scan_embeds(body);
    if found.is_empty() {
        return (body.to_string(), Vec::new());
    }

    let mut table: Vec<EmbedRender> = Vec::new();
    let mut out = String::with_capacity(body.len());
    let mut cursor = 0usize;

    for e in found {
        let render = match embed::classify_target(&e.target) {
            EmbedTargetKind::Data => Some(EmbedRender::Dropped),
            EmbedTargetKind::Remote => Some(EmbedRender::Remote {
                src: e.target.trim().to_string(),
                alt: e.alt.clone(),
                style: size_style(e.width, e.height),
            }),
            // `mailto:`, `file:`, `c:/…` — not an Attachment and not something
            // this ticket renders. Left byte-for-byte as the author wrote it.
            EmbedTargetKind::OtherScheme => None,
            EmbedTargetKind::Local => {
                if !embed::is_image_path(&e.target) {
                    // A non-image Attachment (and a `![[concept]]` transclusion)
                    // keeps today's literal rendering until `al-1`.
                    None
                } else {
                    let resolved = match e.kind {
                        EmbedKind::Path => embed::resolve_embed_path(source_path, &e.target),
                        EmbedKind::Name => embed::resolve_embed_name(attachments, &e.target),
                    };
                    Some(match resolved {
                        Some(path) if attachments.iter().any(|a| a == &path) => EmbedRender::Image {
                            src: asset_url(&path),
                            alt: e.alt.clone(),
                            style: size_style(e.width, e.height),
                        },
                        // Resolved but absent, or not resolvable at all: the
                        // author still sees WHAT was asked for.
                        Some(path) => EmbedRender::Broken {
                            target: path,
                            alt: e.alt.clone(),
                        },
                        None => EmbedRender::Broken {
                            target: e.target.trim().to_string(),
                            alt: e.alt.clone(),
                        },
                    })
                }
            }
        };

        // An author who literally writes `![](sapembed:0)` would otherwise hand
        // themselves another Embed's markup (a display quirk, not an escape —
        // every table entry comes from the same document). Drop it instead.
        let render = if e.target.trim_start().starts_with(M_EMBED) {
            Some(EmbedRender::Dropped)
        } else {
            render
        };

        let Some(render) = render else { continue };
        out.push_str(&body[cursor..e.from]);
        out.push_str(&format!("![]({M_EMBED}{})", table.len()));
        table.push(render);
        cursor = e.to;
    }
    out.push_str(&body[cursor..]);

    (out, table)
}

/// Replace each `<img src="sapembed:N" …>` comrak emitted with the final markup
/// for table entry `N`.
///
/// Everything emitted here is INLINE-level (`<span>` / `<button>` / `<img>`):
/// comrak puts a lone image inside a `<p>`, and a block element there would make
/// the browser close the paragraph early and reflow the rest of the Concept.
pub(super) fn rewrite_embed_markers(html: &str, table: &[EmbedRender]) -> String {
    if table.is_empty() {
        return html.to_string();
    }
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"<img src="sapembed:(\d+)"[^>]*>"#).unwrap());
    RE.replace_all(html, |caps: &regex::Captures| {
        let idx: usize = caps[1].parse().unwrap_or(usize::MAX);
        match table.get(idx) {
            Some(r) => render_markup(r),
            // Unreachable for markers this module produced; leaving the tag in
            // place is a visible-but-harmless failure rather than a panic.
            None => caps[0].to_string(),
        }
    })
    .into_owned()
}

/// The final HTML for one table entry. Every interpolated value is
/// attribute-escaped: this runs after comrak has stopped escaping, and the
/// values are author-controlled.
fn render_markup(r: &EmbedRender) -> String {
    match r {
        EmbedRender::Image { src, alt, style } => format!(
            r#"<img class="embed-image" src="{}" alt="{}" loading="lazy"{} />"#,
            attr(src),
            attr(alt),
            style_attr(style),
        ),
        EmbedRender::Broken { target, alt } => format!(
            r#"<span class="embed-broken" data-broken="true" data-embed-target="{}" title="Attachment not found: {}">Missing attachment: {}</span>"#,
            attr(target),
            attr(target),
            attr(alt),
        ),
        // The URL rides in `data-embed-src`, NOT in `src`: the whole point is
        // that the browser must not fetch it until a reader clicks.
        EmbedRender::Remote { src, alt, style } => format!(
            r#"<button type="button" class="embed-remote" data-embed-src="{}" data-embed-alt="{}" data-embed-style="{}" title="{}">Load remote image</button>"#,
            attr(src),
            attr(alt),
            attr(style.as_deref().unwrap_or("")),
            attr(src),
        ),
        EmbedRender::Dropped => String::new(),
    }
}

/// ` style="…"`, or nothing.
fn style_attr(style: &Option<String>) -> String {
    match style {
        Some(s) => format!(r#" style="{}""#, attr(s)),
        None => String::new(),
    }
}

/// Escape for an HTML double-quoted attribute value (and for text content, whose
/// needs are a subset). A thin alias so this module reads as self-contained.
fn attr(s: &str) -> String {
    super::attr_escape(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atts(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    fn web(path: &str) -> String {
        format!(
            "/api/asset?path={}",
            sunstone_shared::url::query_encode(path)
        )
    }

    fn markers(body: &str, source: &str, attachments: &[&str]) -> (String, Vec<EmbedRender>) {
        embeds_to_markers(body, source, &atts(attachments), &web)
    }

    #[test]
    fn a_markdown_embed_becomes_a_marker_and_a_table_entry() {
        let (out, table) = markers("![a](img.png)", "a.md", &["img.png"]);
        assert_eq!(out, "![](sapembed:0)");
        assert_eq!(
            table,
            vec![EmbedRender::Image {
                src: "/api/asset?path=img.png".into(),
                alt: "a".into(),
                style: None,
            }]
        );
    }

    #[test]
    fn a_wikilink_embed_resolves_by_name() {
        let (out, table) = markers("x ![[logo.png]] y", "deep/a.md", &["assets/logo.png"]);
        assert_eq!(out, "x ![](sapembed:0) y");
        assert_eq!(
            table,
            vec![EmbedRender::Image {
                src: web("assets/logo.png"),
                alt: "logo.png".into(),
                style: None,
            }]
        );
    }

    #[test]
    fn a_non_image_embed_is_left_untouched() {
        // Out of scope until `al-1`: a non-image Attachment and a `![[concept]]`
        // transclusion both keep today's literal rendering.
        let (out, table) = markers("![d](notes.pdf) ![[other]]", "a.md", &["notes.pdf"]);
        assert_eq!(out, "![d](notes.pdf) ![[other]]");
        assert!(table.is_empty());
    }

    #[test]
    fn an_other_scheme_embed_is_left_untouched() {
        let (out, table) = markers("![m](mailto:a@b.c)", "a.md", &[]);
        assert_eq!(out, "![m](mailto:a@b.c)");
        assert!(table.is_empty());
    }

    #[test]
    fn a_forged_marker_target_is_dropped_rather_than_impersonating_an_entry() {
        let (_, table) = markers("![](sapembed:0) ![x](img.png)", "a.md", &["img.png"]);
        assert_eq!(table[0], EmbedRender::Dropped);
    }

    #[test]
    fn markup_never_emits_a_block_element() {
        // comrak wraps a lone image in a `<p>`; a block element there would close
        // the paragraph early in the browser.
        for r in [
            EmbedRender::Image {
                src: "u".into(),
                alt: "a".into(),
                style: None,
            },
            EmbedRender::Broken {
                target: "t".into(),
                alt: "a".into(),
            },
            EmbedRender::Remote {
                src: "https://e/x.png".into(),
                alt: "a".into(),
                style: None,
            },
        ] {
            let html = render_markup(&r);
            for block in ["<div", "<p", "<figure", "<section"] {
                assert!(!html.contains(block), "{html} contains {block}");
            }
        }
    }

    #[test]
    fn author_text_is_attribute_escaped_in_the_emitted_markup() {
        let html = render_markup(&EmbedRender::Broken {
            target: r#"a"><script>x</script>"#.into(),
            alt: "alt".into(),
        });
        assert!(!html.contains("<script>"));
        assert!(html.contains("&quot;&gt;&lt;script&gt;"));
    }
}
