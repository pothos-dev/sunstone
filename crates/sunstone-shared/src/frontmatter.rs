//! Leading YAML frontmatter parsing + splitting (ADR 0006 family 11).
//!
//! The ONE source of truth for the frontmatter kernels that used to exist as
//! drifting TS↔Rust twins:
//!   - [`split`] / [`split_concept`] — locate the leading `---`-fenced block and
//!     slice a Concept into verbatim `open` / `yaml` / `close` / `body` parts, so
//!     an unchanged document recombines byte-for-byte (the former TS
//!     `splitFrontmatter` + the native `split_frontmatter`, reconciled here);
//!   - [`frontmatter_line_count`] — the leading-line offset the editor body view
//!     applies (former TS `frontmatterLineCount`);
//!   - [`parse_frontmatter`] — the `type` / `tags` / top-level keys the Bundle
//!     index cares about (former native `parse_frontmatter` + the fake's
//!     `parseFrontmatter` / `parseFrontmatterKeys`);
//!   - [`frontmatter_fields`] — every top-level entry as `key` + value(s) for the
//!     read-only Properties view (former native `render.rs::frontmatter_fields` +
//!     the fake's `parseFrontmatterFields`).
//!
//! Broken/invalid frontmatter is TOLERATED, never blocked (docs/GLOSSARY.md):
//! parsing returns empty aggregates rather than erroring. The editor's verbatim
//! round-trip Property model stays in TS (`frontmatter.ts`, ADR 0006 §11-C) — it
//! rides on the `yaml` CST source tokens `serde_yaml` cannot provide, and only
//! consumes [`split`] on Concept-load.

use serde::{Deserialize, Serialize};

/// A borrowed 4-slice view of a Concept split into its leading frontmatter block
/// and body. Zero-copy for the native callers; [`split_concept`] builds the
/// owned wasm DTO from it. `content == open + yaml + close + body` byte-for-byte,
/// so a recombination is exact. When `has_frontmatter` is false, `open` / `yaml`
/// / `close` are empty and `body` is the whole content.
pub struct Split<'a> {
    /// True when a leading `---\n … \n---` block is present.
    pub has_frontmatter: bool,
    /// Exact opening delimiter line incl. its trailing newline, e.g. `---\n`.
    pub open: &'a str,
    /// The YAML text BETWEEN the delimiters (no `---` lines). `""` when none.
    pub yaml: &'a str,
    /// Exact closing delimiter line incl. its trailing newline, e.g. `---\n`.
    pub close: &'a str,
    /// The body after the closing fence (the whole content when no frontmatter).
    pub body: &'a str,
}

/// The owned, wasm-boundary form of [`Split`] (ADR 0006 §3/§6 — tsify-canonical
/// DTO, camelCase). Verbatim slices, so byte-preservation holds across the seam.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitConcept {
    pub has_frontmatter: bool,
    pub yaml: String,
    pub body: String,
    pub open: String,
    pub close: String,
}

/// One frontmatter entry for the read-only Properties view. A scalar has a
/// single value; a sequence (e.g. `tags`) has several (ADR 0006 §6 —
/// tsify-canonical; native `render.rs` re-points its `RenderPayload` here).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterField {
    pub key: String,
    pub values: Vec<String>,
}

/// The `type` + `tags` aggregate the fake index surfaces (the former TS
/// `parseFrontmatter` return). `type` is a non-empty string scalar or `null`.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFrontmatter {
    #[serde(rename = "type")]
    pub concept_type: Option<String>,
    pub tags: Vec<String>,
}

/// The frontmatter aggregates the native Bundle index needs from a Concept's
/// leading YAML block. NOT a wasm DTO — native-only (the index builds a
/// `ConceptEntry` from all three fields).
#[derive(Debug, Default, Clone)]
pub struct ParsedFrontmatter {
    /// `type` scalar, if present and non-empty.
    pub concept_type: Option<String>,
    /// `tags` flat list; empty when absent.
    pub tags: Vec<String>,
    /// Distinct top-level frontmatter keys.
    pub keys: Vec<String>,
}

/// Strip one trailing `\r?\n` then any trailing whitespace from `line` — the
/// exact `line.replace(/\r?\n$/, '').trimEnd()` the former TS scanner used to
/// recognise a fence line.
fn fence_trim(line: &str) -> &str {
    let no_nl = line
        .strip_suffix('\n')
        .map(|s| s.strip_suffix('\r').unwrap_or(s))
        .unwrap_or(line);
    no_nl.trim_end()
}

/// Length (bytes) of the opening fence at the very start of `content`, or `None`.
/// The opener is `---`, optional spaces/tabs, an optional `\r`, then a required
/// `\n` (the former TS `/^---[ \t]*\r?\n/`).
fn open_len(content: &str) -> Option<usize> {
    let bytes = content.as_bytes();
    if !content.starts_with("---") {
        return None;
    }
    let mut i = 3;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'\r' {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'\n' {
        Some(i + 1)
    } else {
        None
    }
}

/// Split raw markdown into a leading YAML frontmatter block and the body.
///
/// A frontmatter block is a `---` line at the very start of the file, the YAML up
/// to the next line that is exactly `---` (or `...`), then the body. Delimiters
/// and body are captured verbatim (`content == open + yaml + close + body`) so an
/// unchanged document recombines byte-for-byte. An unterminated block (no closing
/// fence) is NOT frontmatter: `has_frontmatter` is false and `body` is the whole
/// content.
pub fn split(content: &str) -> Split<'_> {
    let Some(open) = open_len(content) else {
        return Split {
            has_frontmatter: false,
            open: "",
            yaml: "",
            close: "",
            body: content,
        };
    };
    let rest = &content[open..];
    // Scan line by line so a fence is only recognised at the start of its line.
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = fence_trim(line);
        if trimmed == "---" || trimmed == "..." {
            return Split {
                has_frontmatter: true,
                open: &content[..open],
                yaml: &rest[..offset],
                close: line,
                body: &rest[offset + line.len()..],
            };
        }
        offset += line.len();
    }
    // No closing fence: not valid frontmatter.
    Split {
        has_frontmatter: false,
        open: "",
        yaml: "",
        close: "",
        body: content,
    }
}

/// The owned wasm-boundary split ([`SplitConcept`]) built from [`split`].
pub fn split_concept(content: &str) -> SplitConcept {
    let s = split(content);
    SplitConcept {
        has_frontmatter: s.has_frontmatter,
        yaml: s.yaml.to_string(),
        body: s.body.to_string(),
        open: s.open.to_string(),
        close: s.close.to_string(),
    }
}

/// Number of leading lines the frontmatter block occupies (0 when none) — the
/// offset between a full-document line number and the body-relative line the
/// editor addresses (the body view holds only the body, ADR 0003). The newline
/// count over `open + yaml + close`.
pub fn frontmatter_line_count(content: &str) -> usize {
    let s = split(content);
    if !s.has_frontmatter {
        return 0;
    }
    let count = |t: &str| t.matches('\n').count();
    count(s.open) + count(s.yaml) + count(s.close)
}

/// Parse the top-level YAML mapping of a Concept's frontmatter, or `None` when
/// there is no valid `---` block / the block does not parse to a mapping.
fn parse_mapping(content: &str) -> Option<serde_yaml::Mapping> {
    let s = split(content);
    if !s.has_frontmatter {
        return None;
    }
    let value: serde_yaml::Value = serde_yaml::from_str(s.yaml).ok()?;
    value.as_mapping().cloned()
}

/// Parse the leading YAML frontmatter block and extract `type` (scalar), `tags`
/// (flat list), and the distinct top-level keys. Tolerates missing/invalid
/// frontmatter: returns an all-empty [`ParsedFrontmatter`] rather than erroring.
pub fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let Some(map) = parse_mapping(content) else {
        return ParsedFrontmatter::default();
    };

    let concept_type = map
        .get(serde_yaml::Value::from("type"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    let tags = map
        .get(serde_yaml::Value::from("tags"))
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let keys = map
        .keys()
        .filter_map(|k| k.as_str().map(|s| s.to_string()))
        .collect();

    ParsedFrontmatter {
        concept_type,
        tags,
        keys,
    }
}

/// Every top-level frontmatter entry as `key` + value(s), in document order (a
/// scalar → one value, a sequence → several). `serde_yaml::Mapping` preserves
/// insertion order. Returns `[]` when there is no valid block.
pub fn frontmatter_fields(content: &str) -> Vec<FrontmatterField> {
    let Some(map) = parse_mapping(content) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(k, v)| {
            k.as_str().map(|key| FrontmatterField {
                key: key.to_string(),
                values: yaml_values(v),
            })
        })
        .collect()
}

/// A YAML value → its scalar string form(s): a sequence yields several.
fn yaml_values(v: &serde_yaml::Value) -> Vec<String> {
    match v {
        serde_yaml::Value::Sequence(seq) => seq.iter().map(scalar_string).collect(),
        _ => vec![scalar_string(v)],
    }
}

/// Stringify a scalar YAML value (a nested map / non-flat sequence falls back to
/// a compact serialized form, rare in fixtures).
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

#[cfg(test)]
mod tests {
    use super::*;

    // --- split (former frontmatter.test.ts::splitFrontmatter + native
    //     split_frontmatter/strip goldens) -------------------------------------

    #[test]
    fn no_frontmatter_whole_content_is_body() {
        let s = split("just a body\n");
        assert!(!s.has_frontmatter);
        assert_eq!(s.body, "just a body\n");
    }

    #[test]
    fn unterminated_block_is_not_frontmatter() {
        let s = split("---\ntype: x\nno close here\n");
        assert!(!s.has_frontmatter);
        assert_eq!(s.body, "---\ntype: x\nno close here\n");
    }

    #[test]
    fn captures_delimiters_and_body_verbatim() {
        let s = split("---\ntype: note\n---\nBody\n");
        assert!(s.has_frontmatter);
        assert_eq!(s.yaml, "type: note\n");
        assert_eq!(s.open, "---\n");
        assert_eq!(s.close, "---\n");
        assert_eq!(s.body, "Body\n");
    }

    #[test]
    fn empty_block_does_not_leak_closing_fence() {
        let s = split("---\n---\nx\n");
        assert!(s.has_frontmatter);
        assert_eq!(s.yaml, "");
        assert_eq!(s.body, "x\n");
    }

    #[test]
    fn closing_fence_with_no_trailing_newline_yields_empty_body() {
        let s = split("---\ntype: x\n---");
        assert!(s.has_frontmatter);
        assert_eq!(s.body, "");
        assert_eq!(s.close, "---");
    }

    #[test]
    fn dotdotdot_terminator_and_padded_fences_recognised() {
        // TS tolerated `...` close + trailing spaces on either fence.
        let s = split("--- \ntype: x\n... \nBody\n");
        assert!(s.has_frontmatter);
        assert_eq!(s.open, "--- \n");
        assert_eq!(s.yaml, "type: x\n");
        assert_eq!(s.close, "... \n");
        assert_eq!(s.body, "Body\n");
    }

    #[test]
    fn crlf_opener() {
        let s = split("---\r\ntype: x\r\n---\r\nBody\r\n");
        assert!(s.has_frontmatter);
        assert_eq!(s.open, "---\r\n");
        assert_eq!(s.body, "Body\r\n");
    }

    #[test]
    fn recombines_byte_for_byte() {
        let content = "---\ntype: note\ntags: [a, b]\n---\nBody text\n";
        let s = split(content);
        let joined = format!("{}{}{}{}", s.open, s.yaml, s.close, s.body);
        assert_eq!(joined, content);
    }

    // --- frontmatter_line_count (former frontmatterLineCount) ----------------

    #[test]
    fn line_count_zero_when_no_block() {
        assert_eq!(frontmatter_line_count("# just body\nmore\n"), 0);
    }

    #[test]
    fn line_count_over_open_yaml_close() {
        assert_eq!(frontmatter_line_count("---\ntype: x\n---\nbody\n"), 3);
        assert_eq!(frontmatter_line_count("---\ntype: x\ntitle: y\n---\nbody\n"), 4);
    }

    // --- parse_frontmatter (former native parse_frontmatter + fake
    //     parseFrontmatter/parseFrontmatterKeys goldens) ----------------------

    fn fm(yaml: &str) -> String {
        format!("---\n{yaml}\n---\n\n# Body\n")
    }

    #[test]
    fn parses_type_and_tags_inline() {
        let p = parse_frontmatter(&fm("type: concept\ntags: [okf, demo]"));
        assert_eq!(p.concept_type.as_deref(), Some("concept"));
        assert_eq!(p.tags, vec!["okf", "demo"]);
    }

    #[test]
    fn parses_block_list_tags() {
        let p = parse_frontmatter(&fm("type: concept\ntags:\n  - okf\n  - demo"));
        assert_eq!(p.tags, vec!["okf", "demo"]);
    }

    #[test]
    fn empty_type_is_absent_but_key_kept() {
        let p = parse_frontmatter(&fm("type:\ntitle: x"));
        assert!(p.concept_type.is_none());
        assert_eq!(p.keys, vec!["type", "title"]);
    }

    #[test]
    fn no_block_yields_empty() {
        let p = parse_frontmatter("# Just a body\n");
        assert!(p.concept_type.is_none());
        assert!(p.tags.is_empty());
        assert!(p.keys.is_empty());
    }

    #[test]
    fn quoted_scalars_and_tags_are_unquoted() {
        assert_eq!(
            parse_frontmatter(&fm("type: \"concept\"")).concept_type.as_deref(),
            Some("concept")
        );
        let p = parse_frontmatter(&fm("type: concept\ntags: [\"a\", \"b\"]"));
        assert_eq!(p.tags, vec!["a", "b"]);
        // A quoted item containing a comma is ONE tag, not split.
        let p = parse_frontmatter(&fm("type: concept\ntags: [\"a, b\", c]"));
        assert_eq!(p.tags, vec!["a, b", "c"]);
    }

    #[test]
    fn distinct_top_level_keys_only() {
        let mut keys = parse_frontmatter(&fm(
            "type: concept\ntitle: T\nnested:\n  author: jane\ntags:\n  - a",
        ))
        .keys;
        keys.sort();
        assert_eq!(keys, vec!["nested", "tags", "title", "type"]);
    }

    #[test]
    fn quoted_key_is_unquoted() {
        let p = parse_frontmatter(&fm("type: concept\n\"custom field\": v"));
        assert!(p.keys.iter().any(|k| k == "custom field"));
    }

    // --- frontmatter_fields (former render.rs frontmatter_fields + fake
    //     parseFrontmatterFields) ---------------------------------------------

    #[test]
    fn fields_in_document_order_with_seq_values() {
        let fields = frontmatter_fields(
            "---\ntype: concept\ntitle: Hello\ntags:\n  - a\n  - b\n---\n# Body\n",
        );
        let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["type", "title", "tags"]);
        let tags = &fields.iter().find(|f| f.key == "tags").unwrap().values;
        assert_eq!(tags, &vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn fields_empty_when_no_block() {
        assert!(frontmatter_fields("# Body only\n").is_empty());
    }
}
