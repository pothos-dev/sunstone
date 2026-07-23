//! Filesystem watcher: a `notify` recursive watcher over the Bundle root that
//! reports file changes on disk through a caller-supplied sink.
//!
//! Host-agnostic: this module does NOT depend on `tauri`. `start` takes the
//! Bundle root, a shared handle to the `AppState` (for the index + self-write
//! tracker), and a `sink` callback that receives each `FileChange`. The desktop
//! shell passes a sink that `app.emit(FILE_CHANGED_EVENT, change)`s to the
//! frontend; another host (e.g. the web server) can pass any drain.
//!
//! Self-write suppression lives here: before a change reaches the sink, each
//! changed path is checked against `AppState`'s self-write tracker. Paths
//! Sunstone just wrote (autosave) are swallowed, so our own writes never cause
//! a reload loop or cursor jump. Genuine external edits still flow through.
//!
//! Pure-ish module logic — the host just calls `start` in setup.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::app_state::AppState;

/// Event name a host emits on a (non-self) filesystem change. Kept here so the
/// Tauri shell and any other host share one canonical string.
pub const FILE_CHANGED_EVENT: &str = "file-changed";

/// A filesystem change reported to the host's sink. `paths` are bundle-relative,
/// '/'-separated. Matches the TS `FileChange` type across the IPC seam.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// What happened: "created" | "modified" | "removed".
    pub kind: String,
    /// Affected bundle-relative paths.
    pub paths: Vec<String>,
    /// Attribution for a *web write* (ticket 08): the originating tab's
    /// `clientId` + the authoring OIDC user. `None` for a desktop/external edit
    /// (the watcher always emits `None` — it cannot know the writer), so every
    /// client treats a watcher-sourced change as genuine. The web write path
    /// broadcasts its own stamped change instead. Omitted from JSON when `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<FileOrigin>,
}

/// Web-write attribution stamped onto a broadcast `FileChange` so each browser
/// can drop the echo of *its own* write (`origin.clientId == myClientId`) while
/// treating every other write as a genuine external change (ticket 08 §1).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOrigin {
    /// The originating browser tab's in-memory client id (forwarded on the write).
    pub client_id: String,
    /// The authoring user (OIDC identity), for the "Updated by <name>" notice.
    pub author: FileAuthor,
}

/// The authoring user carried in a [`FileOrigin`]. Only `name` is surfaced to
/// other clients (no email over the change channel).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAuthor {
    pub name: String,
}

/// Start watching `root` recursively, keeping `state`'s index current and
/// delivering each (non-self) change to `sink`. The returned watcher must be
/// kept alive (managed in a long-lived owner) or watching stops.
///
/// `state` is a shared handle to the SAME `AppState` the host's command layer
/// uses, so index updates and self-write suppression observe one source of
/// truth. `sink` is invoked from the watcher's own thread, hence the `Send`
/// bound.
pub fn start<F>(root: PathBuf, state: Arc<AppState>, sink: F) -> Result<RecommendedWatcher, String>
where
    F: Fn(FileChange) + Send + 'static,
{
    let watch_root = root.clone();
    let mut watcher = notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            handle_event(&state, &root, &sink, event);
        },
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&watch_root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    Ok(watcher)
}

/// Translate a notify event into a `FileChange` for the `sink`, applying
/// self-write suppression and path-to-bundle-relative conversion.
fn handle_event<F>(state: &AppState, root: &Path, sink: &F, event: notify::Event)
where
    F: Fn(FileChange),
{
    let kind = match classify(&event.kind) {
        Some(k) => k,
        None => return, // access/other events are noise for the UI
    };

    let mut rel_paths: Vec<String> = Vec::new();
    for abs in &event.paths {
        let Some(rel) = to_bundle_relative(root, abs) else {
            continue;
        };

        // Keep the index current for EVERY change, including Sunstone's own
        // autosave writes — the index must reflect on-disk truth regardless of
        // who wrote it. (Only the *frontend event* is suppressed for self
        // writes, below, to avoid reload loops / cursor jumps.)
        if rel.ends_with(".md") {
            update_index(state, &rel, abs, kind);
        }

        // Suppress Sunstone's own writes for the frontend echo.
        if state.is_recent_self_write(abs) {
            continue;
        }
        rel_paths.push(rel);
    }

    if rel_paths.is_empty() {
        return;
    }

    sink(FileChange {
        kind: kind.to_string(),
        paths: rel_paths,
        // The watcher cannot attribute a change to a web writer — always genuine.
        origin: None,
    });
}

/// Apply a single Concept change to the in-memory index. Created/modified read
/// the new content from disk and reindex; removed drops the entry. Mirrors the
/// startup build so the index stays correct without a restart. Lock-poison and
/// transient read errors are tolerated (the index is best-effort; a stale entry
/// never blocks editing — broken links are tolerated by design).
fn update_index(state: &AppState, rel: &str, abs: &Path, kind: &str) {
    let Ok(mut index) = state.index.write() else {
        return;
    };
    match kind {
        "removed" => index.remove_concept(rel),
        _ => {
            // created | modified: re-read and reindex. If the read fails (e.g. a
            // create event for a file already gone), treat it as a removal.
            match std::fs::read_to_string(abs) {
                Ok(content) => index.reindex_concept(rel, &content),
                Err(_) => index.remove_concept(rel),
            }
        }
    }
}

/// Map a notify `EventKind` to our coarse "created"/"modified"/"removed"
/// vocabulary, or `None` for events the UI does not care about.
fn classify(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Modify(_) => Some("modified"),
        EventKind::Remove(_) => Some("removed"),
        _ => None,
    }
}

/// Convert an absolute path under the Bundle root into a '/'-separated
/// bundle-relative string. Returns `None` if the path is outside the root.
fn to_bundle_relative(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let s = crate::paths::to_rel_string(rel);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Hold the watcher alive for the lifetime of the app. We wrap it so `lib.rs`
/// can stash it without naming the concrete watcher type everywhere. The field
/// is never read — owning it is what keeps the watcher (and thus watching) alive.
pub struct WatcherHandle(#[allow(dead_code)] RecommendedWatcher);

impl WatcherHandle {
    pub fn new(watcher: RecommendedWatcher) -> Self {
        WatcherHandle(watcher)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind};
    use std::path::PathBuf;

    #[test]
    fn classify_maps_the_three_ui_kinds() {
        assert_eq!(classify(&EventKind::Create(CreateKind::Any)), Some("created"));
        assert_eq!(
            classify(&EventKind::Modify(ModifyKind::Any)),
            Some("modified")
        );
        assert_eq!(classify(&EventKind::Remove(RemoveKind::Any)), Some("removed"));
    }

    #[test]
    fn classify_ignores_access_and_other_events() {
        assert_eq!(classify(&EventKind::Access(AccessKind::Any)), None);
        assert_eq!(classify(&EventKind::Any), None);
        assert_eq!(classify(&EventKind::Other), None);
    }

    #[test]
    fn to_bundle_relative_strips_root_and_uses_forward_slashes() {
        let root = PathBuf::from("/bundle");
        assert_eq!(
            to_bundle_relative(&root, &PathBuf::from("/bundle/a/b.md")),
            Some("a/b.md".to_string())
        );
        assert_eq!(
            to_bundle_relative(&root, &PathBuf::from("/bundle/note.md")),
            Some("note.md".to_string())
        );
    }

    #[test]
    fn to_bundle_relative_rejects_outside_and_root_itself() {
        let root = PathBuf::from("/bundle");
        assert_eq!(to_bundle_relative(&root, &PathBuf::from("/bundle")), None);
        assert_eq!(
            to_bundle_relative(&root, &PathBuf::from("/elsewhere/x.md")),
            None
        );
    }
}
