//! The ONE code-aware markdown scanner shared by every module that walks a
//! Concept body looking for links: wikilink extraction/replacement
//! (`wikilink::replace_wikilinks` / `wikilink_raws`), anchor rewrite
//! (`rewrite::anchors`), and the native move/rename engine
//! (`sunstone-native::rewrite::engine`). Its fence / inline-code state machine
//! ([`walk_code`]) also drives `embed`'s code masking.
//!
//! The scanning contract, shared verbatim by all consumers:
//!
//! * fenced code blocks (line-start ``` ``` `` / `~~~`, optionally indented)
//!   are copied verbatim — the fence tracks its own marker char so a `~~~`
//!   inside a backtick fence does not close it;
//! * inline code spans (`` ` `` toggles) shield wikilinks;
//! * `[[ ... ]]` spans OUTSIDE code, minus embeds (`![[ ... ]]`), are handed to
//!   the wikilink callback, which returns the replacement for the WHOLE span;
//! * optionally (see [`scan_replace_links`]), `[text](inner)` markdown links
//!   are handed to a second callback with `(inner, is_image)`; `Some` replaces
//!   only the inner text, `None` leaves the link untouched. Markdown links are
//!   deliberately NOT shielded by inline code (their historical, code-agnostic
//!   behaviour) — and consuming the whole `[..](..)` span means backticks
//!   inside it never toggle the inline-code state. [`scan_replace`] (no
//!   markdown-link recognition) instead sees those backticks as toggles; the
//!   two entry points preserve each consumer's exact historical behaviour.
//!
//! Everything not replaced is copied through byte-for-byte, so a callback that
//! returns the original span makes the scan an identity.

use crate::paths::find_byte;
use crate::wikilink::find_double_close;

/// Scan `body`, replacing every non-embed wikilink span via `wikilink`
/// (raw inner text in, full-span replacement out). No markdown-link handling.
pub fn scan_replace<W>(body: &str, mut wikilink: W) -> String
where
    W: FnMut(&str) -> String,
{
    scan_core(body, &mut wikilink, None)
}

/// Like [`scan_replace`], but additionally recognizes markdown links
/// `[text](inner)`: `md_link(inner, is_image)` may return a replacement for
/// the inner text (the `[text](` and `)` are preserved).
pub fn scan_replace_links<W, M>(body: &str, mut wikilink: W, mut md_link: M) -> String
where
    W: FnMut(&str) -> String,
    M: FnMut(&str, bool) -> Option<String>,
{
    scan_core(body, &mut wikilink, Some(&mut md_link))
}

/// `md_link(inner, is_image)` callback: an optional replacement for a Markdown
/// link's inner text.
type MdLinkFn<'a> = dyn FnMut(&str, bool) -> Option<String> + 'a;

fn scan_core(
    body: &str,
    wikilink: &mut dyn FnMut(&str) -> String,
    mut md_link: Option<&mut MdLinkFn<'_>>,
) -> String {
    let bytes = body.as_bytes();
    let mut out = String::with_capacity(body.len());
    let mut last = 0usize; // start of the not-yet-copied verbatim run

    // Code (fences, inline spans) stays in the verbatim run; only prose bytes
    // can start a link.
    walk_code(bytes, |i, class| {
        let CodeClass::Text { in_inline_code } = class else {
            return None;
        };
        let b = bytes[i];

        // --- Wikilink `[[ ... ]]` --------------------------------------------
        if !in_inline_code && b == b'[' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            if let Some(close) = find_double_close(bytes, i + 2) {
                // Embeds (`![[ ... ]]`) are OUT OF SCOPE for v1 — copied
                // verbatim, like `![](...)` images.
                let is_embed = i > 0 && bytes[i - 1] == b'!';
                if !is_embed {
                    // Flush the verbatim run, splice the replacement for the
                    // whole `[[ ... ]]` span.
                    out.push_str(&body[last..i]);
                    out.push_str(&wikilink(&body[i + 2..close]));
                    last = close + 2;
                }
                return Some(close + 2);
            }
        }

        // --- Markdown link `[text](inner)` (opt-in) ---------------------------
        if let Some(md) = md_link.as_deref_mut() {
            if b == b'[' {
                let is_image = i > 0 && bytes[i - 1] == b'!';
                if let Some(close) = find_byte(bytes, i + 1, b']') {
                    if close + 1 < bytes.len() && bytes[close + 1] == b'(' {
                        if let Some(paren) = find_byte(bytes, close + 2, b')') {
                            let inner = &body[close + 2..paren];
                            if let Some(replacement) = md(inner, is_image) {
                                // `[text](` verbatim, then the new inner; the
                                // `)` stays in the verbatim run.
                                out.push_str(&body[last..close + 2]);
                                out.push_str(&replacement);
                                last = paren;
                            }
                            return Some(paren + 1);
                        }
                    }
                }
            }
        }
        None
    });

    out.push_str(&body[last..]);
    out
}

/// What [`walk_code`] found at a byte position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodeClass {
    /// A whole fence line (```` ``` ```` / `~~~`, opening or closing) running
    /// from the reported position up to `end` (past its `\n`, or the body end).
    FenceLine { end: usize },
    /// One byte inside a fenced code block.
    Fenced,
    /// An inline-code backtick (it toggles the inline-code state).
    Tick,
    /// One prose byte, inside or outside an inline code span.
    Text { in_inline_code: bool },
}

/// The fence / inline-code state machine of the scanning contract (module
/// docs), shared by [`scan_replace`] and `embed`'s code masking.
///
/// `visit(i, class)` is called for each position the walk stops at. For a
/// [`CodeClass::Text`] byte it may return `Some(next)` to consume a whole span
/// `i..next` (e.g. a link) — bytes in it are not classified, so a backtick
/// inside it never toggles inline code — after which the walk resumes at
/// `next` as mid-line. The return value is ignored for every other class.
pub(crate) fn walk_code(bytes: &[u8], mut visit: impl FnMut(usize, CodeClass) -> Option<usize>) {
    let mut i = 0usize;
    let mut in_inline_code = false;
    let mut fence: Option<u8> = None;
    let mut at_line_start = true;

    while i < bytes.len() {
        let b = bytes[i];

        // --- Fenced code blocks (line-start ``` / ~~~) ------------------------
        if at_line_start {
            let mut j = i;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j + 2 < bytes.len()
                && (bytes[j] == b'`' || bytes[j] == b'~')
                && bytes[j + 1] == bytes[j]
                && bytes[j + 2] == bytes[j]
            {
                let ch = bytes[j];
                match fence {
                    Some(f) if f == ch => fence = None,
                    None => fence = Some(ch),
                    _ => {}
                }
                let end = find_byte(bytes, i, b'\n').map(|p| p + 1).unwrap_or(bytes.len());
                visit(i, CodeClass::FenceLine { end });
                i = end;
                at_line_start = true;
                continue;
            }
        }

        if fence.is_some() {
            visit(i, CodeClass::Fenced);
            at_line_start = b == b'\n';
            i += 1;
            continue;
        }

        if b == b'`' {
            in_inline_code = !in_inline_code;
            visit(i, CodeClass::Tick);
            at_line_start = false;
            i += 1;
            continue;
        }

        if let Some(next) = visit(i, CodeClass::Text { in_inline_code }) {
            i = next;
            at_line_start = false;
            continue;
        }

        at_line_start = b == b'\n';
        i += 1;
    }
}
