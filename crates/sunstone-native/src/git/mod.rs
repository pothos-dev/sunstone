//! The git seam: every git operation Sunstone performs, backed by the system
//! `git` binary via `std::process::Command` (NO git-library dependency).
//!
//! It began as read-only history for the review feature and has grown the web
//! server's write path: commit/amend, fetch/rebase/push, and conflict
//! resolution. The backend still does NO diffing (that is the frontend's job).
//!
//! Paths crossing in are bundle-relative, '/'-separated (the seam convention).
//! Git is run with the Bundle root as its working directory, so pathspecs and
//! the `<rev>:./<path>` object syntax resolve relative to the Bundle even when
//! the Bundle is a subdirectory of a larger repository.
//!
//! Pure parsing (`parse_log`) is unit-tested; the process plumbing stays thin.
//!
//! Submodules, split by concern (mechanical split, no behavior change):
//!   - [`history`]: read-only history (`file_history`, `file_at_rev`, …).
//!   - [`commit`]: the commit/amend/stage write path used by the web server.
//!   - [`env`]: process-global git environment injection (Spec 2 §3).
//!   - [`sync`]: fetch/rebase/push/conflict-resolution primitives (Spec 2 §7-9).
//!   - [`internal`]: shared process-plumbing helpers used by all of the above.
//!
//! Everything public is re-exported here, so external callers keep using
//! `sunstone_native::git::<name>` unchanged.

mod commit;
mod env;
mod history;
mod internal;
mod sync;

pub use commit::{amend, commit, head_commit, CommitIdentity, HeadCommit};
pub use env::{configure, GitEnv};
pub use history::{file_at_rev, file_history, parse_log, FileAtRev, FileCommit, FileHistory};
pub use sync::{
    add_paths, anything_staged, checkout_ours, clone, current_branch, diff_name_status, fetch,
    init, is_push_rejected, is_repo, push, rebase_abort, rebase_continue, rebase_head_timestamp,
    rebase_onto, rebase_skip, remote_url, rev_list_count, rm_path, stage_entry, unmerged_paths,
    RebaseOutcome,
};

/// Test-only harness shared across the git submodules' `#[cfg(test)]` suites:
/// spinning up a scratch repo, running raw `git` commands to set up fixtures,
/// and building a [`CommitIdentity`]. Kept in one place so it is not duplicated
/// per submodule.
#[cfg(test)]
mod test_support {
    use super::CommitIdentity;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    pub(crate) fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("sunstone-git-{tag}-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    pub(crate) fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?} failed: {status:?}");
    }

    pub(crate) fn init_repo(root: &Path) {
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "user.name", "Test User"]);
        // Deterministic dates so relative-date parsing has something stable.
        git(root, &["config", "commit.gpgsign", "false"]);
    }

    pub(crate) fn ident(name: &str, email: &str) -> CommitIdentity {
        CommitIdentity {
            name: name.to_string(),
            email: email.to_string(),
        }
    }
}
