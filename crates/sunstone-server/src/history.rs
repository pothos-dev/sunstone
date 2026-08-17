//! Web git history routes (Spec 2 §11): `GET /api/history` and
//! `GET /api/file-at-rev`, both behind the existing [`AuthedUser`] extractor.
//!
//! `sunstone_native::git`'s `file_history` / `file_at_rev` are reused
//! **verbatim** — their outcomes map 1:1 onto the seam's statuses, so these
//! handlers add no mapping logic, with one deliberate exception (§11.1):
//!
//! | Condition | Status | Source |
//! | --- | --- | --- |
//! | **plain** shape | `notARepo` | **short-circuit here — git is never spawned** |
//! | not a repo | `notARepo` | `git.rs` |
//! | path never tracked | `untracked` | `git.rs` |
//! | tracked, no commits | `noHistory` | `git.rs` |
//! | `git` not on PATH | `gitMissing` | `git.rs` |
//!
//! The **short-circuit is load-bearing**: without it a plain-shape bundle
//! bind-mounted *inside* a host git repo would let git's upward repo discovery
//! serve **that** repo's history over HTTP. It is also the read-side half of the
//! locked rule that the plain shape runs **no git at all**, whose write-side
//! half is §5.
//!
//! # Gated, not public
//!
//! `fileAtRev` returns the full text of any path at any revision: unguarded,
//! every version of every file ever committed — including content deliberately
//! **deleted** from the bundle — becomes readable by an anonymous visitor. Both
//! routes are gated together because the history listing is the index that makes
//! those revisions enumerable.
//!
//! The gate **is** the write gate (authenticated == authorized), so
//! `SUNSTONE_JWT_SECRET` unset ⇒ no history. Correct by construction: with no
//! auth provider wired there is no way to tell a viewer from a visitor. The
//! frontend maps **401/503 → `{ status: 'gitMissing' }`**, keeping the seam's
//! contract ("only a path-escape rejects") true on the web — not-signed-in is an
//! *unavailable capability*, not an error the review-diff UI must handle.
//!
//! # Boundary details (§11.2)
//!
//! - Reuse the existing path guard ([`crate::guard_rel_path`]): absolute or `..`
//!   ⇒ **400**. The one case the seam permits rejecting.
//! - `rev` passes through **opaquely**; git is invoked via `Command::args` (no
//!   shell), so there is no quoting concern. An unresolvable rev falls out as
//!   `notFound`.
//! - **Subfolder bundles need no work**: `run_git` sets
//!   `current_dir(bundle_root)` and the pathspec is relative to it, so
//!   `git log -- foo.md` under `/srv/repo/docs` resolves correctly and cannot see
//!   above the Bundle by path.
//! - **`--follow` is kept.** Ticket 07's `-Xno-renames` is a *merge-strategy*
//!   option governing conflict resolution; `--follow` is a *log* option
//!   governing presentation. Independent, and neither implies the other.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use sunstone_native::git::{self, FileAtRev, FileHistory};

use crate::auth::AuthedUser;
use crate::{ApiError, ServerState};

/// `?path=` — bundle-relative, forward-slash.
#[derive(Deserialize)]
pub struct HistoryQuery {
    pub path: String,
}

/// `?path=&rev=` — `rev` is opaque and handed to git unparsed.
#[derive(Deserialize)]
pub struct FileAtRevQuery {
    pub path: String,
    pub rev: String,
}

/// `GET /api/history?path=` → [`FileHistory`].
///
/// `AuthedUser` in the signature is the proof this route is gated (§11). In the
/// plain shape it returns [`FileHistory::NotARepo`] **without spawning git**.
pub async fn history_handler(
    State(state): State<Arc<ServerState>>,
    _user: AuthedUser,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<FileHistory>, ApiError> {
    // The one rejection the seam permits (§11.2).
    crate::guard_rel_path(&q.path)?;
    // §11.1: the plain shape answers WITHOUT spawning git — otherwise git's
    // upward repo discovery would serve a *host* repo containing the bundle.
    if !state.cfg.is_git() {
        return Ok(Json(FileHistory::NotARepo));
    }
    // Every other status is `git.rs`'s own outcome, verbatim — no mapping.
    Ok(Json(git::file_history(&state.app.bundle_root, &q.path)))
}

/// `GET /api/file-at-rev?path=&rev=` → [`FileAtRev`].
///
/// Same gate and same plain-shape short-circuit ([`FileAtRev::NotARepo`]) as
/// [`history_handler`].
pub async fn file_at_rev_handler(
    State(state): State<Arc<ServerState>>,
    _user: AuthedUser,
    Query(q): Query<FileAtRevQuery>,
) -> Result<Json<FileAtRev>, ApiError> {
    crate::guard_rel_path(&q.path)?;
    if !state.cfg.is_git() {
        return Ok(Json(FileAtRev::NotARepo));
    }
    // `rev` is handed to git unparsed (`Command::args`, no shell): an
    // unresolvable rev falls out of `git.rs` as `NotFound` (§11.2).
    Ok(Json(git::file_at_rev(
        &state.app.bundle_root,
        &q.path,
        &q.rev,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use axum::http::StatusCode;
    use sunstone_native::app_state::AppState;
    use tokio::sync::broadcast;

    use crate::config::{Config, Shape};
    use crate::sync::SyncState;
    use crate::{ServerEvent, ServerState};

    use crate::testutil::{git as run, git_available, temp_dir};

    /// A git repo with `a.md` committed, plus `sub/b.md` committed one level
    /// down (the bind-mounted-subdirectory case).
    fn temp_repo() -> PathBuf {
        let dir = temp_dir("repo");
        run(&dir, &["init", "-q"]);
        run(&dir, &["config", "user.email", "seed@example.com"]);
        run(&dir, &["config", "user.name", "Seed"]);
        run(&dir, &["config", "commit.gpgsign", "false"]);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.md"), "# A\n").unwrap();
        std::fs::write(dir.join("sub/b.md"), "# B\n").unwrap();
        run(&dir, &["add", "-A"]);
        run(&dir, &["commit", "-q", "-m", "seed"]);
        dir
    }

    fn state(shape: Shape, bundle_root: PathBuf) -> Arc<ServerState> {
        let mut cfg = Config::plain(bundle_root.clone());
        cfg.shape = shape;
        let (events, _) = broadcast::channel::<ServerEvent>(8);
        Arc::new(ServerState {
            app: Arc::new(AppState::new(bundle_root)),
            events,
            write_lock: Mutex::new(()),
            // Set, so the gate that matters in these tests is the SHAPE — the
            // auth gate is proven by `AuthedUser` being in the signature.
            jwt_secret: Some(b"test-secret".to_vec()),
            cfg,
            sync: SyncState::new(),
        })
    }

    fn user() -> AuthedUser {
        AuthedUser {
            name: "Ada Lovelace".into(),
            email: "ada@example.com".into(),
        }
    }

    async fn history(state: &Arc<ServerState>, path: &str) -> Result<FileHistory, StatusCode> {
        history_handler(
            State(state.clone()),
            user(),
            Query(HistoryQuery { path: path.into() }),
        )
        .await
        .map(|Json(h)| h)
        .map_err(|e| e.0)
    }

    async fn at_rev(
        state: &Arc<ServerState>,
        path: &str,
        rev: &str,
    ) -> Result<FileAtRev, StatusCode> {
        file_at_rev_handler(
            State(state.clone()),
            user(),
            Query(FileAtRevQuery {
                path: path.into(),
                rev: rev.into(),
            }),
        )
        .await
        .map(|Json(f)| f)
        .map_err(|e| e.0)
    }

    /// §11.1's load-bearing short-circuit. The bundle root IS a git repo with a
    /// committed `a.md` — git, if spawned, would answer `Ok`. The plain shape
    /// must still say `notARepo`, which is only possible if git was never run.
    #[tokio::test]
    async fn plain_shape_says_not_a_repo_even_when_the_bundle_is_a_repo() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        // Proof that the *only* thing producing `notARepo` below is the
        // short-circuit: git itself has real history for this path.
        assert!(matches!(
            git::file_history(&root, "a.md"),
            FileHistory::Ok { .. }
        ));

        let plain = state(Shape::Plain, root.clone());
        assert_eq!(history(&plain, "a.md").await.unwrap(), FileHistory::NotARepo);
        assert_eq!(
            at_rev(&plain, "a.md", "HEAD").await.unwrap(),
            FileAtRev::NotARepo
        );
    }

    /// The exact deployment §11.1 protects: a plain-shape bundle bind-mounted
    /// *inside* a host git repo. Git's upward discovery would serve THAT repo's
    /// history; the short-circuit means it is never asked.
    #[tokio::test]
    async fn plain_shape_never_serves_a_host_repo_containing_the_bundle() {
        if !git_available() {
            return;
        }
        let repo = temp_repo();
        let bundle = repo.join("sub");
        // The host repo really does hold history for this bundle-relative path.
        assert!(matches!(
            git::file_history(&bundle, "b.md"),
            FileHistory::Ok { .. }
        ));

        let plain = state(Shape::Plain, bundle);
        assert_eq!(history(&plain, "b.md").await.unwrap(), FileHistory::NotARepo);
        assert_eq!(
            at_rev(&plain, "b.md", "HEAD").await.unwrap(),
            FileAtRev::NotARepo
        );
    }

    /// A git shape passes `git.rs`'s outcomes through untouched: `Ok` for a
    /// committed path, `untracked` for an unknown one, `noHistory` for a staged
    /// but never-committed one, `notARepo` when the bundle is no repo at all.
    #[tokio::test]
    async fn git_shape_reports_each_git_backed_status() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        let git_local = state(Shape::GitLocal, root.clone());

        // Ok — a committed Concept.
        let FileHistory::Ok { commits } = history(&git_local, "a.md").await.unwrap() else {
            panic!("expected Ok history for a committed path");
        };
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "seed");

        // untracked — the file exists but git has never seen it.
        std::fs::write(root.join("loose.md"), "x\n").unwrap();
        assert_eq!(
            history(&git_local, "loose.md").await.unwrap(),
            FileHistory::Untracked
        );

        // noHistory — staged, so tracked, but no commit touches it yet.
        run(&root, &["add", "loose.md"]);
        assert_eq!(
            history(&git_local, "loose.md").await.unwrap(),
            FileHistory::NoHistory
        );

        // notARepo — a git shape over a directory that is not a repository.
        let bare = temp_dir("plainfs");
        std::fs::write(bare.join("a.md"), "# A\n").unwrap();
        let orphan = state(Shape::GitSynced, bare);
        assert_eq!(history(&orphan, "a.md").await.unwrap(), FileHistory::NotARepo);
    }

    /// The handlers add **no** mapping beyond the short-circuit: in a git shape
    /// their body is `git.rs`'s value verbatim. That is also why `gitMissing`
    /// needs no arm of its own — it is whatever `git.rs` returns when `git`
    /// cannot be launched (unreachable in-process without mutating `PATH`, which
    /// `cargo test`'s threads make unsafe).
    #[tokio::test]
    async fn git_shape_returns_git_rs_outcomes_verbatim() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        let git_local = state(Shape::GitLocal, root.clone());
        for path in ["a.md", "sub/b.md", "missing.md"] {
            assert_eq!(
                history(&git_local, path).await.unwrap(),
                git::file_history(&root, path),
                "history({path}) must be git.rs's own outcome"
            );
            assert_eq!(
                at_rev(&git_local, path, "HEAD").await.unwrap(),
                git::file_at_rev(&root, path, "HEAD"),
                "file_at_rev({path}) must be git.rs's own outcome"
            );
        }
    }

    /// `rev` is opaque (§11.2): it reaches git through `Command::args`, so an
    /// unresolvable — or shell-flavoured — rev is simply `notFound`, never an
    /// error and never interpreted.
    #[tokio::test]
    async fn file_at_rev_reads_content_and_reports_not_found_for_a_bad_rev() {
        if !git_available() {
            return;
        }
        let git_local = state(Shape::GitLocal, temp_repo());
        assert_eq!(
            at_rev(&git_local, "a.md", "HEAD").await.unwrap(),
            FileAtRev::Ok {
                content: "# A\n".to_string()
            }
        );
        assert_eq!(
            at_rev(&git_local, "a.md", "no-such-rev").await.unwrap(),
            FileAtRev::NotFound
        );
        // A shell metacharacter cannot bite (we use `Command::args`, never a
        // shell), so this only pins that the rev stays opaque rather than parsed.
        assert_eq!(
            at_rev(&git_local, "a.md", "HEAD; rm -rf /").await.unwrap(),
            FileAtRev::NotFound
        );

        // The case that *can* bite: `<rev>:./<path>` is one token in argv
        // position and `git show` accepts options there, `--output=<file>`
        // included — which opens a file for WRITING. Rejected at the git.rs
        // boundary, so it never reaches argv.
        let target = git_local.cfg.bundle_root.join("pwned");
        for bad in [
            "--output=pwned",
            "--output=/tmp/sunstone-history-pwned",
            "-o",
        ] {
            assert_eq!(
                at_rev(&git_local, "a.md", bad).await.unwrap(),
                FileAtRev::NotFound,
                "an option-shaped rev must not reach git: {bad}"
            );
        }
        assert!(!target.exists(), "no file was created by an option-shaped rev");
        assert!(!std::path::Path::new("/tmp/sunstone-history-pwned").exists());
    }

    /// §11.2's one permitted rejection — and it fires *before* the shape is even
    /// consulted, so it holds in every shape.
    #[tokio::test]
    async fn path_escape_is_400_in_every_shape() {
        let root = temp_dir("escape");
        for shape in [Shape::Plain, Shape::GitLocal, Shape::GitSynced] {
            let st = state(shape, root.clone());
            for bad in ["../secret.md", "/etc/passwd", "a/../../x.md"] {
                assert_eq!(
                    history(&st, bad).await.unwrap_err(),
                    StatusCode::BAD_REQUEST,
                    "history({bad}) in {shape:?}"
                );
                assert_eq!(
                    at_rev(&st, bad, "HEAD").await.unwrap_err(),
                    StatusCode::BAD_REQUEST,
                    "file_at_rev({bad}) in {shape:?}"
                );
            }
        }
    }
}
