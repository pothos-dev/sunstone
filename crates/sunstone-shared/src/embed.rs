//! Embed (`![alt](path.png)` / `![[name.png]]`) parsing, sizing and resolution.
//!
//! An **Embed** is a reference from a Concept to an **Attachment** — a non-`.md`
//! file stored in the Bundle (see the two terms in `docs/GLOSSARY.md`). Both
//! forms are recognised here and they resolve by DIFFERENT models, exactly as
//! links do:
//!
//! * `![alt](target)` resolves by **PATH** ([`crate::paths::resolve_internal`]),
//!   like a markdown link;
//! * `![[name]]` resolves by **NAME** over the Attachment corpus, under the
//!   ADR-0004 rules — case-insensitive, literal, partial paths by suffix, ties
//!   broken by shortest Bundle path. [`resolve_embed_name`] is deliberately the
//!   same algorithm as [`crate::wikilink::resolve_wikilink`] over a different
//!   corpus (Attachments instead of `.md` Concepts, extensions KEPT).
//!
//! In an Embed a `|` suffix is a **SIZE**, never an alias (glossary rule), and a
//! `#anchor` is meaningless and ignored.
//!
//! ## The deliberate scanner asymmetry (af-1)
//!
//! The shared scanner in [`crate::scan`] SKIPS embeds (`![[ … ]]`) and this
//! module does NOT change that. That asymmetry is intentional, not an oversight:
//!
//! * **Extraction** must keep dropping `!`, so an Embed never becomes a
//!   Backlinks edge — an Attachment is not a Backlinks endpoint.
//! * **Rename-rewrite** must keep skipping `![[ … ]]`, because a name-resolved
//!   Embed resolves BUNDLE-WIDE by name and suffix: moving the Concept that
//!   writes it can never invalidate it, so rewriting it would be wrong.
//!
//! Only the markdown (path-resolved) rewrite path gains `!` handling, since
//! `![alt](../img.png)` is relative and a move DOES invalidate it. Consequently
//! this module carries its own [`mask_code`] walk rather than calling
//! `scan::scan_replace`: it needs byte offsets and it must see the very spans
//! the shared scanner is required to ignore. The code-skipping CONTRACT is the
//! same one `scan.rs` documents (fenced blocks, inline code spans), and the mask
//! is length-preserving so every offset indexes the ORIGINAL body — the same
//! invariant `maskCode` holds in the TS twin.

use serde::{Deserialize, Serialize};

use crate::paths::{find_byte, resolve_internal};
use crate::wikilink::{basename, find_double_close};

/// The Attachment extensions Sunstone renders as an image, matched
/// case-insensitively (af-1). Non-image Attachments keep their literal
/// rendering until `af-3`.
pub const IMAGE_EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];

/// Which resolution model an Embed uses — the two are NOT interchangeable.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EmbedKind {
    /// `![alt](target)` — resolved by path against the source Concept.
    Path,
    /// `![[name]]` — resolved by name against the Attachment corpus.
    Name,
}

/// How an Embed's target must be treated before anything is fetched (ADR-0011).
/// Named `EmbedTargetKind` rather than `TargetKind` because the generated wasm
/// `.d.ts` is one flat namespace.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EmbedTargetKind {
    /// A Bundle path (relative or bundle-absolute) — the only kind that resolves
    /// to an Attachment.
    Local,
    /// `http:` / `https:` — click-to-load, never fetched automatically.
    Remote,
    /// A `data:` URI — NOT rendered at all (injection vector, no benefit).
    Data,
    /// Any other `scheme:` (`mailto:`, `file:`, `c:/…`) — not rendered.
    OtherScheme,
}

/// One Embed found in a Concept body.
///
/// `from`/`to` are **byte** offsets into the ORIGINAL body (the code mask is
/// length-preserving), spanning the whole construct — from the `!` through the
/// closing `)` or `]]`.
///
/// NOTE the unit: unlike `critic.rs` / `citations.rs`, whose spans count UTF-16
/// code units because they feed CodeMirror decorations directly (ADR 0006 §4),
/// these are Rust byte offsets — the unit the SSR renderer and the rewrite
/// engine slice with. A CodeMirror consumer must convert (or scan the buffer in
/// TS), or a decoration lands wrong after any non-ASCII character.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Embed {
    /// Byte offset of the leading `!` in the original body.
    pub from: usize,
    /// Byte offset one past the final `)` / `]]` in the original body.
    pub to: usize,
    /// The raw target: the parens content for [`EmbedKind::Path`] (title and
    /// `<>` wrapper dropped), or the pre-`|` name for [`EmbedKind::Name`]. Never
    /// path-resolved here — see [`resolve_embed_path`] / [`resolve_embed_name`].
    pub target: String,
    /// The ACCESSIBLE NAME for the rendered image, already resolved: the author's
    /// alt text when there is one, otherwise the target's filename WITH its
    /// extension (ADR-0010 — `alt=""` would be a lie). Computed here, never in
    /// TypeScript.
    pub alt: String,
    /// Requested width in CSS pixels from a `|300` / `|300x200` suffix (or a
    /// size-shaped markdown alt), if any.
    pub width: Option<u32>,
    /// Requested height in CSS pixels from a `|300x200` suffix, if any.
    pub height: Option<u32>,
    /// Which resolution model applies.
    pub kind: EmbedKind,
}

/// The filename part of a target: the segment after the last `/`, with any
/// `?query` / `#fragment` cut off. Falls back to the whole (trimmed) target when
/// that would be empty.
fn file_name(target: &str) -> &str {
    let t = target.trim();
    let name = basename(t);
    let cut = name.find(['?', '#']).unwrap_or(name.len());
    let name = &name[..cut];
    if name.is_empty() {
        t
    } else {
        name
    }
}

/// True when `p`'s extension is one of [`IMAGE_EXTENSIONS`] (case-insensitive).
/// A dotfile with no further dot (`.png`) is NOT an image: it has no extension.
pub fn is_image_path(p: &str) -> bool {
    let name = file_name(p);
    match name.rfind('.') {
        Some(dot) if dot > 0 => {
            let ext = &name[dot + 1..];
            IMAGE_EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e))
        }
        _ => false,
    }
}

/// A run of ASCII digits as a `u32` (`None` when empty, non-digit, or
/// overflowing — an overflowing "size" is alt text, not a size).
fn digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Parse an Embed size: `300` → `(300, None)`, `300x200` → `(300, Some(200))`.
///
/// The string must be PURELY digits or `<digits>x<digits>` — no whitespace, no
/// units, lowercase `x` only (Obsidian's syntax). Anything else is `None`, which
/// is how a markdown alt that merely looks numeric is told apart from a size.
pub fn parse_size(s: &str) -> Option<(u32, Option<u32>)> {
    match s.split_once('x') {
        Some((w, h)) => Some((digits(w)?, Some(digits(h)?))),
        None => Some((digits(s)?, None)),
    }
}

/// The accessible name for an Embed: the author's alt text when there is one,
/// otherwise the target's filename WITH extension (ADR-0010). `alt` is `None`
/// for `![[x.png]]` (which has no alt at all) and for a markdown Embed whose alt
/// was consumed as a size; a blank alt falls back the same way.
pub fn accessible_name(target: &str, alt: Option<&str>) -> String {
    match alt {
        Some(a) if !a.trim().is_empty() => a.to_string(),
        _ => file_name(target).to_string(),
    }
}

/// From the inside of a markdown Embed's parens (`target "title"`), return just
/// the target. Mirrors `extract_href` in `sunstone-native`'s index scanner,
/// including its limitation: a `<…>`-wrapped target containing whitespace is cut
/// at the whitespace, exactly as it is there.
fn extract_target(raw: &str) -> String {
    let trimmed = raw.trim();
    let url = trimmed
        .split_once(char::is_whitespace)
        .map(|(u, _)| u)
        .unwrap_or(trimmed);
    url.trim_matches(['<', '>']).to_string()
}

/// Split a raw `![[ … ]]` inner text into `(name, size suffix)`.
///
/// The name ends at the earliest `|` or `#`, mirroring
/// [`crate::wikilink::name_end`]; the suffix is the text after the FIRST `|`, up
/// to a following `#`. Unlike a Wikilink the name keeps its extension (an
/// Attachment corpus has no implied `.md`) and the `|` suffix is a SIZE, never
/// an alias. A `#anchor` is meaningless for an Embed and is dropped.
fn split_name_target(raw: &str) -> (&str, Option<&str>) {
    let pipe = raw.find('|');
    let hash = raw.find('#');
    let name_end = match (pipe, hash) {
        (Some(p), Some(h)) => p.min(h),
        (Some(p), None) => p,
        (None, Some(h)) => h,
        (None, None) => raw.len(),
    };
    let size = pipe.map(|p| {
        let after = &raw[p + 1..];
        let end = after.find('#').unwrap_or(after.len());
        after[..end].trim()
    });
    (raw[..name_end].trim(), size)
}

/// Blank `out[from..to]`, preserving newlines (so line-start state and every
/// byte offset survive) and the byte LENGTH (so offsets index the original).
fn blank(out: &mut [u8], from: usize, to: usize) {
    for b in &mut out[from..to] {
        if *b != b'\n' {
            *b = b' ';
        }
    }
}

/// Replace every byte inside a fenced code block or an inline code span with an
/// ASCII space, leaving the rest of `body` byte-for-byte intact.
///
/// The contract is the one [`crate::scan`] documents: line-start ```` ``` ````
/// / `~~~` fences (optionally indented, marker char tracked so a `~~~` inside a
/// backtick fence does not close it) and `` ` `` toggles for inline spans, which
/// — as in the shared scanner — are not reset at a line break.
///
/// Length-preserving by construction: only whole bytes are overwritten with
/// ASCII spaces, so a multi-byte char inside code becomes N spaces and the
/// result is still valid UTF-8 of the same length.
fn mask_code(body: &str) -> String {
    let bytes = body.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0usize;
    let mut in_inline_code = false;
    let mut fence: Option<u8> = None;
    let mut at_line_start = true;

    while i < bytes.len() {
        let b = bytes[i];

        // --- Fenced code blocks (line-start ``` / ~~~) --------------------
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
                let end = find_byte(bytes, i, b'\n')
                    .map(|p| p + 1)
                    .unwrap_or(bytes.len());
                blank(&mut out, i, end);
                i = end;
                at_line_start = true;
                continue;
            }
        }

        if fence.is_some() {
            if b != b'\n' {
                out[i] = b' ';
            }
            at_line_start = b == b'\n';
            i += 1;
            continue;
        }

        if b == b'`' {
            in_inline_code = !in_inline_code;
            out[i] = b' ';
            at_line_start = false;
            i += 1;
            continue;
        }

        if in_inline_code && b != b'\n' {
            out[i] = b' ';
        }
        at_line_start = b == b'\n';
        i += 1;
    }

    String::from_utf8(out).expect("masking only overwrites whole bytes with ASCII spaces")
}

/// Every Embed in a Concept body, in document order, with byte offsets into the
/// ORIGINAL body. Fenced code blocks and inline code spans are skipped, exactly
/// as the shared wikilink/link scanner skips them.
pub fn scan_embeds(body: &str) -> Vec<Embed> {
    let masked = mask_code(body);
    let bytes = masked.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] != b'!' {
            i += 1;
            continue;
        }

        // --- `![[ name|size ]]` — name-resolved -----------------------------
        if i + 2 < bytes.len() && bytes[i + 1] == b'[' && bytes[i + 2] == b'[' {
            if let Some(close) = find_double_close(bytes, i + 3) {
                let (name, size) = split_name_target(&body[i + 3..close]);
                let (width, height) = match size.and_then(parse_size) {
                    Some((w, h)) => (Some(w), h),
                    None => (None, None),
                };
                out.push(Embed {
                    from: i,
                    to: close + 2,
                    alt: accessible_name(name, None),
                    target: name.to_string(),
                    width,
                    height,
                    kind: EmbedKind::Name,
                });
                i = close + 2;
                continue;
            }
        }

        // --- `![alt](target "title")` — path-resolved ------------------------
        if i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            if let Some(close) = find_byte(bytes, i + 2, b']') {
                if close + 1 < bytes.len() && bytes[close + 1] == b'(' {
                    if let Some(paren) = find_byte(bytes, close + 2, b')') {
                        let raw_alt = &body[i + 2..close];
                        let target = extract_target(&body[close + 2..paren]);
                        // The size lives in the ALT TEXT here, and is only a size
                        // when the alt is nothing BUT a size. The known false
                        // positive (`![404](x.png)` sizes rather than describes)
                        // is accepted: ADR-0004's "match Obsidian exactly" rule,
                        // and its failure mode is a mis-sized image, not a broken
                        // one.
                        let (width, height, alt) = match parse_size(raw_alt) {
                            Some((w, h)) => (Some(w), h, accessible_name(&target, None)),
                            None => (None, None, accessible_name(&target, Some(raw_alt))),
                        };
                        out.push(Embed {
                            from: i,
                            to: paren + 1,
                            target,
                            alt,
                            width,
                            height,
                            kind: EmbedKind::Path,
                        });
                        i = paren + 1;
                        continue;
                    }
                }
            }
        }

        i += 1;
    }

    out
}

/// Rewrite every Embed's `from`/`to` from a BYTE offset into `body` to a UTF-16
/// code-unit offset.
///
/// Both offsets always land on a char boundary — an Embed starts at `!` and ends
/// one past `)` / `]`, all ASCII — so every offset is a key of the boundary map.
/// ASCII bodies short-circuit: there, one byte is one UTF-16 unit.
fn to_utf16_offsets(body: &str, embeds: &mut [Embed]) {
    if body.is_ascii() || embeds.is_empty() {
        return;
    }
    let mut map: std::collections::HashMap<usize, usize> =
        std::collections::HashMap::with_capacity(body.len() + 1);
    let mut units = 0usize;
    for (b, c) in body.char_indices() {
        map.insert(b, units);
        units += c.len_utf16();
    }
    map.insert(body.len(), units);
    for e in embeds.iter_mut() {
        if let Some(&u) = map.get(&e.from) {
            e.from = u;
        }
        if let Some(&u) = map.get(&e.to) {
            e.to = u;
        }
    }
}

/// Every Embed in a Concept body, in document order, with **UTF-16 code-unit**
/// offsets — the unit a JS string and a CodeMirror position count in (ADR 0006
/// §4), exactly as [`crate::critic`] and [`crate::citations`] already report.
///
/// This is the variant a CodeMirror decoration builder must use.
/// [`scan_embeds`]'s byte offsets are the unit the SSR renderer and the rewrite
/// engine slice Rust strings with; feeding those straight to CodeMirror puts
/// every decoration after the first non-ASCII character in the wrong place.
/// Everything else — detection, sizing, the accessible name — is identical,
/// because this IS [`scan_embeds`] with its offsets converted.
pub fn scan_embeds_utf16(body: &str) -> Vec<Embed> {
    let mut out = scan_embeds(body);
    to_utf16_offsets(body, &mut out);
    out
}

/// Classify an Embed target before anything is fetched (ADR-0011): only
/// [`EmbedTargetKind::Local`] resolves to an Attachment, [`EmbedTargetKind::Remote`]
/// is click-to-load, and [`EmbedTargetKind::Data`] never renders.
pub fn classify_target(target: &str) -> EmbedTargetKind {
    let t = target.trim();
    if !crate::paths::is_external(t) {
        return EmbedTargetKind::Local;
    }
    // `is_external` guarantees a `scheme:` prefix here.
    let scheme = &t[..t.find(':').expect("is_external implies a colon")];
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        EmbedTargetKind::Remote
    } else if scheme.eq_ignore_ascii_case("data") {
        EmbedTargetKind::Data
    } else {
        EmbedTargetKind::OtherScheme
    }
}

/// Resolve a PATH-model Embed (`![alt](target)`) to a bundle-relative path, or
/// `None` when the target is not a Bundle path (any `scheme:` URL, a pure
/// anchor, or empty). Delegates to [`crate::paths::resolve_internal`] — the same
/// path math markdown links use — so an Embed and a link to the same file always
/// land on the same Attachment.
pub fn resolve_embed_path(source_path: &str, target: &str) -> Option<String> {
    if classify_target(target) != EmbedTargetKind::Local {
        return None;
    }
    resolve_internal(source_path, target)
}

/// Resolve a NAME-model Embed (`![[name.png]]`) against the Attachment corpus,
/// or `None` (broken).
///
/// This is [`crate::wikilink::resolve_wikilink`]'s algorithm over a different
/// corpus, and the two should read as such: matching is case-insensitive and
/// LITERAL (no slug/space normalization), a bare name matches by basename, a
/// target containing `/` matches by path suffix, and ambiguity is resolved
/// SILENTLY by fewest `/` then lexicographically.
///
/// The one difference is the extension: a Wikilink drops `.md` on both sides
/// because every Concept is a `.md`, while an Attachment corpus is mixed, so
/// `![[logo.png]]` matches the basename `logo.png` INCLUDING its extension.
///
/// * `attachment_paths`: every Attachment path in the Bundle (bundle-relative,
///   no leading slash) — the separate index af-1 keeps apart from `all_paths`.
/// * `target`: the Embed's target; a `|size` / `#anchor` suffix is tolerated and
///   stripped, mirroring `resolve_wikilink` taking the raw inner text.
pub fn resolve_embed_name(attachment_paths: &[String], target: &str) -> Option<String> {
    let (name, _size) = split_name_target(target);
    if name.is_empty() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let has_slash = name.contains('/');

    let mut matches: Vec<&String> = attachment_paths
        .iter()
        .filter(|c| {
            let full = c.to_ascii_lowercase();
            if has_slash {
                // Partial path -> suffix match (full equality or `/`-bounded).
                full == lower || full.ends_with(&format!("/{lower}"))
            } else {
                // Bare name -> basename match, extension INCLUDED.
                basename(&full) == lower
            }
        })
        .collect();

    if matches.is_empty() {
        return None;
    }
    // Tie-break: fewest `/` (shortest path), then lexicographically.
    matches.sort_by(|a, b| {
        let sa = a.matches('/').count();
        let sb = b.matches('/').count();
        sa.cmp(&sb).then_with(|| a.cmp(b))
    });
    Some(matches[0].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(ps: &[&str]) -> Vec<String> {
        ps.iter().map(|s| s.to_string()).collect()
    }

    // --- extensions --------------------------------------------------------

    #[test]
    fn image_extensions_are_matched_case_insensitively() {
        for ext in IMAGE_EXTENSIONS {
            assert!(is_image_path(&format!("a/b.{ext}")), "{ext}");
            assert!(
                is_image_path(&format!("a/b.{}", ext.to_uppercase())),
                "{ext} upper"
            );
        }
        assert!(is_image_path("Diagram.PnG"));
        assert!(is_image_path("photo.JPEG"));
    }

    #[test]
    fn non_image_and_extension_less_paths_are_not_images() {
        assert!(!is_image_path("notes.md"));
        assert!(!is_image_path("archive.png.zip"));
        assert!(!is_image_path("README"));
        assert!(!is_image_path("dir/README"));
        // A dotfile has no extension.
        assert!(!is_image_path(".png"));
        assert!(!is_image_path(""));
        // A query/fragment does not hide the extension.
        assert!(is_image_path("a/b.png?v=2"));
        assert!(is_image_path("https://x.test/a/b.svg#frag"));
    }

    // --- markdown (path) form ----------------------------------------------

    #[test]
    fn scans_a_markdown_embed() {
        let body = "before ![A diagram](img/d.png) after";
        let e = &scan_embeds(body)[0];
        assert_eq!(e.kind, EmbedKind::Path);
        assert_eq!(e.target, "img/d.png");
        assert_eq!(e.alt, "A diagram");
        assert_eq!((e.width, e.height), (None, None));
        assert_eq!(&body[e.from..e.to], "![A diagram](img/d.png)");
    }

    #[test]
    fn markdown_embed_accepts_a_title_and_angle_brackets() {
        let e = &scan_embeds("![alt](img/d.png \"A title\")")[0];
        assert_eq!(e.target, "img/d.png");
        let e = &scan_embeds("![alt](<img/d.png>)")[0];
        assert_eq!(e.target, "img/d.png");
        let e = &scan_embeds("![alt](<img/d.png> 'T')")[0];
        assert_eq!(e.target, "img/d.png");
    }

    #[test]
    fn markdown_size_lives_in_the_alt_text() {
        let e = &scan_embeds("![300](img.png)")[0];
        assert_eq!((e.width, e.height), (Some(300), None));
        let e = &scan_embeds("![300x200](img.png)")[0];
        assert_eq!((e.width, e.height), (Some(300), Some(200)));
    }

    #[test]
    fn a_size_shaped_alt_is_a_size_and_anything_else_is_alt_text() {
        // The known, accepted false positive: a purely numeric alt SIZES.
        let e = &scan_embeds("![404](x.png)")[0];
        assert_eq!((e.width, e.height), (Some(404), None));
        assert_eq!(e.alt, "x.png");

        // Anything but digits / NxN is alt text, size-ish or not.
        for alt in [
            "404-page",
            "300 x 200",
            "300px",
            " 300",
            "3 00",
            "x",
            "300x",
        ] {
            let e = &scan_embeds(&format!("![{alt}](x.png)"))[0];
            assert_eq!((e.width, e.height), (None, None), "alt {alt:?}");
            assert_eq!(e.alt, alt, "alt {alt:?}");
        }
    }

    #[test]
    fn an_overflowing_size_is_alt_text() {
        let e = &scan_embeds("![99999999999](x.png)")[0];
        assert_eq!((e.width, e.height), (None, None));
        assert_eq!(e.alt, "99999999999");
    }

    #[test]
    fn accessible_name_falls_back_to_the_filename_with_extension() {
        // Alt consumed as a size.
        assert_eq!(scan_embeds("![300](img/d.png)")[0].alt, "d.png");
        // No alt at all.
        assert_eq!(scan_embeds("![](img/d.png)")[0].alt, "d.png");
        assert_eq!(scan_embeds("![   ](img/d.png)")[0].alt, "d.png");
        // `![[ … ]]` never has an alt.
        assert_eq!(scan_embeds("![[img/d.png]]")[0].alt, "d.png");
        assert_eq!(scan_embeds("![[d.png|300x200]]")[0].alt, "d.png");
        // A real alt survives.
        assert_eq!(scan_embeds("![A diagram](img/d.png)")[0].alt, "A diagram");
        // The helper itself.
        assert_eq!(accessible_name("a/b/c.png", None), "c.png");
        assert_eq!(accessible_name("a/b/c.png", Some("")), "c.png");
        assert_eq!(accessible_name("a/b/c.png", Some("hi")), "hi");
        assert_eq!(accessible_name("c.png?v=2", None), "c.png");
    }

    // --- wikilink (name) form ----------------------------------------------

    #[test]
    fn scans_a_name_embed() {
        let body = "see ![[logo.png]] here";
        let e = &scan_embeds(body)[0];
        assert_eq!(e.kind, EmbedKind::Name);
        assert_eq!(e.target, "logo.png");
        assert_eq!(e.alt, "logo.png");
        assert_eq!((e.width, e.height), (None, None));
        assert_eq!(&body[e.from..e.to], "![[logo.png]]");
    }

    #[test]
    fn name_embed_pipe_suffix_is_a_size_never_an_alias() {
        let e = &scan_embeds("![[img.png|300]]")[0];
        assert_eq!(e.target, "img.png");
        assert_eq!((e.width, e.height), (Some(300), None));

        let e = &scan_embeds("![[img.png|300x200]]")[0];
        assert_eq!(e.target, "img.png");
        assert_eq!((e.width, e.height), (Some(300), Some(200)));

        // A non-size suffix is NOT an alias: it is dropped, and the accessible
        // name stays the filename.
        let e = &scan_embeds("![[img.png|A caption]]")[0];
        assert_eq!(e.target, "img.png");
        assert_eq!(e.alt, "img.png");
        assert_eq!((e.width, e.height), (None, None));

        // Whitespace around the suffix is tolerated in this form.
        let e = &scan_embeds("![[img.png | 300 ]]")[0];
        assert_eq!(e.target, "img.png");
        assert_eq!((e.width, e.height), (Some(300), None));
    }

    #[test]
    fn name_embed_ignores_an_anchor_and_keeps_the_extension() {
        let e = &scan_embeds("![[img.png#frag]]")[0];
        assert_eq!(e.target, "img.png");
        let e = &scan_embeds("![[folder/img.png#frag|120]]")[0];
        assert_eq!(e.target, "folder/img.png");
        assert_eq!((e.width, e.height), (Some(120), None));
        // No `.md` dropping: an Attachment corpus is mixed.
        let e = &scan_embeds("![[note.md]]")[0];
        assert_eq!(e.target, "note.md");
    }

    #[test]
    fn an_embed_target_may_have_no_extension_at_all() {
        let e = &scan_embeds("![[LICENSE]]")[0];
        assert_eq!(e.target, "LICENSE");
        assert_eq!(e.alt, "LICENSE");
        assert!(!is_image_path(&e.target));

        let e = &scan_embeds("![alt](assets/blob)")[0];
        assert_eq!(e.target, "assets/blob");
        assert!(!is_image_path(&e.target));
    }

    // --- scanning ----------------------------------------------------------

    #[test]
    fn scans_both_syntaxes_in_document_order_with_original_offsets() {
        let body = "Küche ![a](x.png) und ![[y.png|50]] Ende";
        let found = scan_embeds(body);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].kind, EmbedKind::Path);
        assert_eq!(found[1].kind, EmbedKind::Name);
        // Offsets index the ORIGINAL body, multi-byte prefix included.
        assert_eq!(&body[found[0].from..found[0].to], "![a](x.png)");
        assert_eq!(&body[found[1].from..found[1].to], "![[y.png|50]]");
    }

    #[test]
    fn skips_fenced_code_blocks_and_inline_code() {
        let body = "Real ![a](x.png).\n\
                    Inline `![b](y.png)` and `![[c.png]]` ignored.\n\
                    ```\n![d](z.png)\n![[e.png]]\n```\n\
                    ~~~\n![f](q.png)\n~~~\n\
                    Tail ![[g.png]].";
        let targets: Vec<String> = scan_embeds(body).into_iter().map(|e| e.target).collect();
        assert_eq!(targets, vec!["x.png", "g.png"]);
    }

    #[test]
    fn an_indented_fence_and_a_nested_marker_behave_like_the_shared_scanner() {
        // A `~~~` inside a backtick fence does not close it.
        let body = "  ```\n~~~\n![a](x.png)\n  ```\n![b](y.png)";
        let targets: Vec<String> = scan_embeds(body).into_iter().map(|e| e.target).collect();
        assert_eq!(targets, vec!["y.png"]);
    }

    #[test]
    fn code_masking_preserves_byte_offsets() {
        let body = "`ünlaut code` ![a](x.png)";
        let e = &scan_embeds(body)[0];
        assert_eq!(&body[e.from..e.to], "![a](x.png)");
    }

    #[test]
    fn a_plain_link_or_unterminated_construct_is_not_an_embed() {
        assert!(scan_embeds("[a](x.png)").is_empty());
        assert!(scan_embeds("[[a.png]]").is_empty());
        assert!(scan_embeds("![a](x.png").is_empty());
        assert!(scan_embeds("![[a.png]").is_empty());
        assert!(scan_embeds("![a] (x.png)").is_empty());
        assert!(scan_embeds("plain text").is_empty());
    }

    // --- classification ----------------------------------------------------

    #[test]
    fn classifies_local_remote_data_and_other_schemes() {
        assert_eq!(classify_target("img/d.png"), EmbedTargetKind::Local);
        assert_eq!(classify_target("/img/d.png"), EmbedTargetKind::Local);
        assert_eq!(classify_target("../d.png"), EmbedTargetKind::Local);
        assert_eq!(classify_target(""), EmbedTargetKind::Local);

        assert_eq!(
            classify_target("http://x.test/a.png"),
            EmbedTargetKind::Remote
        );
        assert_eq!(
            classify_target("HTTPS://x.test/a.png"),
            EmbedTargetKind::Remote
        );

        assert_eq!(
            classify_target("data:image/png;base64,AAAA"),
            EmbedTargetKind::Data
        );
        assert_eq!(
            classify_target("DATA:image/svg+xml,x"),
            EmbedTargetKind::Data
        );

        assert_eq!(
            classify_target("file:///etc/passwd"),
            EmbedTargetKind::OtherScheme
        );
        assert_eq!(
            classify_target("mailto:a@b.c"),
            EmbedTargetKind::OtherScheme
        );
        assert_eq!(
            classify_target("  javascript:alert(1)  "),
            EmbedTargetKind::OtherScheme
        );
    }

    // --- path resolution ---------------------------------------------------

    #[test]
    fn resolves_relative_and_bundle_absolute_paths() {
        assert_eq!(
            resolve_embed_path("concepts/a.md", "img/d.png").as_deref(),
            Some("concepts/img/d.png")
        );
        assert_eq!(
            resolve_embed_path("concepts/a.md", "./d.png").as_deref(),
            Some("concepts/d.png")
        );
        assert_eq!(
            resolve_embed_path("concepts/sub/a.md", "../d.png").as_deref(),
            Some("concepts/d.png")
        );
        assert_eq!(
            resolve_embed_path("concepts/a.md", "/assets/d.png").as_deref(),
            Some("assets/d.png")
        );
    }

    #[test]
    fn non_local_targets_never_resolve_to_a_path() {
        assert_eq!(resolve_embed_path("a.md", "https://x.test/a.png"), None);
        assert_eq!(resolve_embed_path("a.md", "http://x.test/a.png"), None);
        assert_eq!(resolve_embed_path("a.md", "data:image/png;base64,AA"), None);
        assert_eq!(resolve_embed_path("a.md", "file:///etc/passwd"), None);
        assert_eq!(resolve_embed_path("a.md", ""), None);
        assert_eq!(resolve_embed_path("a.md", "#anchor"), None);
    }

    // --- name resolution ---------------------------------------------------

    #[test]
    fn bare_name_resolves_by_basename_including_extension() {
        let all = paths(&["assets/logo.png", "index.md"]);
        assert_eq!(
            resolve_embed_name(&all, "logo.png").as_deref(),
            Some("assets/logo.png")
        );
        // The extension is part of the name: `logo` alone does NOT match.
        assert_eq!(resolve_embed_name(&all, "logo"), None);
    }

    #[test]
    fn name_resolution_is_case_insensitive_and_literal() {
        let all = paths(&["assets/Big Logo.PNG"]);
        assert_eq!(
            resolve_embed_name(&all, "big logo.png").as_deref(),
            Some("assets/Big Logo.PNG")
        );
        // No slug/space normalization.
        assert_eq!(resolve_embed_name(&all, "big-logo.png"), None);
    }

    #[test]
    fn a_partial_path_resolves_by_suffix() {
        let all = paths(&["a/b/target.png", "z/target.png"]);
        assert_eq!(
            resolve_embed_name(&all, "b/target.png").as_deref(),
            Some("a/b/target.png")
        );
        // A full path matches itself.
        assert_eq!(
            resolve_embed_name(&all, "z/target.png").as_deref(),
            Some("z/target.png")
        );
        // A suffix must be `/`-bounded: `get.png` is not a path suffix match.
        assert_eq!(resolve_embed_name(&all, "x/target.png"), None);
    }

    #[test]
    fn duplicates_tiebreak_shortest_then_alphabetically() {
        let all = paths(&["z/dup.png", "a/dup.png", "dup.png"]);
        assert_eq!(
            resolve_embed_name(&all, "dup.png").as_deref(),
            Some("dup.png")
        );
        let all2 = paths(&["z/dup.png", "a/dup.png"]);
        assert_eq!(
            resolve_embed_name(&all2, "dup.png").as_deref(),
            Some("a/dup.png")
        );
        let all3 = paths(&["deep/nest/a/dup.png", "z/dup.png"]);
        assert_eq!(
            resolve_embed_name(&all3, "dup.png").as_deref(),
            Some("z/dup.png")
        );
    }

    #[test]
    fn a_size_or_anchor_suffix_is_stripped_before_matching() {
        let all = paths(&["assets/logo.png"]);
        assert_eq!(
            resolve_embed_name(&all, "logo.png|300x200").as_deref(),
            Some("assets/logo.png")
        );
        assert_eq!(
            resolve_embed_name(&all, "logo.png#frag").as_deref(),
            Some("assets/logo.png")
        );
    }

    #[test]
    fn unresolved_and_empty_names_return_none() {
        let all = paths(&["assets/logo.png"]);
        assert_eq!(resolve_embed_name(&all, "missing.png"), None);
        assert_eq!(resolve_embed_name(&all, ""), None);
        assert_eq!(resolve_embed_name(&all, "   "), None);
        assert_eq!(resolve_embed_name(&[], "logo.png"), None);
    }

    #[test]
    fn a_scanned_name_embed_feeds_resolution_directly() {
        let all = paths(&["assets/img/logo.png"]);
        let e = &scan_embeds("![[img/logo.png|300]]")[0];
        assert_eq!(
            resolve_embed_name(&all, &e.target).as_deref(),
            Some("assets/img/logo.png")
        );
        assert_eq!((e.width, e.height), (Some(300), None));
    }

    // --- size parsing ------------------------------------------------------

    #[test]
    fn parse_size_accepts_only_digits_and_digits_x_digits() {
        assert_eq!(parse_size("300"), Some((300, None)));
        assert_eq!(parse_size("300x200"), Some((300, Some(200))));
        assert_eq!(parse_size("0"), Some((0, None)));
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("x"), None);
        assert_eq!(parse_size("300X200"), None); // lowercase `x` only
        assert_eq!(parse_size("300x"), None);
        assert_eq!(parse_size("x200"), None);
        assert_eq!(parse_size("300x200x100"), None);
        assert_eq!(parse_size("30 0"), None);
        assert_eq!(parse_size("300px"), None);
        assert_eq!(parse_size("-300"), None);
    }

    // --- UTF-16 offsets (the CodeMirror seam) ------------------------------

    #[test]
    fn utf16_scan_matches_byte_scan_on_ascii() {
        let body = "text ![a](x.png) more\n\n![[y.png|300]]\n";
        assert_eq!(scan_embeds_utf16(body), scan_embeds(body));
    }

    /// The bug this variant exists to prevent: a decoration built from a BYTE
    /// offset lands past its Embed once a multi-byte character precedes it.
    #[test]
    fn utf16_offsets_skew_from_byte_offsets_after_non_ascii() {
        // "é" is 2 bytes / 1 UTF-16 unit; "🎨" is 4 bytes / 2 UTF-16 units
        // (a surrogate pair). Prefix: 3 + 1 + 1 + 2 + 1 + 1 = byte 9, unit 7.
        let prefix = "Caf\u{e9} \u{1F3A8} ";
        assert_eq!(prefix.len(), 11);
        assert_eq!(prefix.encode_utf16().count(), 8);

        let body = format!("{prefix}![a](x.png) tail");
        let embed = "![a](x.png)";

        let bytes = scan_embeds(&body);
        assert_eq!(bytes.len(), 1);
        assert_eq!((bytes[0].from, bytes[0].to), (11, 11 + embed.len()));

        let units = scan_embeds_utf16(&body);
        assert_eq!(units.len(), 1);
        assert_eq!((units[0].from, units[0].to), (8, 8 + embed.len()));

        // The UTF-16 span slices the Embed out of the JS-string view of the
        // body; the byte span does NOT (it would cut three chars too late).
        let js: Vec<u16> = body.encode_utf16().collect();
        assert_eq!(
            String::from_utf16_lossy(&js[units[0].from..units[0].to]),
            embed
        );
        assert_ne!(
            String::from_utf16_lossy(&js[bytes[0].from..bytes[0].to.min(js.len())]),
            embed
        );
    }

    #[test]
    fn utf16_offsets_hold_across_several_embeds_and_forms() {
        // Accented + emoji text BETWEEN the Embeds, so the skew accumulates.
        let body = "\u{e9}![[a.png]] \u{1F3A8} ![b](c.png) \u{e9}![[d.png|12x8]]";
        let units = scan_embeds_utf16(body);
        let js: Vec<u16> = body.encode_utf16().collect();
        let sliced: Vec<String> = units
            .iter()
            .map(|e| String::from_utf16_lossy(&js[e.from..e.to]))
            .collect();
        assert_eq!(sliced, vec!["![[a.png]]", "![b](c.png)", "![[d.png|12x8]]"]);
        assert_eq!((units[2].width, units[2].height), (Some(12), Some(8)));
    }

    #[test]
    fn utf16_offsets_survive_non_ascii_inside_the_embed_itself() {
        let body = "![caf\u{e9}](caf\u{e9}.png) after";
        let units = scan_embeds_utf16(body);
        let js: Vec<u16> = body.encode_utf16().collect();
        assert_eq!(
            String::from_utf16_lossy(&js[units[0].from..units[0].to]),
            "![caf\u{e9}](caf\u{e9}.png)"
        );
        assert_eq!(units[0].alt, "caf\u{e9}");
    }
}
