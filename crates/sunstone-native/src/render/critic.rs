//! CriticMarkup rendering.
//!
//! A pure Rust scanner mirroring the TS `parseCriticMarks` in
//! `src/lib/editor/criticMarkup.ts` (house pattern: cf. `index/frontmatter.rs`
//! mirrors `frontmatter.ts`). It renders the five CriticMarkup marks to the HTML
//! the downstream CSS depends on (matching the desktop CM view's vocabulary:
//! green add / red del / amber highlight, NO underline/strikethrough):
//!
//!   {++X++}       -> <ins class="critic-add">X</ins>
//!   {--X--}       -> <del class="critic-del">X</del>
//!   {~~O~>N~~}    -> <del class="critic-del">O</del><ins class="critic-add">N</ins>
//!   {==X==}       -> <mark class="critic-highlight">X</mark>
//!   {>>NOTE<<}    -> an inline, print-safe bordered callout carrying NOTE
//!
//! The delimiter-sentinel technique (shared with `citations.rs` via
//! `sentinel::Sentinels`) keeps `render.unsafe_` OFF: only the delimiters
//! (never the inner content) are swapped for sentinel tokens before comrak, so
//! the inner text is still markdown-rendered/escaped by comrak; the sentinels
//! are then swapped for our tags after comrak. Sentinels are a private-use-area
//! pair around a decimal id (`\u{E000}<id>\u{E001}`) — comrak treats them as
//! ordinary text and neither escapes nor mangles them.
//!
//! CriticMarkup marks apply to the BODY only; frontmatter/outline/wikilinks are
//! untouched. An unterminated open (no matching close) is NOT a mark: it stays as
//! literal text (comrak escapes it like any other text).

use sunstone_shared::critic::{parse_critic_marks, CriticMarkKind};

use super::attr_escape;
use super::sentinel::Sentinels;

pub(super) const SENT_OPEN: char = '\u{E000}';
pub(super) const SENT_CLOSE: char = '\u{E001}';

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

/// Rewrite each CriticMarkup mark's DELIMITERS to sentinel tokens, keeping its
/// inner content in the markdown stream. The marks come from the SHARED
/// `parse_critic_marks` (ADR 0006 family 13 — one grammar for the editor and
/// SSR; the former local `critic_open_at`/`critic_close`/`find_close` scanner is
/// retired). Returns the prepared body plus the sentinel replacements. Offsets
/// from the shared parse are UTF-16 units, so the body is walked over its
/// UTF-16 units to slice on them.
pub(super) fn critic_to_sentinels(body: &str) -> (String, Sentinels) {
    let marks = parse_critic_marks(body);
    let mut sentinels = Sentinels::new(SENT_OPEN, SENT_CLOSE);
    if marks.is_empty() {
        return (body.to_string(), sentinels);
    }
    let units: Vec<u16> = body.encode_utf16().collect();
    let mut out = String::with_capacity(body.len());

    let decode = |a: usize, b: usize| String::from_utf16_lossy(&units[a..b]);

    let mut pos = 0usize;
    for mark in &marks {
        // The verbatim text before this mark (kept as markdown for comrak).
        out.push_str(&decode(pos, mark.from));
        let content = decode(mark.content_from, mark.content_to);
        match mark.kind {
            CriticMarkKind::Addition => {
                sentinels.push(&mut out, CRITIC_INS_OPEN);
                out.push_str(&content);
                sentinels.push(&mut out, CRITIC_INS_CLOSE);
            }
            CriticMarkKind::Deletion => {
                sentinels.push(&mut out, CRITIC_DEL_OPEN);
                out.push_str(&content);
                sentinels.push(&mut out, CRITIC_DEL_CLOSE);
            }
            CriticMarkKind::Highlight => {
                sentinels.push(&mut out, CRITIC_MARK_OPEN);
                out.push_str(&content);
                sentinels.push(&mut out, CRITIC_MARK_CLOSE);
            }
            CriticMarkKind::Substitution => {
                // The FIRST `~>` splits old/new (as in the shared parse); with
                // none present, render the whole inner as a deletion.
                if let Some(p) = content.find("~>") {
                    let (deleted, inserted) = (&content[..p], &content[p + 2..]);
                    sentinels.push(&mut out, CRITIC_DEL_OPEN);
                    out.push_str(deleted);
                    sentinels.push(&mut out, CRITIC_SUB_MID);
                    out.push_str(inserted);
                    sentinels.push(&mut out, CRITIC_INS_CLOSE);
                } else {
                    sentinels.push(&mut out, CRITIC_DEL_OPEN);
                    out.push_str(&content);
                    sentinels.push(&mut out, CRITIC_DEL_CLOSE);
                }
            }
            CriticMarkKind::Comment => {
                // The note is plain text (NOT markdown-rendered), escaped into a
                // self-contained callout injected whole, at the comment's spot.
                sentinels.push(&mut out, critic_comment_callout(&content));
            }
        }
        pos = mark.to;
    }
    out.push_str(&decode(pos, units.len()));
    (out, sentinels)
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
pub(super) fn substitute_critic_sentinels(html: &str, sentinels: &Sentinels) -> String {
    sentinels.substitute(html)
}

#[cfg(test)]
mod tests {
    use crate::render::render_body;

    fn paths(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    fn render(body: &str, source: &str, all: &[&str]) -> crate::render::RenderPayload {
        let all = paths(all);
        let set: Vec<String> = all.clone();
        render_body(body, source, &all, &move |p| set.iter().any(|x| x == p))
    }

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
        assert!(!p.html.contains(super::SENT_OPEN));
        assert!(!p.html.contains(super::SENT_CLOSE));
    }
}
