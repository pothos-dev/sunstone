//! Minimal git seam: file history + file-at-revision, backed by the system
//! `git` binary via `std::process::Command` (NO git-library dependency).
//!
//! The backend stays "dumb": it exposes just enough git for the review feature
//! and does NO diffing (that is the frontend's job). Two operations:
//!   - [`file_history`] — the commits that touched a bundle-relative file,
//!     newest first (`git log --follow`).
//!   - [`file_at_rev`]  — a file's full text at a given revision
//!     (`git show <rev>:<path>`). The working-tree side is the ordinary
//!     `bundle::read_concept`.
//!
//! Every failure mode is surfaced as a distinguishable, non-panic *value* (not
//! an error) so the UI can disable its diff toggle: not a git repo, an untracked
//! file, a tracked file with no commits, or `git` missing from PATH.
//!
//! Paths crossing in are bundle-relative, '/'-separated (the seam convention).
//! Git is run with the Bundle root as its working directory, so pathspecs and
//! the `<rev>:./<path>` object syntax resolve relative to the Bundle even when
//! the Bundle is a subdirectory of a larger repository.
//!
//! Pure parsing (`parse_log`) is unit-tested; the process plumbing stays thin.

use std::path::Path;
use std::process::{Command, Output};

use serde::Serialize;

/// Field separator inside a `git log` record (ASCII Unit Separator). Chosen
/// because it never appears in a commit subject/author/date, so splitting is
/// unambiguous without shell-quoting worries.
const FIELD_SEP: char = '\x1f';

/// `--format` for one commit per line: short-hash, subject, author name,
/// author date (ISO-strict), relative author date — `FIELD_SEP`-delimited.
const LOG_FORMAT: &str = "--format=%h\x1f%s\x1f%an\x1f%ad\x1f%ar";

/// One commit touching a file. Matches the TS `FileCommit`
/// (`serde rename_all = "camelCase"`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    /// Abbreviated commit hash (`%h`).
    pub hash: String,
    /// Commit subject — the first line of the message (`%s`).
    pub subject: String,
    /// Author name (`%an`).
    pub author: String,
    /// Author date, ISO-8601 strict (`%ad` with `--date=iso-strict`).
    pub date: String,
    /// Human relative author date, e.g. "3 days ago" (`%ar`).
    pub relative_date: String,
}

/// Result of [`file_history`]. A tagged union so the UI can tell the states
/// apart. Matches the TS `FileHistory` (`serde tag = "status"`, camelCase).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FileHistory {
    /// Commits touching the file, newest first.
    Ok { commits: Vec<FileCommit> },
    /// The Bundle is not inside a git repository.
    NotARepo,
    /// The file is not tracked by git (no history to show).
    Untracked,
    /// The file is tracked but no commit touches it (e.g. staged, never
    /// committed) — distinct from `Untracked`.
    NoHistory,
    /// The `git` binary is not available (not on PATH / not launchable).
    GitMissing,
}

/// Result of [`file_at_rev`]. Matches the TS `FileAtRev`
/// (`serde tag = "status"`, camelCase).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FileAtRev {
    /// The file's full text at the requested revision.
    Ok { content: String },
    /// The Bundle is not inside a git repository.
    NotARepo,
    /// The revision or the path at that revision does not exist.
    NotFound,
    /// The `git` binary is not available (not on PATH / not launchable).
    GitMissing,
}

/// Ordered commit history (newest first) of the commits touching `rel_path`,
/// via `git log --follow`. Returns a distinguishable value for every edge
/// (not-a-repo / untracked / no-history / git-missing) rather than erroring.
pub fn file_history(root: &Path, rel_path: &str) -> FileHistory {
    let output = match run_git(
        root,
        &[
            "log",
            "--follow",
            LOG_FORMAT,
            "--date=iso-strict",
            "--",
            rel_path,
        ],
    ) {
        Some(o) => o,
        None => return FileHistory::GitMissing,
    };

    if is_not_a_repo(&output.stderr) {
        return FileHistory::NotARepo;
    }

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let commits = parse_log(&stdout);
        if !commits.is_empty() {
            return FileHistory::Ok { commits };
        }
    }
    // Either an empty log (zero exit, no commits touch the file) or another
    // non-zero exit — e.g. an empty repo with no HEAD yet, or a bad pathspec.
    // In all these cases there is no history; distinguish an untracked file
    // from a tracked-but-uncommitted one with `ls-files`.
    match run_git(root, &["ls-files", "--error-unmatch", "--", rel_path]) {
        Some(o) if is_not_a_repo(&o.stderr) => FileHistory::NotARepo,
        Some(o) if o.status.success() => FileHistory::NoHistory,
        Some(_) => FileHistory::Untracked,
        None => FileHistory::GitMissing,
    }
}

/// Full text of `rel_path` at `rev` via `git show <rev>:./<path>`. The `./`
/// makes the path cwd-relative, so it resolves against the Bundle root even
/// when the Bundle is a subdirectory of the repository.
pub fn file_at_rev(root: &Path, rel_path: &str, rev: &str) -> FileAtRev {
    let spec = format!("{rev}:./{rel_path}");
    let output = match run_git(root, &["show", &spec]) {
        Some(o) => o,
        None => return FileAtRev::GitMissing,
    };

    if output.status.success() {
        return FileAtRev::Ok {
            content: String::from_utf8_lossy(&output.stdout).into_owned(),
        };
    }
    if is_not_a_repo(&output.stderr) {
        return FileAtRev::NotARepo;
    }
    // Unknown rev, or path absent at that rev.
    FileAtRev::NotFound
}

// --- Commit path (web write) ------------------------------------------------
//
// The desktop never commits (it writes files and lets the user's own git
// workflow handle history); the web `sunstone-server` is the sole committer.
// These primitives live here — beside `file_history` / `file_at_rev` — because
// they must reuse `run_git`'s cwd=Bundle-root plumbing. Orchestration (the
// global write lock, sequencing, self-write bookkeeping) lives in the server.

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
    if output.status.success() {
        Ok(())
    } else {
        Err(git_err("commit", &output))
    }
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
    if output.status.success() {
        Ok(())
    } else {
        Err(git_err("amend", &output))
    }
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
    if output.status.success() {
        Ok(())
    } else {
        Err(git_err("add", &output))
    }
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

/// Format a non-zero git invocation into an error string (trimmed stderr).
fn git_err(op: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("git {op} failed: {}", stderr.trim())
}

/// Like [`run_git`] but with extra environment variables set on the child (used
/// to carry the commit identity without touching the repo config).
fn run_git_env(root: &Path, args: &[&str], env: &[(&str, &str)]) -> Option<Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.output().ok()
}

/// Parse the `git log` output produced by [`LOG_FORMAT`] into commits (in the
/// order git emitted them — newest first). Records are newline-separated; each
/// record's fields are [`FIELD_SEP`]-separated. Blank lines and records with
/// too few fields (or an empty hash) are skipped, so partial/garbage output
/// never panics.
pub fn parse_log(stdout: &str) -> Vec<FileCommit> {
    stdout.lines().filter_map(parse_log_line).collect()
}

/// Parse a single `git log` line into a [`FileCommit`], or `None` if it is not
/// a well-formed record.
fn parse_log_line(line: &str) -> Option<FileCommit> {
    if line.is_empty() {
        return None;
    }
    let mut parts = line.split(FIELD_SEP);
    let hash = parts.next()?.to_string();
    let subject = parts.next()?.to_string();
    let author = parts.next()?.to_string();
    let date = parts.next()?.to_string();
    let relative_date = parts.next()?.to_string();
    if hash.is_empty() {
        return None;
    }
    Some(FileCommit {
        hash,
        subject,
        author,
        date,
        relative_date,
    })
}

/// Run `git <args>` with the Bundle root as the working directory. Returns the
/// captured [`Output`], or `None` if `git` could not be launched at all (not on
/// PATH, or otherwise unspawnable — surfaced upstream as `GitMissing`).
fn run_git(root: &Path, args: &[&str]) -> Option<Output> {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .ok()
}

/// Whether git's stderr indicates the directory is outside any repository.
fn is_not_a_repo(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr).contains("not a git repository")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn line(hash: &str, subject: &str, author: &str, date: &str, rel: &str) -> String {
        format!("{hash}\x1f{subject}\x1f{author}\x1f{date}\x1f{rel}")
    }

    #[test]
    fn parses_multiple_commits_in_order() {
        let stdout = [
            line(
                "a1b2c3d",
                "Fix the parser",
                "Ada Lovelace",
                "2026-07-19T10:00:00+00:00",
                "yesterday",
            ),
            line(
                "0f1e2d3",
                "Initial commit",
                "Grace Hopper",
                "2026-07-01T09:00:00+00:00",
                "3 weeks ago",
            ),
        ]
        .join("\n");

        let commits = parse_log(&stdout);
        assert_eq!(commits.len(), 2);
        assert_eq!(
            commits[0],
            FileCommit {
                hash: "a1b2c3d".into(),
                subject: "Fix the parser".into(),
                author: "Ada Lovelace".into(),
                date: "2026-07-19T10:00:00+00:00".into(),
                relative_date: "yesterday".into(),
            }
        );
        assert_eq!(commits[1].hash, "0f1e2d3");
        assert_eq!(commits[1].author, "Grace Hopper");
        assert_eq!(commits[1].relative_date, "3 weeks ago");
    }

    #[test]
    fn empty_output_yields_no_commits() {
        assert!(parse_log("").is_empty());
        assert!(parse_log("\n\n").is_empty());
    }

    #[test]
    fn skips_malformed_records_and_empty_hash() {
        let stdout = [
            "not enough fields".to_string(),
            line("", "no hash", "A", "d", "r"),
            line("abc1234", "good", "Author Name", "2026-01-01T00:00:00+00:00", "6 months ago"),
        ]
        .join("\n");

        let commits = parse_log(&stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abc1234");
        assert_eq!(commits[0].subject, "good");
    }

    #[test]
    fn preserves_subject_with_inner_spaces_and_punctuation() {
        // Only the field separator splits fields; spaces/colons in the subject
        // are preserved verbatim.
        let stdout = line(
            "deadbee",
            "feat: add thing (with: colons) and, commas",
            "Some One",
            "2026-05-05T12:34:56+02:00",
            "2 months ago",
        );
        let commits = parse_log(&stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "feat: add thing (with: colons) and, commas");
    }

    // --- Live-git tests, skipped when `git` is unavailable so the suite stays
    // green in a git-less sandbox. ------------------------------------------

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("sunstone-git-{tag}-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?} failed: {status:?}");
    }

    fn init_repo(root: &Path) {
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "user.name", "Test User"]);
        // Deterministic dates so relative-date parsing has something stable.
        git(root, &["config", "commit.gpgsign", "false"]);
    }

    #[test]
    fn not_a_repo_is_reported() {
        if !git_available() {
            return;
        }
        let root = temp_dir("norepo");
        std::fs::write(root.join("a.md"), "hi").unwrap();
        assert_eq!(file_history(&root, "a.md"), FileHistory::NotARepo);
        assert_eq!(file_at_rev(&root, "a.md", "HEAD"), FileAtRev::NotARepo);
    }

    #[test]
    fn untracked_and_history_are_distinguished() {
        if !git_available() {
            return;
        }
        let root = temp_dir("history");
        init_repo(&root);

        // Untracked file (exists on disk, never added).
        std::fs::write(root.join("untracked.md"), "draft").unwrap();
        assert_eq!(file_history(&root, "untracked.md"), FileHistory::Untracked);

        // Committed file has history.
        std::fs::write(root.join("tracked.md"), "v1\n").unwrap();
        git(&root, &["add", "tracked.md"]);
        git(&root, &["commit", "-q", "-m", "add tracked"]);
        std::fs::write(root.join("tracked.md"), "v2\n").unwrap();
        git(&root, &["add", "tracked.md"]);
        git(&root, &["commit", "-q", "-m", "update tracked"]);

        match file_history(&root, "tracked.md") {
            FileHistory::Ok { commits } => {
                assert_eq!(commits.len(), 2);
                // Newest first.
                assert_eq!(commits[0].subject, "update tracked");
                assert_eq!(commits[1].subject, "add tracked");
                assert_eq!(commits[0].author, "Test User");
                assert!(!commits[0].hash.is_empty());
                assert!(!commits[0].relative_date.is_empty());
            }
            other => panic!("expected Ok history, got {other:?}"),
        }
    }

    #[test]
    fn file_at_rev_reads_old_content_and_reports_missing() {
        if !git_available() {
            return;
        }
        let root = temp_dir("atrev");
        init_repo(&root);
        std::fs::write(root.join("f.md"), "first\n").unwrap();
        git(&root, &["add", "f.md"]);
        git(&root, &["commit", "-q", "-m", "first"]);
        std::fs::write(root.join("f.md"), "second\n").unwrap();
        git(&root, &["add", "f.md"]);
        git(&root, &["commit", "-q", "-m", "second"]);

        // Grab the first commit's hash from history (newest-first, so last).
        let hashes = match file_history(&root, "f.md") {
            FileHistory::Ok { commits } => commits,
            other => panic!("expected history, got {other:?}"),
        };
        let first = &hashes[1].hash;
        assert_eq!(
            file_at_rev(&root, "f.md", first),
            FileAtRev::Ok {
                content: "first\n".into()
            }
        );
        assert_eq!(
            file_at_rev(&root, "f.md", "HEAD"),
            FileAtRev::Ok {
                content: "second\n".into()
            }
        );
        // Unknown path at a valid rev -> NotFound.
        assert_eq!(file_at_rev(&root, "nope.md", "HEAD"), FileAtRev::NotFound);
    }

    // --- Commit path (web write) --------------------------------------------

    fn ident(name: &str, email: &str) -> CommitIdentity {
        CommitIdentity {
            name: name.to_string(),
            email: email.to_string(),
        }
    }

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
