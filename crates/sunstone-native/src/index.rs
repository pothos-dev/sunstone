//! In-memory Bundle index: per-Concept frontmatter + outbound internal links,
//! plus a reverse (backlink) map and aggregate tag/type sets.
//!
//! Built on startup by walking the Bundle (via the `ignore` crate, like
//! `bundle.rs`) and kept current incrementally by the filesystem watcher
//! (`watcher.rs`): a created/modified/removed Concept reindexes just that file
//! and refreshes the reverse map and aggregates.
//!
//! Link resolution mirrors `src/lib/links.ts` EXACTLY (bundle-absolute `/x.md`
//! from the root; relative `./`, `../`, or bare `x.md` against the Concept's
//! directory; external `scheme:` and pure-anchor links ignored). Keeping the
//! two in lock-step is what lets the frontend's broken-link decoration trust
//! the Rust index.
//!
//! Pure module logic — `#[tauri::command]` wrappers in `lib.rs` stay thin.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::paths::md_files;
use crate::wikilink;

pub mod frontmatter;
mod links;

use frontmatter::{parse_frontmatter, strip_frontmatter, ParsedFrontmatter};
use links::extract_links;

/// One Concept's indexed data: parsed frontmatter fields we care about plus its
/// outbound internal links (bundle-relative target paths).
#[derive(Debug, Clone, Default)]
pub struct ConceptEntry {
    /// `type` from the frontmatter, if present (docs/GLOSSARY.md: required, but we
    /// tolerate it missing/empty — broken Concepts are never blocked).
    pub concept_type: Option<String>,
    /// `tags` from the frontmatter (flat list); empty when absent.
    pub tags: Vec<String>,
    /// Distinct top-level frontmatter keys (e.g. `type`, `title`, `tags`).
    /// Feeds the Properties panel's key-name autocomplete (key-and-tag
    /// autocomplete slice). Empty when the Concept has no/invalid frontmatter.
    pub keys: Vec<String>,
    /// Outbound internal link targets (bundle-relative, '/'-separated).
    pub links: Vec<String>,
    /// Raw wikilink inner texts (`[[ ... ]]`, alias/anchor included). Resolved
    /// to bundle paths in `rebuild_reverse`, which has the full path set —
    /// name-based resolution needs to see every concept, unlike the path-based
    /// markdown links above which resolve from this concept's location alone.
    pub wikilinks: Vec<String>,
}

/// A tag and how many Concepts carry it. Matches the TS `{ tag, count }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

/// The in-memory index, stored in `AppState` behind a lock. Forward map keyed
/// by Concept path; reverse map (target -> sources) for backlinks; aggregates
/// recomputed from the forward map on each mutation (correct over micro-fast).
#[derive(Debug, Default)]
pub struct Index {
    /// path -> indexed entry, for every `.md` Concept in the Bundle.
    concepts: HashMap<String, ConceptEntry>,
    /// target path -> set of source paths linking TO it (backlinks).
    reverse: HashMap<String, BTreeSet<String>>,
}

impl Index {
    /// Build a fresh index by walking the Bundle root. Mirrors `bundle.rs`'s
    /// walker settings (hidden + gitignore aware) and only indexes `.md` files.
    pub fn build(root: &Path) -> Self {
        let mut index = Index::default();
        for (path, rel) in md_files(root) {
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            index.insert_concept(&rel, &content);
        }
        index.rebuild_reverse();
        index
    }

    /// Insert/replace a single Concept's parsed entry in the forward map. Does
    /// NOT touch the reverse map — call `rebuild_reverse` after a batch, or use
    /// `reindex_concept` for the incremental single-file path.
    fn insert_concept(&mut self, rel: &str, content: &str) {
        let ParsedFrontmatter {
            concept_type,
            tags,
            keys,
        } = parse_frontmatter(content);
        let links = extract_links(rel, content);
        // Wikilink inner texts are captured raw here and resolved later in
        // `rebuild_reverse` (name-based resolution needs the full path set).
        let wikilinks = wikilink::wikilink_raws(strip_frontmatter(content));
        self.concepts.insert(
            rel.to_string(),
            ConceptEntry {
                concept_type,
                tags,
                keys,
                links,
                wikilinks,
            },
        );
    }

    /// Recompute the reverse (backlink) map from scratch from the forward map.
    fn rebuild_reverse(&mut self) {
        // The full set of concept paths, needed for name-based wikilink
        // resolution (basename / path-suffix matching across the whole bundle).
        let all_paths: Vec<String> = self.concepts.keys().cloned().collect();
        let mut reverse: HashMap<String, BTreeSet<String>> = HashMap::new();
        for (source, entry) in &self.concepts {
            // Markdown links (already resolved by path).
            for target in &entry.links {
                reverse
                    .entry(target.clone())
                    .or_default()
                    .insert(source.clone());
            }
            // Wikilinks resolve by NAME against every concept. Each resolved
            // target feeds the same reverse map -> Backlinks works unchanged.
            // Unresolved (`None`) wikilinks contribute no edge; a self-target
            // (`[[#heading]]` -> source) creates no self-backlink.
            for raw in &entry.wikilinks {
                if let Some(target) = wikilink::resolve_wikilink(&all_paths, source, raw) {
                    if target != *source {
                        reverse.entry(target).or_default().insert(source.clone());
                    }
                }
            }
        }
        self.reverse = reverse;
    }

    /// Incrementally reindex a single Concept that was created or modified.
    /// Re-parses it, replaces its forward entry, and rebuilds the reverse map.
    /// (Reverse rebuild is O(total links) — correct and simple; the Bundle is
    /// small enough that this is fine, per the ticket's "correct not micro".)
    pub fn reindex_concept(&mut self, rel: &str, content: &str) {
        self.insert_concept(rel, content);
        self.rebuild_reverse();
    }

    /// Reflect a completed filesystem move/rename in the index in one shot:
    /// every moved Concept's OLD path is dropped and its NEW path inserted, and
    /// every inbound source we rewrote is re-parsed at its (unchanged) path.
    /// The reverse map is rebuilt once at the end.
    ///
    /// `moved` is `(old_path, new_path, new_content)` per moved Concept;
    /// `rewritten` is `(path, content)` for inbound linkers that did not move
    /// but whose links were updated. Removing the old paths is the crucial bit:
    /// leaving them stale makes a later folder rename plan moves for files that
    /// no longer exist on disk, which then fails to read them.
    pub fn apply_move(
        &mut self,
        moved: &[(String, String, String)],
        rewritten: &[(String, String)],
    ) {
        // Drop every old path first, then insert the new ones — old and new
        // path sets are disjoint for any valid move, so order only matters in
        // that a removed old path must not clobber a freshly inserted new one.
        for (old, _new, _content) in moved {
            self.concepts.remove(old);
        }
        for (_old, new, content) in moved {
            self.insert_concept(new, content);
        }
        for (path, content) in rewritten {
            self.insert_concept(path, content);
        }
        self.rebuild_reverse();
    }

    /// Remove a Concept that was deleted from disk. Drops its forward entry and
    /// rebuilds the reverse map so its outbound backlinks disappear. Note: other
    /// Concepts may still link TO the removed path (now a broken link) — that is
    /// tolerated and surfaced by the broken-link consumer, not erased here.
    pub fn remove_concept(&mut self, rel: &str) {
        self.concepts.remove(rel);
        self.rebuild_reverse();
    }

    /// True if a Concept exists at `path` (an exact bundle-relative key).
    pub fn concept_exists(&self, path: &str) -> bool {
        self.concepts.contains_key(path)
    }

    /// Every Concept path in the index, sorted. The broken-link decoration seeds
    /// its synchronous existence cache from this (one query at load instead of
    /// per-link round-trips).
    pub fn concept_paths(&self) -> Vec<String> {
        let mut v: Vec<String> = self.concepts.keys().cloned().collect();
        v.sort();
        v
    }

    /// Sources linking TO `path` (backlinks), sorted. Empty when none.
    pub fn backlinks(&self, path: &str) -> Vec<String> {
        self.reverse
            .get(path)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// All tags across the Bundle with per-tag Concept counts, sorted by tag.
    pub fn all_tags(&self) -> Vec<TagCount> {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for entry in self.concepts.values() {
            // De-dupe within a single Concept so a repeated tag counts once.
            let mut seen: HashSet<&str> = HashSet::new();
            for tag in &entry.tags {
                if seen.insert(tag.as_str()) {
                    *counts.entry(tag.clone()).or_default() += 1;
                }
            }
        }
        counts
            .into_iter()
            .map(|(tag, count)| TagCount { tag, count })
            .collect()
    }

    /// Concept paths carrying `tag` in their frontmatter `tags`, sorted. Empty
    /// when no Concept carries it. The index holds per-Concept tags, so this is
    /// a direct query (the tag browser slice avoids scanning on the frontend).
    pub fn concepts_by_tag(&self, tag: &str) -> Vec<String> {
        let mut out: BTreeSet<String> = BTreeSet::new();
        for (path, entry) in &self.concepts {
            if entry.tags.iter().any(|t| t == tag) {
                out.insert(path.clone());
            }
        }
        out.into_iter().collect()
    }

    /// All distinct frontmatter `type` values across the Bundle, sorted.
    pub fn all_types(&self) -> Vec<String> {
        let mut set: BTreeSet<String> = BTreeSet::new();
        for entry in self.concepts.values() {
            if let Some(t) = &entry.concept_type {
                if !t.is_empty() {
                    set.insert(t.clone());
                }
            }
        }
        set.into_iter().collect()
    }

    /// All distinct top-level frontmatter keys used across the Bundle, sorted.
    /// Feeds the Properties panel's key-name autocomplete (the OKF recommended
    /// keys are merged in client-side, so this is bundle-sourced only).
    pub fn all_keys(&self) -> Vec<String> {
        let mut set: BTreeSet<String> = BTreeSet::new();
        for entry in self.concepts.values() {
            for key in &entry.keys {
                set.insert(key.clone());
            }
        }
        set.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_reverse_map_and_backlinks() {
        let mut idx = Index::default();
        idx.insert_concept("a.md", "[to b](/b.md)\n[to c](/c.md)");
        idx.insert_concept("b.md", "[to c](/c.md)");
        idx.insert_concept("c.md", "no links");
        idx.rebuild_reverse();
        assert_eq!(idx.backlinks("c.md"), vec!["a.md", "b.md"]);
        assert_eq!(idx.backlinks("b.md"), vec!["a.md"]);
        assert!(idx.backlinks("a.md").is_empty());
    }

    #[test]
    fn backlinks_via_wikilink() {
        // a links to b by bare wikilink (basename match); c links to b by a
        // partial-path wikilink. Both edges feed the reverse map.
        let mut idx = Index::default();
        idx.insert_concept("a.md", "see [[b]] now");
        idx.insert_concept("sub/b.md", "# B");
        idx.insert_concept("c.md", "see [[sub/b]] now");
        idx.rebuild_reverse();
        assert_eq!(idx.backlinks("sub/b.md"), vec!["a.md", "c.md"]);
    }

    #[test]
    fn wikilink_alias_anchor_and_self_anchor() {
        let mut idx = Index::default();
        // Alias + anchor are stripped before resolution.
        idx.insert_concept("a.md", "[[b|Bee]] and [[b#sec]]");
        idx.insert_concept("b.md", "# B");
        // A pure same-file anchor must NOT create a self-backlink.
        idx.insert_concept("c.md", "jump to [[#top]]");
        idx.rebuild_reverse();
        assert_eq!(idx.backlinks("b.md"), vec!["a.md"]);
        assert!(idx.backlinks("c.md").is_empty());
    }

    #[test]
    fn unresolved_wikilink_contributes_no_edge() {
        let mut idx = Index::default();
        idx.insert_concept("a.md", "[[does-not-exist]]");
        idx.insert_concept("b.md", "# B");
        idx.rebuild_reverse();
        assert!(idx.backlinks("b.md").is_empty());
    }

    #[test]
    fn apply_move_drops_old_paths_and_reindexes() {
        // `home.md` links to a concept living under `outer/inner/`.
        let mut idx = Index::default();
        idx.insert_concept("home.md", "see [[doc]]");
        idx.insert_concept("outer/inner/doc.md", "# Doc");
        idx.rebuild_reverse();
        assert_eq!(idx.backlinks("outer/inner/doc.md"), vec!["home.md"]);

        // Move `outer/inner/doc.md` out to the root. The link in home.md is
        // rewritten (an inbound rewrite); the moved file keeps its content.
        idx.apply_move(
            &[(
                "outer/inner/doc.md".to_string(),
                "inner/doc.md".to_string(),
                "# Doc".to_string(),
            )],
            &[("home.md".to_string(), "see [[doc]]".to_string())],
        );

        // The stale old path is gone and the new one is present — so a later
        // folder rename will not plan a move for a file that no longer exists.
        assert!(!idx.concept_exists("outer/inner/doc.md"));
        assert!(idx.concept_exists("inner/doc.md"));
        assert_eq!(idx.concept_paths(), vec!["home.md", "inner/doc.md"]);
        assert_eq!(idx.backlinks("inner/doc.md"), vec!["home.md"]);
        assert!(idx.backlinks("outer/inner/doc.md").is_empty());
    }

    #[test]
    fn aggregates_tags_and_types() {
        let mut idx = Index::default();
        idx.insert_concept("a.md", "---\ntype: concept\ntags: [x, y]\n---\n");
        idx.insert_concept("b.md", "---\ntype: index\ntags: [x]\n---\n");
        idx.rebuild_reverse();
        let tags = idx.all_tags();
        assert_eq!(tags.len(), 2);
        let x = tags.iter().find(|t| t.tag == "x").unwrap();
        assert_eq!(x.count, 2);
        assert_eq!(idx.all_types(), vec!["concept", "index"]);
    }

    #[test]
    fn aggregates_distinct_keys() {
        let mut idx = Index::default();
        idx.insert_concept("a.md", "---\ntype: concept\ntitle: A\ntags: [x]\n---\n");
        idx.insert_concept("b.md", "---\ntype: index\ndescription: B\n---\n");
        idx.insert_concept("c.md", "no frontmatter here");
        idx.rebuild_reverse();
        // Distinct, sorted; duplicates across Concepts collapse.
        assert_eq!(
            idx.all_keys(),
            vec!["description", "tags", "title", "type"]
        );
    }

    #[test]
    fn lists_concepts_by_tag() {
        let mut idx = Index::default();
        idx.insert_concept("a.md", "---\ntype: concept\ntags: [x, y]\n---\n");
        idx.insert_concept("b.md", "---\ntype: index\ntags: [x]\n---\n");
        idx.insert_concept("c.md", "---\ntype: concept\ntags: [z]\n---\n");
        idx.rebuild_reverse();
        assert_eq!(idx.concepts_by_tag("x"), vec!["a.md", "b.md"]);
        assert_eq!(idx.concepts_by_tag("y"), vec!["a.md"]);
        assert!(idx.concepts_by_tag("nope").is_empty());
    }
}
