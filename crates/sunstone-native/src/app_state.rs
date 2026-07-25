use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};

use crate::index::Index;

/// How long after a self-write the watcher ignores echo events for that path.
/// Generous enough to cover the fs event round-trip, short enough that a genuine
/// external edit landing right after our write still reloads.
const SELF_WRITE_WINDOW: Duration = Duration::from_millis(1500);

/// Application state shared across Tauri commands.
///
/// Holds the canonicalized Bundle root plus a self-write tracker: the set of
/// absolute paths Sunstone itself just wrote, with the instant of the write.
/// The filesystem watcher consults this to suppress echo events for our own
/// autosave writes (so they never trigger a reload loop or cursor jump), while
/// still reloading on genuine external edits. See ARCHITECTURE.md.
pub struct AppState {
    /// Canonicalized absolute path of the opened Bundle root.
    pub bundle_root: PathBuf,
    /// In-memory Bundle index (frontmatter + links + reverse map), built on
    /// startup and kept current by the watcher. Behind an `RwLock`: queries
    /// (the common case) take a shared read lock; reindexing takes a write lock.
    pub index: RwLock<Index>,
    /// Absolute path -> instant of Sunstone's last write to it.
    self_writes: Mutex<HashMap<PathBuf, Instant>>,
}

impl AppState {
    pub fn new(bundle_root: PathBuf) -> Self {
        let index = Index::build(&bundle_root);
        Self {
            bundle_root,
            index: RwLock::new(index),
            self_writes: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire a shared read lock on the Bundle index, mapping a poisoned lock to
    /// the `String` error shape Tauri commands return. The common query path: an
    /// index-reading command is `Ok(state.read_index()?.some_query(...))`.
    pub fn read_index(&self) -> Result<RwLockReadGuard<'_, Index>, String> {
        self.index.read().map_err(|e| e.to_string())
    }

    /// Record that Sunstone just wrote `path` (absolute). The watcher will ignore
    /// fs events for it within `SELF_WRITE_WINDOW`.
    pub fn note_self_write(&self, path: PathBuf) {
        if let Ok(mut map) = self.self_writes.lock() {
            map.insert(path, Instant::now());
        }
    }

    /// True if `path` (absolute) was written by Sunstone within the suppression
    /// window, and prunes stale entries.
    ///
    /// The entry is kept (NOT consumed) until the window expires: a single write
    /// emits *several* fs events for one path (e.g. `Modify(Data)` then
    /// `Modify(Metadata)`, plus the git commit's own touches), so consuming on the
    /// first match would let the later events leak through as an unstamped
    /// "changed on disk" echo for our own write. The `SELF_WRITE_WINDOW` is the
    /// sole gate; a genuine external edit landing inside it is the accepted
    /// (narrow) trade-off.
    pub fn is_recent_self_write(&self, path: &Path) -> bool {
        let Ok(mut map) = self.self_writes.lock() else {
            return false;
        };
        let now = Instant::now();
        map.retain(|_, &mut t| now.duration_since(t) < SELF_WRITE_WINDOW);
        map.contains_key(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_state() -> AppState {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "sunstone-app-state-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        AppState::new(dir.canonicalize().unwrap())
    }

    #[test]
    fn recent_self_write_stays_matched_within_the_window() {
        let state = temp_state();
        let p = PathBuf::from("/bundle/a.md");
        state.note_self_write(p.clone());
        // A single write emits several fs events for one path; every one of them
        // must be recognized as ours within the window, not just the first.
        assert!(state.is_recent_self_write(&p));
        assert!(state.is_recent_self_write(&p));
        assert!(state.is_recent_self_write(&p));
    }

    #[test]
    fn unwritten_path_is_not_a_self_write() {
        let state = temp_state();
        state.note_self_write(PathBuf::from("/bundle/a.md"));
        assert!(!state.is_recent_self_write(Path::new("/bundle/other.md")));
    }
}
