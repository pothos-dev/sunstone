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
//!   in list order.

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
    entries
        .iter()
        .filter(|e| e.is_mapping())
        .map(|e| {
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
                num: None,
            }
        })
        .collect()
}

/// The Sources section of a Concept: `body` is the markdown body, `yaml` the
/// Frontmatter block. Cited entries first, by footnote number; then uncited
/// ones in list order.
pub fn source_list(body: &str, yaml: &str) -> Vec<Source> {
    let mut list = sources(yaml);
    let ids: Vec<String> = list.iter().filter_map(|s| s.id.clone()).collect();
    for f in scan_footnotes(body, &ids) {
        if f.def {
            continue;
        }
        let label = f.label.to_lowercase();
        // The first entry with the id owns it; a duplicate stays uncited.
        if let Some(s) = list
            .iter_mut()
            .find(|s| s.id.as_deref().map(str::to_lowercase).as_deref() == Some(label.as_str()))
        {
            s.num.get_or_insert(f.num);
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
    fn no_sources_or_bad_yaml_is_empty() {
        assert!(sources("type: x\n").is_empty());
        assert!(sources(":\n  - [").is_empty());
        assert!(sources("sources: 3\n").is_empty());
    }
}
