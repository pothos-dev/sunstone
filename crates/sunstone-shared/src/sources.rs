//! The `sources` Frontmatter list (OKF v0.2 §5.1) as the Sources section reads it.
//!
//! The ONE reading of `sources` for the editor's Sources section and footnote
//! clicks (`src/lib/editor/sources.ts`, over wasm) and the native render's
//! Sources section (`sunstone-native/src/render/footnotes.rs`), so both shells
//! number, label and link a source the same way (ADR 0006).
//!
//! - Entries are read in list order; an entry that is not a map is skipped.
//!   `resource` is required by the spec but tolerated missing (empty).
//! - A `resource` is classified as an absolute URL, a path (bundle-relative
//!   with a leading `/`, or relative to the Concept), or a scope descriptor
//!   (`all queries in BigQuery project X`) that cannot be followed (§6.2).
//! - [`source_list`] numbers each entry by the first `[^id]` citing it, the
//!   number the footnote superscript shows; uncited entries follow, unnumbered,
//!   in list order. It also records where the body cites each entry (`refs`,
//!   the jumps back to the claims) and the text of a body `[^id]: …`
//!   definition, if one was written (`note`; the renderers hide that line and
//!   show the text on the entry instead, ov-10).
//! - `usage_window` (`{ from, to }`) is read as a sibling of `sources` and
//!   framing every `usage_count`; an entry's own `usage_window` overrides it.

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::footnotes::scan_footnotes;
use crate::paths::is_external;

/// What a `resource` names (§5.1, §6.2).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    /// An absolute URL (`https://…`), opened outside the app.
    Url,
    /// A bundle-relative (`/…`) or Concept-relative path, opened in the app.
    Path,
    /// A population or scope descriptor; not followable.
    Descriptor,
}

/// The `{ from, to }` range a `usage_count` was counted over (§5.1). Either
/// bound may be missing; the values are kept as written.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub from: Option<String>,
    pub to: Option<String>,
}

/// One `sources` entry, with its citation number.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: Option<String>,
    pub resource: String,
    pub kind: ResourceKind,
    pub title: Option<String>,
    pub author: Option<String>,
    pub usage_count: Option<String>,
    pub last_modified: Option<String>,
    /// The window `usage_count` covers: the entry's own `usage_window`, else
    /// the one written beside `sources`.
    pub usage_window: Option<UsageWindow>,
    /// The entry's position in the `sources` list as written (counting every
    /// item), so an editor can find it in the YAML.
    pub index: usize,
    /// The text of a body `[^id]: …` definition for this entry's id, if the
    /// body has one (its first). Shown on the entry; the line itself is hidden.
    pub note: Option<String>,
    /// Where the body cites this entry: the UTF-16 offset of each `[^id]`
    /// reference, in document order. Empty when uncited.
    pub refs: Vec<usize>,
    /// The footnote number of the first `[^id]` citing this entry, or `None`
    /// when the body does not cite it.
    pub num: Option<usize>,
}

/// Classify a `resource` value.
pub fn resource_kind(resource: &str) -> ResourceKind {
    let r = resource.trim();
    if r.is_empty() {
        ResourceKind::Descriptor
    } else if is_external(r) {
        ResourceKind::Url
    } else if r.starts_with('/') || r.starts_with("./") || r.starts_with("../") {
        ResourceKind::Path
    } else if r.chars().any(char::is_whitespace) {
        ResourceKind::Descriptor
    } else {
        ResourceKind::Path
    }
}

/// The `sources` entries of a Frontmatter block (the inner YAML, without `---`
/// fences), in list order and unnumbered. Empty when the block does not parse
/// or has no `sources` list.
pub fn sources(yaml: &str) -> Vec<Source> {
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(yaml) else {
        return Vec::new();
    };
    let Some(Value::Sequence(entries)) = map.get(Value::from("sources")) else {
        return Vec::new();
    };
    let shared = map.get(Value::from("usage_window")).and_then(usage_window);
    entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.is_mapping())
        .map(|(index, e)| {
            let field = |k: &str| e.get(k).and_then(scalar);
            let resource = field("resource").unwrap_or_default();
            Source {
                id: field("id"),
                kind: resource_kind(&resource),
                resource,
                title: field("title"),
                author: field("author"),
                usage_count: field("usage_count"),
                last_modified: field("last_modified"),
                usage_window: e
                    .get("usage_window")
                    .and_then(usage_window)
                    .or_else(|| shared.clone()),
                index,
                note: None,
                refs: Vec::new(),
                num: None,
            }
        })
        .collect()
}

/// A `{ from, to }` map; `None` when it is not a map or has neither bound.
fn usage_window(v: &Value) -> Option<UsageWindow> {
    if !v.is_mapping() {
        return None;
    }
    let w = UsageWindow {
        from: v.get("from").and_then(scalar),
        to: v.get("to").and_then(scalar),
    };
    (w.from.is_some() || w.to.is_some()).then_some(w)
}

/// The Sources section of a Concept: `body` is the markdown body, `yaml` the
/// Frontmatter block. Cited entries first, by footnote number; then uncited
/// ones in list order.
pub fn source_list(body: &str, yaml: &str) -> Vec<Source> {
    let mut list = sources(yaml);
    let ids: Vec<String> = list.iter().filter_map(|s| s.id.clone()).collect();
    let units: Vec<u16> = body.encode_utf16().collect();
    for f in scan_footnotes(body, &ids) {
        let label = f.label.to_lowercase();
        // The first entry with the id owns it; a duplicate stays uncited.
        let Some(s) = list
            .iter_mut()
            .find(|s| s.id.as_deref().map(str::to_lowercase).as_deref() == Some(label.as_str()))
        else {
            continue;
        };
        if f.def {
            if s.note.is_none() {
                let end = units[f.to..]
                    .iter()
                    .position(|&u| u == u16::from(b'\n'))
                    .map_or(units.len(), |p| f.to + p);
                let text = String::from_utf16_lossy(&units[f.to..end]).trim().to_string();
                s.note = (!text.is_empty()).then_some(text);
            }
        } else {
            s.num.get_or_insert(f.num);
            s.refs.push(f.from);
        }
    }
    // Stable: uncited entries keep list order.
    list.sort_by_key(|s| s.num.unwrap_or(usize::MAX));
    list
}

/// A YAML scalar as text; `None` for null, maps and lists.
fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const YAML: &str = "type: module\nsources:\n  - id: b\n    resource: /x/b.md\n    title: Bee\n  - id: a\n    resource: https://a.example\n    author: human:dan\n    usage_count: 5\n  - resource: all queries in project X\n  - id: c\n    resource: ../c.md\n";

    #[test]
    fn resource_kinds() {
        assert_eq!(resource_kind("https://x"), ResourceKind::Url);
        assert_eq!(resource_kind("/offers/a b.md"), ResourceKind::Path);
        assert_eq!(resource_kind("../c.md"), ResourceKind::Path);
        assert_eq!(resource_kind("references/skills/run.md"), ResourceKind::Path);
        assert_eq!(resource_kind("all queries in BigQuery project X"), ResourceKind::Descriptor);
        assert_eq!(resource_kind(""), ResourceKind::Descriptor);
    }

    #[test]
    fn entries_read_in_list_order() {
        let s = sources(YAML);
        assert_eq!(s.len(), 4);
        assert_eq!(s[0].id.as_deref(), Some("b"));
        assert_eq!(s[1].usage_count.as_deref(), Some("5"));
        assert_eq!(s[2].id, None);
        assert_eq!(s[2].kind, ResourceKind::Descriptor);
        assert_eq!(s[0].title.as_deref(), Some("Bee"));
        assert_eq!(s[1].author.as_deref(), Some("human:dan"));
    }

    #[test]
    fn list_numbers_by_first_citation_then_uncited_in_list_order() {
        let body = "One[^a] two[^n] three[^B][^a].\n\n[^n]: a note\n";
        let list = source_list(body, YAML);
        let order: Vec<_> = list.iter().map(|s| (s.id.as_deref(), s.num)).collect();
        assert_eq!(order, vec![(Some("a"), Some(1)), (Some("b"), Some(3)), (None, None), (Some("c"), None)]);
    }

    #[test]
    fn reordering_sources_keeps_numbers() {
        let body = "x[^a] y[^b]\n";
        let swapped = "sources:\n  - id: b\n    resource: /b.md\n  - id: a\n    resource: /a.md\n";
        let list = source_list(body, swapped);
        assert_eq!(list[0].id.as_deref(), Some("a"));
        assert_eq!(list[0].num, Some(1));
        assert_eq!(list[1].num, Some(2));
    }

    #[test]
    fn usage_window_is_shared_and_overridable() {
        let yaml = "sources:\n  - id: a\n    resource: /a.md\n    usage_count: 5\n  - id: b\n    resource: /b.md\n    usage_window: { from: 2026-01-01T00:00:00Z, to: 2026-02-01T00:00:00Z }\nusage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }\n";
        let s = sources(yaml);
        let w = |f: &str, t: &str| Some(UsageWindow { from: Some(f.into()), to: Some(t.into()) });
        assert_eq!(s[0].usage_window, w("2026-06-01T00:00:00Z", "2026-06-30T00:00:00Z"));
        assert_eq!(s[1].usage_window, w("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"));
        // No window anywhere, or one that is not a map: none.
        assert_eq!(sources("sources:\n  - resource: x\n")[0].usage_window, None);
        assert_eq!(sources("sources:\n  - resource: x\nusage_window: 3\n")[0].usage_window, None);
        // A half-open window keeps the bound it has.
        let half = sources("sources:\n  - resource: x\n    usage_window: { from: 2026-01-01 }\n");
        assert_eq!(half[0].usage_window, Some(UsageWindow { from: Some("2026-01-01".into()), to: None }));
    }

    #[test]
    fn index_counts_every_list_item() {
        let s = sources("sources:\n  - just text\n  - resource: /a.md\n  - resource: /b.md\n");
        assert_eq!(s.iter().map(|s| s.index).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn list_records_citing_places_and_a_body_definition() {
        let body = "One[^a] two[^b] three[^A].\n\n[^a]: Written by hand  \n[^zz]: not a source\n";
        let list = source_list(body, YAML);
        let a = list.iter().find(|s| s.id.as_deref() == Some("a")).unwrap();
        assert_eq!(a.refs, vec![3, 21]);
        assert_eq!(a.note.as_deref(), Some("Written by hand"));
        let b = list.iter().find(|s| s.id.as_deref() == Some("b")).unwrap();
        assert_eq!(b.refs, vec![11]);
        assert_eq!(b.note, None);
        let c = list.iter().find(|s| s.id.as_deref() == Some("c")).unwrap();
        assert!(c.refs.is_empty());
    }

    #[test]
    fn an_empty_body_definition_has_no_note() {
        let list = source_list("x[^a]\n\n[^a]:\n", YAML);
        assert_eq!(list[0].note, None);
    }

    #[test]
    fn a_source_needs_no_body_definition() {
        let list = source_list("Claim.[^c]\n", YAML);
        assert_eq!(list[0].id.as_deref(), Some("c"));
        assert_eq!(list[0].num, Some(1));
        assert!(scan_footnotes("Claim.[^c]\n", &["c".into()])[0].defined);
    }

    #[test]
    fn no_sources_or_bad_yaml_is_empty() {
        assert!(sources("type: x\n").is_empty());
        assert!(sources(":\n  - [").is_empty());
        assert!(sources("sources: 3\n").is_empty());
    }
}
