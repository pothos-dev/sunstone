//! The `#[tauri::command]` IPC surface of the desktop shell. Every command is a
//! thin wrapper over `sunstone_native`, reading the open Bundle through the
//! managed [`Session`]. Command names are the IPC contract with the frontend —
//! do not rename them.

use std::path::PathBuf;
use std::sync::Arc;

use sunstone_native::bundle::{self, TreeNode};
use sunstone_native::config::{self, BundleState, KnownBundle};
use sunstone_native::git::{self, FileAtRev, FileHistory};
use sunstone_native::index::TagCount;
use sunstone_native::render::{self, RenderPayload};
use sunstone_native::rewrite::{self, AnchorRename, RewriteSummary};
use sunstone_native::search::{self, SearchHit};
use tauri::State;

use crate::session::Session;

/// Absolute path of the currently-open Bundle root. Errors in launcher mode (no
/// Bundle open); the frontend uses `current_bundle` when it may be either.
#[tauri::command]
pub(crate) fn bundle_root(session: State<'_, Arc<Session>>) -> Result<String, String> {
    let state = session.current()?;
    Ok(state.bundle_root.to_string_lossy().into_owned())
}

/// The currently-open Bundle root, or `None` when Sunstone launched with no path
/// and is showing the launcher. The frontend decides launcher-vs-editor from this.
#[tauri::command]
pub(crate) fn current_bundle(session: State<'_, Arc<Session>>) -> Option<String> {
    session
        .current_root()
        .map(|p| p.to_string_lossy().into_owned())
}

/// The launcher's known-folder list (previously-opened Bundles), most-recent
/// first. Purely config-derived — no open Bundle required.
#[tauri::command]
pub(crate) fn list_known_bundles() -> Vec<KnownBundle> {
    config::list_known_bundles()
}

/// Forget a known folder: drop its persisted per-Bundle config so the launcher
/// list (and the on-disk store) does not grow forever. `path` is the entry's
/// `path` (its store key).
#[tauri::command]
pub(crate) fn forget_bundle(path: String) -> Result<(), String> {
    config::forget_bundle(&path)
}

/// Open `path` as the current Bundle (from the launcher): canonicalize it, verify
/// it is a directory, then swap it in (build index, start watcher, record it,
/// restore geometry). The frontend reloads the webview afterwards so the whole
/// app re-initializes against the newly-open Bundle.
#[tauri::command]
pub(crate) fn open_bundle(session: State<'_, Arc<Session>>, path: String) -> Result<(), String> {
    let root = PathBuf::from(&path);
    let root = root.canonicalize().unwrap_or(root);
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.to_string_lossy()));
    }
    session.open(root)
}

/// Native "open folder" chooser for the launcher's "Open folder…" button. Returns
/// the chosen absolute path, or `None` if the user cancelled.
#[tauri::command]
pub(crate) async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let chosen = app.dialog().file().blocking_pick_folder();
    Ok(chosen.and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Recursive directory tree of the Bundle.
#[tauri::command]
pub(crate) fn list_tree(session: State<'_, Arc<Session>>) -> Result<TreeNode, String> {
    let state = session.current()?;
    bundle::list_tree(&state.bundle_root)
}

/// Raw markdown of a single Concept, by bundle-relative path.
#[tauri::command]
pub(crate) fn read_concept(session: State<'_, Arc<Session>>, path: String) -> Result<String, String> {
    let state = session.current()?;
    bundle::read_concept(&state.bundle_root, &path)
}

/// Write a Concept's raw markdown back to disk (autosave). Records the write in
/// the self-write tracker so the filesystem watcher suppresses its own echo.
#[tauri::command]
pub(crate) fn write_concept(session: State<'_, Arc<Session>>, path: String, content: String) -> Result<(), String> {
    let state = session.current()?;
    let resolved = bundle::write_concept(&state.bundle_root, &path, &content)?;
    state.note_self_write(resolved);
    Ok(())
}

/// Create a new, empty Concept (`.md`) at `path` (bundle-relative). The minimal
/// stub is an empty file; the rich frontmatter scaffold is a later slice. NOT
/// recorded as a self-write: a structural create SHOULD refresh the tree.
#[tauri::command]
pub(crate) fn create_concept(session: State<'_, Arc<Session>>, path: String) -> Result<(), String> {
    let state = session.current()?;
    bundle::create_concept(&state.bundle_root, &path)?;
    Ok(())
}

/// Create a new folder (and any missing parents) at `path` (bundle-relative).
#[tauri::command]
pub(crate) fn create_folder(session: State<'_, Arc<Session>>, path: String) -> Result<(), String> {
    let state = session.current()?;
    bundle::create_folder(&state.bundle_root, &path)?;
    Ok(())
}

/// Rename/move `from` to `to` (both bundle-relative). Performs the filesystem
/// rename AND automatically rewrites every link affected by the move (inbound
/// links from other Concepts, plus the moved Concept's own relative outbound
/// links — folder moves apply this to every contained Concept). Works for both
/// Concepts and folders. Returns a summary of how many links across how many
/// files were rewritten.
#[tauri::command]
pub(crate) fn rename_path(
    session: State<'_, Arc<Session>>,
    from: String,
    to: String,
) -> Result<RewriteSummary, String> {
    let state = session.current()?;
    rewrite::rename_and_rewrite(&state, &from, &to)
}

/// Move `from` into the folder `toDir` (bundle-relative; '' for the root),
/// keeping the original name, then auto-rewrite affected links. Convenience over
/// `rename_path`; returns the same rewrite summary.
#[tauri::command]
pub(crate) fn move_path(
    session: State<'_, Arc<Session>>,
    from: String,
    to_dir: String,
) -> Result<RewriteSummary, String> {
    let state = session.current()?;
    rewrite::move_into(&state, &from, &to_dir)
}

/// Delete `path` (a Concept or a folder, recursively). The frontend confirms
/// before calling this.
#[tauri::command]
pub(crate) fn delete_path(session: State<'_, Arc<Session>>, path: String) -> Result<(), String> {
    let state = session.current()?;
    bundle::delete_path(&state.bundle_root, &path)
}

/// Rewrite inbound link anchors after a heading in `target` was renamed in the
/// editor (slice: slug-anchor-rewrite). `renames` maps each changed heading's old
/// slug to its new slug; every concept linking to `target` has its matching
/// `#anchor`s rewritten. Returns a summary of how many anchors across how many
/// files changed. The target's own same-file anchors are handled in the buffer.
#[tauri::command]
pub(crate) fn rewrite_anchors(
    session: State<'_, Arc<Session>>,
    target: String,
    renames: Vec<AnchorRename>,
) -> Result<RewriteSummary, String> {
    let state = session.current()?;
    rewrite::rewrite_anchors(&state, &target, &renames)
}

/// Every Concept path in the Bundle index. The frontend seeds its synchronous
/// broken-link existence cache from this (one query instead of per-link calls).
#[tauri::command]
pub(crate) fn list_concept_paths(session: State<'_, Arc<Session>>) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.concept_paths())
}

/// Sources linking TO `path` (backlinks). Used by the backlinks panel (slice 7).
#[tauri::command]
pub(crate) fn backlinks(session: State<'_, Arc<Session>>, path: String) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.backlinks(&path))
}

/// All tags across the Bundle with per-tag counts. Used by the tags view (slice 8).
#[tauri::command]
pub(crate) fn all_tags(session: State<'_, Arc<Session>>) -> Result<Vec<TagCount>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.all_tags())
}

/// Concept paths carrying `tag`. Used by the tag browser (slice 8) to reveal
/// the Concepts under a selected tag.
#[tauri::command]
pub(crate) fn concepts_by_tag(session: State<'_, Arc<Session>>, tag: String) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.concepts_by_tag(&tag))
}

/// All distinct frontmatter `type` values. Used by new-concept autocomplete (slice 12).
#[tauri::command]
pub(crate) fn all_types(session: State<'_, Arc<Session>>) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.all_types())
}

/// All distinct top-level frontmatter keys across the Bundle. Used by the
/// Properties panel's key-name autocomplete (key-and-tag autocomplete slice);
/// the OKF recommended keys are merged in client-side.
#[tauri::command]
pub(crate) fn all_keys(session: State<'_, Arc<Session>>) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.all_keys())
}

/// Full-text (body content) search across the Bundle, on demand. Scans every
/// `.md` Concept body with the ripgrep libraries (no external binary) and
/// returns matches (path + 1-based line + matching line snippet), ordered by
/// path then line and capped server-side. Case-insensitive literal search.
#[tauri::command]
pub(crate) fn search(session: State<'_, Arc<Session>>, query: String) -> Result<Vec<SearchHit>, String> {
    let state = session.current()?;
    search::search(&state.bundle_root, &query)
}

/// Commit history (newest first) of the commits touching the bundle-relative
/// `path`, via `git log --follow`. The backend does NO diffing. Every edge
/// (not-a-repo / untracked / no-history / git-missing) comes back as a
/// distinguishable `FileHistory` variant so the review-diff toggle can disable
/// itself; only a path-escape is a hard error. Paths are bundle-relative,
/// '/'-separated.
#[tauri::command]
pub(crate) fn file_history(session: State<'_, Arc<Session>>, path: String) -> Result<FileHistory, String> {
    let state = session.current()?;
    // Reject `..`/absolute escapes the same way the other path commands do; the
    // target need not exist on disk (history can outlive the working tree).
    bundle::resolve_new(&state.bundle_root, &path)?;
    Ok(git::file_history(&state.bundle_root, &path))
}

/// Full text of the bundle-relative `path` at revision `rev`, via
/// `git show <rev>:<path>`. The working-tree side is the ordinary
/// `read_concept`; the frontend diffs the two. Edge cases surface as
/// `FileAtRev` variants (not-a-repo / not-found / git-missing) rather than
/// errors; only a path-escape is a hard error.
#[tauri::command]
pub(crate) fn file_at_rev(
    session: State<'_, Arc<Session>>,
    path: String,
    rev: String,
) -> Result<FileAtRev, String> {
    let state = session.current()?;
    bundle::resolve_new(&state.bundle_root, &path)?;
    Ok(git::file_at_rev(&state.bundle_root, &path, &rev))
}

/// Render the Concept at `path` (bundle-relative) to server-quality HTML: the
/// body rendered with CriticMarkup annotations and resolved wikilinks, plus the
/// parsed frontmatter and heading outline. Same core render the web viewer uses
/// (`sunstone_native::render`); feeds the desktop "Export as PDF" print path. Links
/// resolve against the in-memory index; the read lock is held only for the call.
#[tauri::command]
pub(crate) fn render_concept(session: State<'_, Arc<Session>>, path: String) -> Result<RenderPayload, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    render::render_concept(&state.bundle_root, &index, &path)
}

/// Load the persisted per-Bundle session state (last-open Concept, expanded
/// folders, window geometry) for the open Bundle. Robust to a missing/corrupt
/// store: returns defaults. See `config.rs` — never written into the Bundle.
#[tauri::command]
pub(crate) fn load_bundle_state(session: State<'_, Arc<Session>>) -> Result<BundleState, String> {
    let state = session.current()?;
    Ok(config::load_bundle_state(&state.bundle_root))
}

/// Persist the per-Bundle session state for the open Bundle. Merges into the
/// global store (other Bundles' entries + app config are preserved). The
/// frontend calls this (debounced) when the open Concept or expanded folders
/// change. Window geometry is owned by Rust and merged separately, so the
/// frontend's saved value here carries the window through untouched.
#[tauri::command]
pub(crate) fn save_bundle_state(session: State<'_, Arc<Session>>, bundle_state: BundleState) -> Result<(), String> {
    let state = session.current()?;
    config::save_bundle_state(&state.bundle_root, bundle_state)
}
