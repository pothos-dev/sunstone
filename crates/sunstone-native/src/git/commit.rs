//! Commit path (web write).
//!
//! The desktop never commits (it writes files and lets the user's own git
//! workflow handle history); the web `sunstone-server` is the sole committer.
//! These primitives reuse `run_git`'s cwd=Bundle-root plumbing from
//! [`super::internal`]. Orchestration (the global write lock, sequencing,
//! self-write bookkeeping) lives in the server.

use std::path::Path;

use super::history::FIELD_SEP;
use super::internal::{run_git, run_git_env, unit};

/// The author + committer identity for a commit (the authenticated OIDC user;
/// per tickets 04/05, author == committer). Set via `GIT_*` env so the commit
/// is independent of any repo-level `user.name`/`user.email`.
#[derive(Debug, Clone)]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}

/// HEAD's subject + author identity, read for the amend-else-fresh anchor-commit
/// decision (ticket 07 §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadCommit {
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
}

/// Stage `paths` (bundle-relative) and create a commit with `msg`, authored and
/// committed by `identity`. Uses `git add -A --` so staged deletions (from a
/// delete op) are included. Returns `Err` on any git failure (not a repo,
/// nothing staged, git missing) — the server maps these to a 500.
pub fn commit(
    root: &Path,
    paths: &[&str],
    msg: &str,
    identity: &CommitIdentity,
) -> Result<(), String> {
    stage(root, paths)?;
    let env = identity_env(identity);
    let output = run_git_env(root, &["commit", "-m", msg], &env)
        .ok_or_else(|| "git is not available".to_string())?;
    unit("commit", output)
}

/// Stage `paths` and amend HEAD (`git commit --amend --no-edit`), preserving the
/// original author + author-date; only the tree and committer-date move. Used
/// to fold anchor-relink writes into the preceding `edit … via web` commit
/// (ticket 07 §5). Safe because push is out of scope — amend only rewrites the
/// tip of local, unshared history.
pub fn amend(root: &Path, paths: &[&str], identity: &CommitIdentity) -> Result<(), String> {
    stage(root, paths)?;
    let env = identity_env(identity);
    let output = run_git_env(root, &["commit", "--amend", "--no-edit"], &env)
        .ok_or_else(|| "git is not available".to_string())?;
    unit("amend", output)
}

/// Read HEAD's subject + author name/email, or `None` when there is no HEAD
/// (empty repo), the Bundle is not a repo, or `git` is missing. Feeds the
/// amend-else-fresh decision: the caller only amends when the subject + author
/// match the write it is about to fold in.
pub fn head_commit(root: &Path) -> Option<HeadCommit> {
    let format = format!("--format=%s{FIELD_SEP}%an{FIELD_SEP}%ae");
    let output = run_git(root, &["log", "-1", &format])?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()?;
    let mut parts = line.split(FIELD_SEP);
    let subject = parts.next()?.to_string();
    let author_name = parts.next()?.to_string();
    let author_email = parts.next()?.to_string();
    Some(HeadCommit {
        subject,
        author_name,
        author_email,
    })
}

/// Stage `paths` with `git add -A --` (so deletions stage too). Empty `paths`
/// stages nothing (a no-op add succeeds).
fn stage(root: &Path, paths: &[&str]) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(paths.iter().copied());
    let output = run_git(root, &args).ok_or_else(|| "git is not available".to_string())?;
    unit("add", output)
}

/// The four `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env pairs for `identity`, so the
/// commit's author == committer == the authenticated user and no repo-level
/// `user.*` config is consulted.
fn identity_env(identity: &CommitIdentity) -> [(&'static str, &str); 4] {
    [
        ("GIT_AUTHOR_NAME", identity.name.as_str()),
        ("GIT_AUTHOR_EMAIL", identity.email.as_str()),
        ("GIT_COMMITTER_NAME", identity.name.as_str()),
        ("GIT_COMMITTER_EMAIL", identity.email.as_str()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::history::{file_at_rev, file_history, FileAtRev, FileHistory};
    use crate::git::test_support::{git_available, ident, init_repo, temp_dir};

    #[test]
    fn commit_creates_a_commit_with_message_and_identity() {
        if !git_available() {
            return;
        }
        let root = temp_dir("commit");
        init_repo(&root);
        std::fs::write(root.join("a.md"), "hello\n").unwrap();

        commit(
            &root,
            &["a.md"],
            "edit a.md via web",
            &ident("Ada Lovelace", "ada@example.com"),
        )
        .unwrap();

        match file_history(&root, "a.md") {
            FileHistory::Ok { commits } => {
                assert_eq!(commits.len(), 1);
                assert_eq!(commits[0].subject, "edit a.md via web");
                // Author name comes from the identity, not the repo config.
                assert_eq!(commits[0].author, "Ada Lovelace");
            }
            other => panic!("expected history, got {other:?}"),
        }
        // Author AND committer are the identity (independent of repo user.*).
        let head = head_commit(&root).unwrap();
        assert_eq!(head.author_name, "Ada Lovelace");
        assert_eq!(head.author_email, "ada@example.com");
    }

    #[test]
    fn commit_stages_a_deletion() {
        if !git_available() {
            return;
        }
        let root = temp_dir("commit-del");
        init_repo(&root);
        std::fs::write(root.join("a.md"), "hello\n").unwrap();
        commit(&root, &["a.md"], "create a.md via web", &ident("A", "a@x.io")).unwrap();

        std::fs::remove_file(root.join("a.md")).unwrap();
        // `git add -A --` stages the deletion so the commit records it.
        commit(&root, &["a.md"], "delete a.md via web", &ident("A", "a@x.io")).unwrap();

        // The file is gone from HEAD.
        assert_eq!(file_at_rev(&root, "a.md", "HEAD"), FileAtRev::NotFound);
        let head = head_commit(&root).unwrap();
        assert_eq!(head.subject, "delete a.md via web");
    }

    #[test]
    fn head_commit_reads_subject_and_author_none_when_empty() {
        if !git_available() {
            return;
        }
        let root = temp_dir("head");
        init_repo(&root);
        // Empty repo: no HEAD yet.
        assert_eq!(head_commit(&root), None);

        std::fs::write(root.join("a.md"), "x\n").unwrap();
        commit(&root, &["a.md"], "edit a.md via web", &ident("Grace", "g@x.io")).unwrap();
        let head = head_commit(&root).unwrap();
        assert_eq!(head.subject, "edit a.md via web");
        assert_eq!(head.author_name, "Grace");
        assert_eq!(head.author_email, "g@x.io");
    }

    #[test]
    fn amend_folds_into_head_preserving_author() {
        if !git_available() {
            return;
        }
        let root = temp_dir("amend");
        init_repo(&root);
        std::fs::write(root.join("a.md"), "v1\n").unwrap();
        commit(&root, &["a.md"], "edit a.md via web", &ident("Ada", "ada@x.io")).unwrap();

        // A second file "relinked", amended into the same commit under a
        // DIFFERENT committer identity — author is preserved, no new commit.
        std::fs::write(root.join("b.md"), "link\n").unwrap();
        amend(&root, &["b.md"], &ident("Bob", "bob@x.io")).unwrap();

        match file_history(&root, "a.md") {
            FileHistory::Ok { commits } => assert_eq!(commits.len(), 1, "amend must not add a commit"),
            other => panic!("expected history, got {other:?}"),
        }
        let head = head_commit(&root).unwrap();
        assert_eq!(head.subject, "edit a.md via web");
        // Author preserved from the original commit (amend --no-edit).
        assert_eq!(head.author_name, "Ada");
        assert_eq!(head.author_email, "ada@x.io");
        // b.md is now part of that one commit.
        assert!(matches!(file_at_rev(&root, "b.md", "HEAD"), FileAtRev::Ok { .. }));
    }

    #[test]
    fn commit_on_non_repo_errors() {
        if !git_available() {
            return;
        }
        let root = temp_dir("commit-norepo");
        std::fs::write(root.join("a.md"), "x\n").unwrap();
        assert!(commit(&root, &["a.md"], "edit a.md via web", &ident("A", "a@x.io")).is_err());
    }
}
