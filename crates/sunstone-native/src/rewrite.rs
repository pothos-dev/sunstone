//! Automatic link rewriting on Concept / folder rename + move.
//!
//! When a Concept (or a whole folder of Concepts) is relocated, every markdown
//! link that resolved to a moved Concept would otherwise break. This module
//! rewrites those links so they keep pointing at the moved target, in both
//! directions and PATH-AWARE:
//!
//!   * INBOUND links — other Concepts that link TO a moved Concept. Found via the
//!     index reverse map. An ABSOLUTE link (`/old.md`) becomes the new absolute
//!     path; a RELATIVE link (`./old.md`, `../old.md`, bare `old.md`) is
//!     recomputed relative to that source's OWN directory so it still resolves —
//!     the relative STYLE is preserved (a relative author keeps a relative link).
//!   * OUTBOUND links — a moved Concept's OWN relative links. Because the file's
//!     base directory changed, its relative links must be recomputed against the
//!     NEW directory so they still resolve to the same targets. Its absolute
//!     links are unaffected and left untouched.
//!   * FOLDER moves apply both rules to every contained Concept. Links BETWEEN
//!     two files that move together stay valid: each moved file is resolved from
//!     its new location, and a target that also moved is mapped to its new path,
//!     so such links are recomputed once (never double-broken).
//!
//! Everything else about a link is preserved byte-for-byte: the link TEXT, the
//! `(...)` delimiters, a trailing `#anchor`, a `?query`, and a `"title"`. Only
//! the path portion of the target is rewritten, and only for links whose
//! resolved target IS a moved Concept. External (`scheme:`) and pure-anchor
//! links are never touched.
//!
//! Path math mirrors `src/lib/links.ts` / `index.rs` EXACTLY (bundle-relative,
//! '/'-separated; `.`/`..` collapse with leading-`..` escapes dropped). The fake
//! backend ports the same logic so the behaviour is testable in Chromium.
//!
//! Pure module logic — `#[tauri::command]` wrappers in `lib.rs` stay thin.

use std::collections::HashMap;

use crate::app_state::AppState;
use crate::bundle;
use crate::index::Index;

mod anchors;
mod engine;
mod paths;

pub use anchors::AnchorRename;
pub use engine::{plan_rewrites, RewriteSummary};

// ---------------------------------------------------------------------------
// Move-set construction (single Concept or whole folder) from the index.
// ---------------------------------------------------------------------------

/// Build the `old -> new` move map for relocating `from` to `to`, where both are
/// bundle-relative. If `from` is a Concept (in the index), the map has one entry.
/// If `from` is a folder, every `.md` Concept under it is remapped under `to`.
///
/// `index` provides the set of Concept paths. Folder detection: any indexed path
/// with the `from/` prefix means `from` is a folder. A `from` that is itself a
/// `.md` path is treated as a single Concept move.
pub fn build_move_map(index: &Index, from: &str, to: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    // A `.md` source is a single Concept move (whether or not it is already in
    // the index — a freshly-created Concept still has its own outbound links to
    // recompute). A non-`.md` source is a folder: remap every Concept under it.
    if from.ends_with(".md") {
        map.insert(from.to_string(), to.to_string());
        return map;
    }
    let from_prefix = format!("{from}/");
    for path in index.concept_paths() {
        if let Some(rest) = path.strip_prefix(&from_prefix) {
            map.insert(path.clone(), format!("{to}/{rest}"));
        }
    }
    map
}

/// The set of source Concepts that link INTO any moved Concept (the inbound
/// linkers), from the index reverse map. Includes moved Concepts that link to
/// other moved Concepts; the caller de-dupes against the move set anyway.
pub fn inbound_sources(index: &Index, moves: &HashMap<String, String>) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for old_target in moves.keys() {
        for source in index.backlinks(old_target) {
            set.insert(source);
        }
    }
    set.into_iter().collect()
}

/// Rename/move `from` to `to`, auto-rewriting every affected link. Plans the
/// rewrites from the CURRENT index (and reads source content) BEFORE the fs
/// move, performs the rename, then writes the rewritten content to the new
/// locations. Reindexes affected Concepts immediately so backlinks / broken-link
/// queries are prompt (the watcher would also catch up asynchronously). Rewrite
/// writes are recorded as self-writes so the watcher does not echo them back as
/// external edits.
pub fn rename_and_rewrite(
    state: &AppState,
    from: &str,
    to: &str,
) -> Result<RewriteSummary, String> {
    let root = &state.bundle_root;

    // 1. Plan: build the move map and read all affected source content from the
    //    CURRENT (pre-move) locations, using a snapshot of the index.
    let (moves, all_paths, planned) = {
        let index = state.index.read().map_err(|e| e.to_string())?;
        let moves = build_move_map(&index, from, to);
        let sources = inbound_sources(&index, &moves);
        // Snapshot of every concept path (OLD bundle state) for name-based
        // wikilink resolution during rewrite.
        let all_paths = index.concept_paths();
        // Read content for every source we might rewrite (inbound + moved).
        let mut seen = std::collections::BTreeSet::new();
        let mut contents: Vec<(String, String)> = Vec::new();
        for s in sources.iter().chain(moves.keys()) {
            if seen.insert(s.clone()) {
                let c = bundle::read_concept(root, s)?;
                contents.push((s.clone(), c));
            }
        }
        (moves, all_paths, contents)
    };

    // 2. Perform the actual filesystem rename/move.
    bundle::rename_path(root, from, to)?;

    // 3. Compute and apply rewrites against the snapshot we read in step 1.
    let lookup: HashMap<&str, &str> = planned
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_str()))
        .collect();
    let sources: Vec<String> = planned.iter().map(|(p, _)| p.clone()).collect();
    let (writes, summary) = plan_rewrites(&moves, &sources, &all_paths, |p| {
        lookup
            .get(p)
            .map(|c| c.to_string())
            .ok_or_else(|| format!("missing source snapshot: {p}"))
    })?;

    // 4. Write rewritten content to the NEW locations and record self-writes so
    //    the watcher does not echo them back as external edits.
    for (new_path, content) in &writes {
        let resolved = bundle::write_concept(root, new_path, content)?;
        state.note_self_write(resolved);
    }

    // 5. Reflect the move in the index in one shot: drop every moved Concept's
    //    OLD path and insert its NEW path, and re-parse every inbound source we
    //    rewrote. Leaving stale old paths behind makes a later folder rename
    //    plan moves for files that no longer exist on disk (the read then
    //    fails) — the watcher would eventually converge, but queries must be
    //    prompt and not race the next command.
    if let Ok(mut index) = state.index.write() {
        let written: HashMap<&str, &str> =
            writes.iter().map(|(p, c)| (p.as_str(), c.as_str())).collect();
        let new_paths: std::collections::HashSet<&str> =
            moves.values().map(String::as_str).collect();
        // Each moved Concept's post-move content: the rewritten body if its
        // links changed (in `written`), else the unchanged pre-move snapshot.
        let moved: Vec<(String, String, String)> = moves
            .iter()
            .map(|(old, new)| {
                let content = written
                    .get(new.as_str())
                    .map(|c| c.to_string())
                    .or_else(|| lookup.get(old.as_str()).map(|c| c.to_string()))
                    .unwrap_or_default();
                (old.clone(), new.clone(), content)
            })
            .collect();
        // Inbound sources that did not move but whose links we rewrote (keyed by
        // their own unchanged path, so not among the moved new paths).
        let rewritten: Vec<(String, String)> = writes
            .iter()
            .filter(|(p, _)| !new_paths.contains(p.as_str()))
            .cloned()
            .collect();
        index.apply_move(&moved, &rewritten);
    }

    Ok(summary)
}

/// Move `from` into the folder `to_dir` (bundle-relative; '' for the root),
/// keeping the original name, then auto-rewrite affected links. Convenience over
/// [`rename_and_rewrite`]; errors if the source is invalid or already there.
pub fn move_into(
    state: &AppState,
    from: &str,
    to_dir: &str,
) -> Result<RewriteSummary, String> {
    let name = from
        .rsplit('/')
        .find(|s| !s.is_empty())
        .ok_or_else(|| format!("invalid source path: {from}"))?;
    let to = if to_dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", to_dir.trim_end_matches('/'), name)
    };
    if to == from {
        return Err(format!("already in that folder: {from}"));
    }
    rename_and_rewrite(state, from, &to)
}

/// Rewrite inbound link anchors after a heading in `target` was renamed in the
/// editor. `renames` maps each changed heading's OLD slug to its NEW slug. Every
/// concept that links to `target` (via the index reverse map) has its matching
/// `#anchor`s rewritten so `[[target#old]]` / `[text](/target.md#old)` follow the
/// heading. `target` ITSELF is excluded — its own same-file anchors are rewritten
/// in the open editor buffer, which is authoritative over the on-disk copy.
///
/// Rewrite writes are recorded as self-writes so the watcher does not echo them,
/// and the affected concepts are reindexed immediately (anchors do not change
/// resolution, so the reverse map is unaffected, but the raw content is refreshed).
pub fn rewrite_anchors(
    state: &AppState,
    target: &str,
    renames: &[AnchorRename],
) -> Result<RewriteSummary, String> {
    if renames.is_empty() {
        return Ok(RewriteSummary::default());
    }
    let root = &state.bundle_root;

    // Snapshot the concept path set (for name-based wikilink resolution) and the
    // set of inbound linkers, excluding the target's own file.
    let (all_paths, sources) = {
        let index = state.index.read().map_err(|e| e.to_string())?;
        let all_paths = index.concept_paths();
        let mut sources = index.backlinks(target);
        sources.retain(|s| s.as_str() != target);
        (all_paths, sources)
    };

    let mut summary = RewriteSummary::default();
    let mut writes: Vec<(String, String)> = Vec::new();
    for source in &sources {
        let content = bundle::read_concept(root, source)?;
        let (rewritten, count) =
            anchors::rewrite_anchors_in(source, &content, target, renames, &all_paths);
        if count > 0 {
            summary.links_changed += count;
            summary.files_changed += 1;
            writes.push((source.clone(), rewritten));
        }
    }

    for (path, content) in &writes {
        let resolved = bundle::write_concept(root, path, content)?;
        state.note_self_write(resolved);
    }
    if let Ok(mut index) = state.index.write() {
        for (path, content) in &writes {
            index.reindex_concept(path, content);
        }
    }

    Ok(summary)
}
