//! Read-only history: file history + file-at-revision, backed by the system
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

use serde::Serialize;

use super::internal::{is_not_a_repo, run_git};

/// Field separator inside a `git log` record (ASCII Unit Separator). Chosen
/// because it never appears in a commit subject/author/date, so splitting is
/// unambiguous without shell-quoting worries.
pub(super) const FIELD_SEP: char = '\x1f';

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
///
/// `rev` stays **opaque** — we never parse or rewrite it — with one boundary
/// guard: a `rev` starting with `-` is rejected as [`FileAtRev::NotFound`].
///
/// Spec 2 §11.2 rules out *shell* injection (we use `Command::args`, so no shell
/// is ever involved) but that argument does not cover **argument** injection:
/// `<rev>:./<path>` is one token in argv position, and `git show` accepts
/// options there — `--output=<file>` among them, which makes git open a file for
/// **writing**. A `--` separator cannot help, because after it git would read
/// the object spec as a pathspec. Since no legitimate rev begins with `-`, and
/// §11.1 already says an unresolvable rev falls out as `notFound`, rejecting the
/// leading dash closes the hole without making `rev` any less opaque.
pub fn file_at_rev(root: &Path, rel_path: &str, rev: &str) -> FileAtRev {
    if rev.starts_with('-') {
        return FileAtRev::NotFound;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{git_available, init_repo, temp_dir};

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
        crate::git::test_support::git(&root, &["add", "tracked.md"]);
        crate::git::test_support::git(&root, &["commit", "-q", "-m", "add tracked"]);
        std::fs::write(root.join("tracked.md"), "v2\n").unwrap();
        crate::git::test_support::git(&root, &["add", "tracked.md"]);
        crate::git::test_support::git(&root, &["commit", "-q", "-m", "update tracked"]);

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
        crate::git::test_support::git(&root, &["add", "f.md"]);
        crate::git::test_support::git(&root, &["commit", "-q", "-m", "first"]);
        std::fs::write(root.join("f.md"), "second\n").unwrap();
        crate::git::test_support::git(&root, &["add", "f.md"]);
        crate::git::test_support::git(&root, &["commit", "-q", "-m", "second"]);

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

    /// An option-shaped `rev` must never reach argv: `<rev>:./<path>` is a single
    /// token in option position, and `git show --output=<file>` opens a file for
    /// **writing**. No shell is involved, so this is argument injection, which
    /// Spec 2 §11.2's "no quoting concern" argument does not cover.
    #[test]
    fn an_option_shaped_rev_is_rejected_before_it_reaches_git() {
        if !git_available() {
            return;
        }
        let root = temp_dir("rev-option");
        init_repo(&root);
        std::fs::write(root.join("f.md"), "content\n").unwrap();
        crate::git::test_support::git(&root, &["add", "."]);
        crate::git::test_support::git(&root, &["commit", "-q", "-m", "one"]);

        // Proof the mechanism is real: git itself honours the option.
        let probed = std::process::Command::new("git")
            .current_dir(&root)
            .args(["show", "--output=proof", "HEAD"])
            .output()
            .unwrap();
        assert!(probed.status.success() && root.join("proof").exists());

        for bad in ["--output=pwned", "-o", "--help"] {
            assert_eq!(
                file_at_rev(&root, "f.md", bad),
                FileAtRev::NotFound,
                "rejected: {bad}"
            );
        }
        assert!(!root.join("pwned").exists(), "nothing was written");
        // A legitimate rev still resolves — the guard is a boundary check, not
        // a rev parser.
        assert!(matches!(
            file_at_rev(&root, "f.md", "HEAD"),
            FileAtRev::Ok { .. }
        ));
    }
}
