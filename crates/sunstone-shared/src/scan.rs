//! The ONE code-aware markdown scanner shared by every module that walks a
//! Concept body looking for links: wikilink extraction/replacement
//! (`wikilink::replace_wikilinks` / `wikilink_raws`), anchor rewrite
//! (`rewrite::anchors`), and the move/rename engine (`rewrite::moves`). Its fence / inline-code state machine
//! ([`walk_code`]) also drives `embed`'s code masking.
//!
//! The scanning contract, shared verbatim by all consumers:
//!
//! * fenced code blocks (line-start ``` ``` `` / `~~~`, optionally indented)
//!   are copied verbatim — the fence tracks its own marker char so a `~~~`
//!   inside a backtick fence does not close it;
//! * inline code spans shield wikilinks. They follow CommonMark: a run of N
//!   backticks opens a span only if a later run of EXACTLY N backticks closes
//!   it, and the closer is searched for only up to the end of the paragraph
//!   (a blank line or a fence line) — so an unmatched run is literal text and
//!   never hides anything after it;
//! * `[[ ... ]]` spans OUTSIDE code, minus embeds (`![[ ... ]]`), are handed to
//!   the wikilink callback, which returns the replacement for the WHOLE span;
//! * optionally (see [`scan_replace_links`]), `[text](inner)` markdown links
//!   are handed to a second callback with `(inner, is_image)`; `Some` replaces
//!   only the inner text, `None` leaves the link untouched. Markdown links are
//!   deliberately NOT shielded by inline code (their historical, code-agnostic
//!   behaviour) — and consuming the whole `[..](..)` span means backticks
//!   inside it never open or close an inline code span. [`scan_replace`] (no
//!   markdown-link recognition) instead sees those backticks as span
//!   delimiters; the two entry points preserve each consumer's historical
//!   behaviour.
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
    /// One backtick of a run that opens or closes an inline code span.
    Tick,
    /// One prose byte, inside or outside an inline code span. A backtick that
    /// belongs to no span (an unmatched run, or one inside a longer span) is
    /// reported here too.
    Text { in_inline_code: bool },
}

/// The fence / inline-code state machine of the scanning contract (module
/// docs), shared by [`scan_replace`] and `embed`'s code masking.
///
/// `visit(i, class)` is called for each position the walk stops at. For a
/// [`CodeClass::Text`] byte it may return `Some(next)` to consume a whole span
/// `i..next` (e.g. a link) — bytes in it are not classified, so a backtick
/// inside it never opens or closes inline code — after which the walk resumes
/// at `next` as mid-line. A consumed span that runs past the closing backtick
/// run of the current code span ends that span. The return value is ignored
/// for every other class, and for a literal (unmatched) backtick.
///
/// Inline code follows CommonMark: a run of N backticks opens a span only when
/// a later run of EXACTLY N backticks closes it before the paragraph ends (a
/// blank line or a fence line); otherwise the run is literal text. Linear in
/// `body`: each paragraph's backtick runs are pre-scanned once, and each
/// opener finds its closer by binary search.
pub(crate) fn walk_code(bytes: &[u8], mut visit: impl FnMut(usize, CodeClass) -> Option<usize>) {
    let mut i = 0usize;
    let mut fence: Option<u8> = None;
    let mut at_line_start = true;
    // The closing run `start..end` of the inline code span we are inside.
    let mut code_close: Option<(usize, usize)> = None;
    let mut para: Option<ParagraphRuns> = None;

    while i < bytes.len() {
        let b = bytes[i];

        // --- Fenced code blocks (line-start ``` / ~~~) ------------------------
        if at_line_start {
            if let Some(ch) = fence_marker(bytes, i) {
                match fence {
                    Some(f) if f == ch => fence = None,
                    None => fence = Some(ch),
                    _ => {}
                }
                let end = find_byte(bytes, i, b'\n').map(|p| p + 1).unwrap_or(bytes.len());
                visit(i, CodeClass::FenceLine { end });
                i = end;
                at_line_start = true;
                code_close = None;
                continue;
            }
        }

        if fence.is_some() {
            visit(i, CodeClass::Fenced);
            at_line_start = b == b'\n';
            i += 1;
            continue;
        }

        match code_close {
            // --- Closing run of the current span ---------------------------
            Some((start, end)) if i >= start => {
                for k in i..end {
                    visit(k, CodeClass::Tick);
                }
                i = end;
                at_line_start = false;
                code_close = None;
                continue;
            }
            // --- Inside a span: every byte (backticks too) is code text ----
            Some((start, _)) => {
                if let Some(next) = visit(i, CodeClass::Text { in_inline_code: true }) {
                    if next > start {
                        code_close = None;
                    }
                    i = next;
                    at_line_start = false;
                    continue;
                }
            }
            // --- A backtick run in prose: opener or literal ----------------
            None if b == b'`' => {
                let n = run_len(bytes, i);
                if para.as_ref().is_none_or(|p| i >= p.end) {
                    para = Some(ParagraphRuns::scan(bytes, i));
                }
                let closer = para.as_ref().and_then(|p| p.closer(i + n, n));
                let class = match closer {
                    Some(c) => {
                        code_close = Some((c, c + n));
                        CodeClass::Tick
                    }
                    None => CodeClass::Text { in_inline_code: false },
                };
                for k in i..i + n {
                    visit(k, class);
                }
                i += n;
                at_line_start = false;
                continue;
            }
            // --- Plain prose ------------------------------------------------
            None => {
                if let Some(next) = visit(i, CodeClass::Text { in_inline_code: false }) {
                    i = next;
                    at_line_start = false;
                    continue;
                }
            }
        }

        at_line_start = b == b'\n';
        i += 1;
    }
}

/// The fence char (`` ` `` / `~`) when the line starting at `i` opens or
/// closes a fenced code block: optional spaces/tabs, then three of the char.
fn fence_marker(bytes: &[u8], i: usize) -> Option<u8> {
    let mut j = i;
    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
        j += 1;
    }
    (j + 2 < bytes.len()
        && (bytes[j] == b'`' || bytes[j] == b'~')
        && bytes[j + 1] == bytes[j]
        && bytes[j + 2] == bytes[j])
        .then(|| bytes[j])
}

/// Length of the backtick run starting at `i`.
fn run_len(bytes: &[u8], i: usize) -> usize {
    bytes[i..].iter().take_while(|&&b| b == b'`').count()
}

/// The backtick runs of one paragraph, from a start position up to `end`: the
/// start of the first following line that is blank or a fence line (or the
/// body end). An inline code span never reaches past `end`.
struct ParagraphRuns {
    end: usize,
    /// `(run length, run start)`, sorted — so every run of one length is a
    /// contiguous, position-ordered slice.
    runs: Vec<(usize, usize)>,
}

impl ParagraphRuns {
    fn scan(bytes: &[u8], from: usize) -> Self {
        let mut runs = Vec::new();
        let mut j = from;
        while j < bytes.len() {
            match bytes[j] {
                b'`' => {
                    let n = run_len(bytes, j);
                    runs.push((n, j));
                    j += n;
                }
                b'\n' => {
                    let next = j + 1;
                    j = next;
                    if next >= bytes.len()
                        || is_blank_line(bytes, next)
                        || fence_marker(bytes, next).is_some()
                    {
                        break;
                    }
                }
                _ => j += 1,
            }
        }
        runs.sort_unstable();
        ParagraphRuns { end: j.min(bytes.len()), runs }
    }

    /// Start of the first run of exactly `n` backticks at or after `from`.
    fn closer(&self, from: usize, n: usize) -> Option<usize> {
        let k = self.runs.partition_point(|&r| r < (n, from));
        self.runs.get(k).filter(|&&(len, _)| len == n).map(|&(_, pos)| pos)
    }
}

/// True when the line starting at `i` holds only spaces/tabs (or `\r`).
fn is_blank_line(bytes: &[u8], i: usize) -> bool {
    bytes[i..]
        .iter()
        .take_while(|&&b| b != b'\n')
        .all(|&b| b == b' ' || b == b'\t' || b == b'\r')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::scan_embeds;
    use crate::wikilink::wikilink_raws;

    /// The raw inner texts [`scan_replace`] hands to its wikilink callback.
    fn raws(body: &str) -> Vec<String> {
        wikilink_raws(body)
    }

    /// The `(inner, is_image)` pairs [`scan_replace_links`] hands to `md_link`.
    fn md_inners(body: &str) -> Vec<(String, bool)> {
        let mut seen = Vec::new();
        scan_replace_links(
            body,
            |raw| format!("[[{raw}]]"),
            |inner, img| {
                seen.push((inner.to_string(), img));
                None
            },
        );
        seen
    }

    // --- Fences (behaviour pinned before the code-span rewrite) --------------

    #[test]
    fn a_backtick_fence_hides_its_wikilinks() {
        assert_eq!(raws("```\n[[A]]\n```\n[[B]]"), vec!["B"]);
    }

    #[test]
    fn a_tilde_line_inside_a_backtick_fence_does_not_close_it() {
        assert_eq!(raws("```\n~~~\n[[A]]\n```\n[[B]]"), vec!["B"]);
        assert_eq!(raws("~~~\n```\n[[A]]\n~~~\n[[B]]"), vec!["B"]);
    }

    #[test]
    fn an_indented_fence_is_still_a_fence() {
        assert_eq!(raws("  ```\n[[A]]\n  ```\n[[B]]"), vec!["B"]);
    }

    #[test]
    fn a_closing_fence_at_eof_without_newline_closes() {
        assert_eq!(raws("[[A]]\n```\n[[B]]\n```"), vec!["A"]);
        assert_eq!(raws("```\n[[A]]\n```"), Vec::<String>::new());
    }

    #[test]
    fn an_unclosed_fence_hides_the_rest() {
        assert_eq!(raws("[[A]]\n```\n[[B]]\n\n[[C]]"), vec!["A"]);
    }

    // --- Inline code spans ----------------------------------------------------

    #[test]
    fn a_matched_span_masks_a_wikilink_inside_it() {
        assert_eq!(raws("`[[X]]` and [[Y]]"), vec!["Y"]);
        assert_eq!(raws("``a [[X]] b`` [[Y]]"), vec!["Y"]);
    }

    #[test]
    fn a_span_may_cross_a_single_line_break() {
        assert_eq!(raws("`code\n[[X]]` [[Y]]"), vec!["Y"]);
    }

    /// A body ending in a whitespace-only line (common: trailing indentation
    /// at EOF) must not index past the end while probing for a fence.
    #[test]
    fn a_trailing_whitespace_only_line_does_not_panic() {
        for body in [" ", "\t", "text\n  ", "[[A]]\n\t", "a\r\n \r\n"] {
            assert_eq!(scan_replace(body, |r| format!("[[{r}]]")), body, "{body:?}");
        }
        assert_eq!(raws("[[A]]\n  "), vec!["A"]);
        assert_eq!(crate::embed::scan_embeds("![[a.png]]\n\t").len(), 1);
    }

    #[test]
    fn an_unmatched_backtick_is_literal_text() {
        assert_eq!(
            raws("Press the ` key.\n\nSee [[Alpha]] and [[Beta]]"),
            vec!["Alpha", "Beta"]
        );
        assert_eq!(raws("a ` b [[X]]"), vec!["X"]);
    }

    #[test]
    fn a_double_backtick_span_may_contain_a_single_backtick() {
        assert_eq!(raws("Use ``a`b`` here. [[X]]"), vec!["X"]);
    }

    #[test]
    fn a_closer_must_have_exactly_the_opener_length() {
        // The `` run cannot close a single-backtick span; the later ` does.
        assert_eq!(raws("`a``[[X]]` [[Y]]"), vec!["Y"]);
        // No run of length 1 follows: the opener is literal.
        assert_eq!(raws("` [[X]] `` [[Y]]"), vec!["X", "Y"]);
    }

    #[test]
    fn a_span_never_crosses_a_blank_line() {
        assert_eq!(raws("a ` b\n\n[[X]] ` c"), vec!["X"]);
        assert_eq!(raws("a ` b\n  \t\n[[X]] ` c"), vec!["X"]);
    }

    #[test]
    fn a_span_never_crosses_a_fence_start() {
        assert_eq!(raws("a ` b\n```\n`\n```\n[[X]]"), vec!["X"]);
    }

    #[test]
    fn many_unmatched_backticks_stay_literal() {
        let body = format!("{} [[X]]", "` ".repeat(5_001));
        // 5001 single backticks: 2500 pairs + one literal; [[X]] lies after
        // the last (literal) one.
        assert_eq!(raws(&body), vec!["X"]);
    }

    // --- Markdown links -------------------------------------------------------

    #[test]
    fn a_markdown_link_consumes_its_backticks() {
        // The link span is not classified, so its lone backtick opens nothing.
        let body = "[a`b](x.md) then [[Y]]";
        assert_eq!(md_inners(body), vec![("x.md".to_string(), false)]);
        let out = scan_replace_links(body, |r| format!("<{r}>"), |_, _| None);
        assert_eq!(out, "[a`b](x.md) then <Y>");
    }

    #[test]
    fn a_markdown_link_inside_code_is_still_seen() {
        // Historical, code-agnostic behaviour of the markdown-link half.
        assert_eq!(md_inners("`[a](b.md)`"), vec![("b.md".to_string(), false)]);
        assert_eq!(md_inners("![i](p.png)"), vec![("p.png".to_string(), true)]);
    }

    #[test]
    fn a_markdown_link_after_an_unmatched_backtick_is_seen() {
        assert_eq!(md_inners("a ` b\n\n[l](x.md)"), vec![("x.md".to_string(), false)]);
    }

    // --- Identity -------------------------------------------------------------

    #[test]
    fn scan_replace_is_an_identity_when_the_callback_returns_the_span() {
        for body in [
            "plain [[A]] text ![[e.png]] `[[c]]`",
            "```\n[[A]]\n~~~\n```\nx ` y [[B]] `` z",
            "Use ``a`b`` here. [[X]]\n\n  ~~~\n`\n",
            "unicode ✓ `ä [[ö]]` [[ü|alias]]",
        ] {
            assert_eq!(scan_replace(body, |r| format!("[[{r}]]")), body);
            assert_eq!(
                scan_replace_links(body, |r| format!("[[{r}]]"), |_, _| None),
                body
            );
        }
    }

    // --- End to end: Embeds ---------------------------------------------------

    #[test]
    fn an_unmatched_backtick_does_not_hide_later_embeds() {
        assert_eq!(scan_embeds("Press the ` key.\n\n![[a.png]]").len(), 1);
        assert_eq!(scan_embeds("Use ``a`b`` here. ![[a.png]]").len(), 1);
    }

    #[test]
    fn an_embed_inside_a_matched_span_stays_hidden() {
        assert_eq!(scan_embeds("`![[a.png]]` ![[b.png]]").len(), 1);
        assert_eq!(scan_embeds("```\n![[a.png]]\n```").len(), 0);
    }
}
