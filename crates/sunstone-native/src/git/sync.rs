//! Sync primitives (Spec 2 §7).
//!
//! The thin git surface the server's sync loop (§8) and conflict resolver (§9)
//! need. Every one runs through `run_git`/`run_git_env`, so all of them pick up
//! `apply_git_env`.
//!
//! **Deliberately absent, despite ticket 06's list:** `merge-base`, `merge-file`
//! and merge-commit creation. That list predates ticket 07 choosing
//! rebase-always; there are no merge commits anywhere in this design.

use std::path::Path;
use std::process::Output;

use super::internal::{git_err, git_message, git_out, git_out_env, run_git, run_git_env, unit};

/// How a `rebase` / `rebase --continue` / `--skip` invocation ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RebaseOutcome {
    /// The rebase finished (or there was nothing to replay).
    Completed,
    /// The rebase stopped with unmerged paths — the resolver's cue (§9).
    Stopped,
    /// Git refused to start, e.g. a dirty working tree. §8.3: log it and skip
    /// the tick — **never** `stash` / `reset --hard` / `clean`, because
    /// discarding a tree that may hold an in-flight edit is worse than a
    /// stalled sync. Carries git's own message for the transition log.
    Refused { reason: String },
}

/// `GIT_EDITOR=true` for every `rebase` invocation, so git **never** waits on an
/// editor (§7): `--continue` would otherwise open one to confirm the replayed
/// commit's message and the loop would hang forever holding the write lock.
const NO_EDITOR: [(&str, &str); 1] = [("GIT_EDITOR", "true")];

/// `git fetch origin <branch>`. `Err` carries git's stderr, which §10.6 logs on
/// the first failure of a streak (the one place that detail lives).
pub fn fetch(root: &Path, branch: &str) -> Result<(), String> {
    unit("fetch", git_out(root, &["fetch", "origin", branch])?)
}

/// `git rebase -Xno-renames origin/<branch>`.
///
/// `-Xno-renames` is ticket 07's choice: rename detection would silently move a
/// web edit onto a path origin renamed, which the uniform fork rule cannot
/// describe. It is a *merge-strategy* option and says nothing about `log
/// --follow` (§11.2).
pub fn rebase_onto(root: &Path, branch: &str) -> Result<RebaseOutcome, String> {
    let upstream = format!("origin/{branch}");
    let output = git_out_env(root, &["rebase", "-Xno-renames", &upstream], &NO_EDITOR)?;
    Ok(classify_rebase(root, &output))
}

/// The tri-state classification §8.3 needs, shared by every rebase primitive so
/// they cannot drift: **the state of the repo decides, not the exit code.**
///
/// - a rebase is in progress ⇒ [`RebaseOutcome::Stopped`] — the resolver's cue,
///   whether git exited non-zero on a conflict or complained that nothing was
///   staged for `--continue`.
/// - otherwise a zero exit ⇒ [`RebaseOutcome::Completed`] (including "up to
///   date", which replays nothing).
/// - otherwise ⇒ [`RebaseOutcome::Refused`]: git never started. A dirty tree is
///   the case §8.3 names, but an unresolvable upstream lands here too, and both
///   want the same response — log the reason and skip the tick.
fn classify_rebase(root: &Path, output: &Output) -> RebaseOutcome {
    if rebase_in_progress(root) {
        RebaseOutcome::Stopped
    } else if output.status.success() {
        RebaseOutcome::Completed
    } else {
        RebaseOutcome::Refused {
            reason: git_message(output),
        }
    }
}

/// Whether a rebase is mid-flight, by asking git for the state directory of
/// **both** backends (`rebase-merge` for the default merge backend,
/// `rebase-apply` for `--apply`/`am`) and testing existence. Asked via
/// `rev-parse --git-path` rather than assuming `.git/…`, so a worktree or a
/// `--separate-git-dir` layout answers correctly.
fn rebase_in_progress(root: &Path) -> bool {
    ["rebase-merge", "rebase-apply"]
        .iter()
        .any(|name| git_path_exists(root, name))
}

/// Whether `git rev-parse --git-path <name>` names something that exists. The
/// answer is cwd-relative when git can make it so, hence the join against `root`.
fn git_path_exists(root: &Path, name: &str) -> bool {
    let Some(output) = run_git(root, &["rev-parse", "--git-path", name]) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let rel = raw.trim();
    if rel.is_empty() {
        return false;
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        path.exists()
    } else {
        root.join(path).exists()
    }
}

/// `git rebase --continue`.
///
/// **Must run with `GIT_EDITOR=true`** so git never waits on an editor.
pub fn rebase_continue(root: &Path) -> Result<RebaseOutcome, String> {
    let output = git_out_env(root, &["rebase", "--continue"], &NO_EDITOR)?;
    Ok(classify_rebase(root, &output))
}

/// `git rebase --skip` — used when nothing is staged after resolving, because
/// `--continue` refuses an empty commit (§9.4).
pub fn rebase_skip(root: &Path) -> Result<RebaseOutcome, String> {
    let output = git_out_env(root, &["rebase", "--skip"], &NO_EDITOR)?;
    Ok(classify_rebase(root, &output))
}

/// `git rebase --abort`. §8.3's self-healing exit: idempotent, because §9's
/// resolution is baked into the replayed commit, so a retry does not re-fork.
pub fn rebase_abort(root: &Path) -> Result<(), String> {
    unit(
        "rebase --abort",
        git_out_env(root, &["rebase", "--abort"], &NO_EDITOR)?,
    )
}

/// `git rev-list --count <range>` — e.g. `origin/main..HEAD` for the
/// `pendingCommits` the status route reports (§10.5), or `HEAD..origin/main`
/// for the behind count (§8.2).
pub fn rev_list_count(root: &Path, range: &str) -> Result<usize, String> {
    let output = git_out(root, &["rev-list", "--count", range])?;
    if !output.status.success() {
        return Err(git_err("rev-list --count", &output));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    raw.trim()
        .parse::<usize>()
        .map_err(|e| format!("git rev-list --count returned {:?}: {e}", raw.trim()))
}

/// The unmerged (conflicted) paths of a stopped rebase, de-duplicated across the
/// three stages — `git ls-files --unmerged`. The resolver's work list (§9).
///
/// Paths come back relative to `root` (which the loop sets to the **repository**
/// root, not the Bundle root — a rebase covers the whole repo even when the
/// Bundle is a subdir), so they compose directly with [`stage_entry`],
/// [`checkout_ours`] and [`rm_path`] against the same `root`.
pub fn unmerged_paths(root: &Path) -> Result<Vec<String>, String> {
    let output = git_out(root, &["ls-files", "-z", "--unmerged"])?;
    if !output.status.success() {
        return Err(git_err("ls-files --unmerged", &output));
    }
    Ok(parse_unmerged(&String::from_utf8_lossy(&output.stdout)))
}

/// Parse `git ls-files -z --unmerged` — `<mode> <object> <stage>\t<path>\0` per
/// entry, so one conflicted path appears up to three times. Yields each path once
/// in the order git listed it.
///
/// `-z` (rather than the default) because it turns off git's path *quoting*: a
/// path with a space, a quote or a non-ASCII byte would otherwise come back
/// `"…"`-wrapped and C-escaped, and the resolver would fork a filename that does
/// not exist.
fn parse_unmerged(stdout: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for record in stdout.split('\0') {
        let Some((_stat, path)) = record.split_once('\t') else {
            continue; // the trailing empty record, or garbage
        };
        if path.is_empty() || paths.iter().any(|p| p == path) {
            continue;
        }
        paths.push(path.to_string());
    }
    paths
}

/// The **raw bytes** of one conflict stage: `git show :<stage>:<path>`, with
/// `stage` 1 = base, 2 = ours (the origin base being replayed onto), 3 = theirs
/// (the web commit). `None` means that stage is absent — which is exactly how
/// §9 detects "origin deleted it" (no stage 2) and "web deleted it" (no stage 3).
///
/// Bytes, not `String`: the fork is written **verbatim**, so the resolver never
/// needs to be valid UTF-8 or know anything about markdown.
/// The `./` prefix makes the index lookup cwd-relative, matching both
/// [`super::history::file_at_rev`]'s convention and [`unmerged_paths`]' output
/// (`ls-files` also prints cwd-relative paths), so the pair composes even when
/// `root` is not the repository toplevel.
pub fn stage_entry(root: &Path, path: &str, stage: u8) -> Option<Vec<u8>> {
    let spec = format!(":{stage}:./{path}");
    let output = run_git(root, &["show", &spec])?;
    if output.status.success() {
        // Raw bytes, never `from_utf8_lossy`: §9 writes stage 3 verbatim, and a
        // lossy round-trip would corrupt any non-UTF-8 file.
        Some(output.stdout)
    } else {
        None // that stage is absent — §9's delete detection
    }
}

/// `git checkout --ours -- <path>` + stage it. In a rebase *ours* **is** the
/// origin base being replayed onto, which is what makes "origin keeps the name"
/// and `checkout --ours` the same operation (§9).
pub fn checkout_ours(root: &Path, path: &str) -> Result<(), String> {
    unit(
        "checkout --ours",
        git_out(root, &["checkout", "--ours", "--", path])?,
    )?;
    // `checkout --ours` only rewrites the worktree; the path stays *unmerged* in
    // the index until it is added, and `--continue` refuses on unmerged entries.
    add_paths(root, &[path])
}

/// `git rm -f -- <path>` — honours origin's deletion when stage 2 is absent
/// (§9.3, "origin deleted / web modified").
/// `-f` is required, not defensive: `git rm` refuses a path with unmerged index
/// entries, which is the only situation §9 ever calls this in.
pub fn rm_path(root: &Path, path: &str) -> Result<(), String> {
    unit("rm", git_out(root, &["rm", "-f", "-q", "--", path])?)
}

/// Stage `paths` explicitly (`git add -- <paths>`), the public face of the
/// existing private `stage` helper. The resolver needs it to add a fork it wrote
/// with plain filesystem calls — **never** through the server's rename/move
/// path, which would rewrite the whole bundle's links onto the fork (§9.2).
pub fn add_paths(root: &Path, paths: &[&str]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().copied());
    unit("add", git_out(root, &args)?)
}

/// Whether anything is staged relative to HEAD (`git diff --cached --quiet`).
/// Decides `--continue` vs `--skip` (§9.4): if every conflict was a dropped web
/// deletion (or origin's content already equalled ours) the replayed commit is
/// empty and `--continue` refuses.
pub fn anything_staged(root: &Path) -> Result<bool, String> {
    let output = git_out(root, &["diff", "--cached", "--quiet"])?;
    // `--quiet` implies `--exit-code`: 0 = no difference, 1 = a difference.
    // Anything else is a real failure (no HEAD, not a repo).
    match output.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(git_err("diff --cached", &output)),
    }
}

/// `git push origin HEAD:refs/heads/<branch>`.
///
/// **Fast-forward only, never `--force`.** origin can advance between our fetch
/// and our push; the rejection is *expected* — re-fetch, re-rebase and retry next
/// tick (§8.3).
/// The `Err` string carries git's stderr (§10.6's transition log is the one place
/// that detail lives) and — because a rejection is a *normal* outcome rather than
/// a fault — [`is_push_rejected`] classifies it without the caller parsing git.
pub fn push(root: &Path, branch: &str) -> Result<(), String> {
    let refspec = format!("HEAD:refs/heads/{branch}");
    unit("push", git_out(root, &["push", "origin", &refspec])?)
}

/// Whether a [`push`] error is origin having advanced under us (a non-fast-forward
/// rejection) rather than a genuine fault like a revoked key or an unreachable
/// host. Both are `Err`, both are retried next tick and neither is ever forced —
/// the distinction exists so §10.6 can log the *expected* race differently from a
/// deployment problem an operator must act on.
///
/// A predicate over the message rather than a variant on [`push`]'s return type:
/// git reports the rejection only in prose (the exit status is a flat 1), so the
/// classification has to read stderr wherever it lives.
pub fn is_push_rejected(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    ["[rejected]", "non-fast-forward", "fetch first", "stale info"]
        .iter()
        .any(|marker| lower.contains(marker))
}

/// `git clone <origin> --branch <branch> <dest>` (§4.4). `origin` is an
/// **opaque** string — the only inspection made of it anywhere is "is it
/// ssh-shaped?", in the server's config (Spec 1 §7).
pub fn clone(origin: &str, branch: &str, dest: &Path) -> Result<(), String> {
    // Every other primitive runs with the repo as cwd; a clone has no repo yet,
    // so it runs in `dest`'s parent (which must exist — `git clone` creates only
    // the final component).
    let parent = match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    if !parent.is_dir() {
        return Err(format!(
            "git clone failed: {} does not exist",
            parent.display()
        ));
    }
    let dest = dest.to_string_lossy().into_owned();
    // `--` so an `origin` that happens to start with `-` is never read as an
    // option; the string is otherwise entirely opaque to us.
    unit(
        "clone",
        git_out(parent, &["clone", "--branch", branch, "--", origin, &dest])?,
    )
}

/// `git init --initial-branch=<branch>` (§4.4, git-local over a non-repo).
pub fn init(root: &Path, branch: &str) -> Result<(), String> {
    let initial = format!("--initial-branch={branch}");
    unit("init", git_out(root, &["init", "-q", &initial])?)
}

/// The currently checked-out branch name, or `None` on a detached HEAD, an
/// unborn branch, or a non-repo.
///
/// `--quiet` so an unborn HEAD (a fresh `init` with no commit) is a silent
/// failure rather than a stderr line, and `--short` to get `main` rather than
/// `refs/heads/main`.
pub fn current_branch(root: &Path) -> Option<String> {
    let output = run_git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

/// `git remote get-url origin`, or `None` when there is no `origin` remote / not
/// a repo. §4.4 compares it against the configured origin: a **mismatch fails
/// loudly and touches nothing.**
pub fn remote_url(root: &Path) -> Option<String> {
    let output = run_git(root, &["remote", "get-url", "origin"])?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// `git diff --name-status <range>` as `(status letter, path)` pairs — e.g.
/// `ORIG_HEAD..HEAD` for §10.6's `integrated N commits … (M files changed)` log
/// line.
pub fn diff_name_status(root: &Path, range: &str) -> Result<Vec<(char, String)>, String> {
    let output = git_out(root, &["diff", "--name-status", range])?;
    if !output.status.success() {
        return Err(git_err("diff --name-status", &output));
    }
    Ok(parse_name_status(&String::from_utf8_lossy(&output.stdout)))
}

/// Parse `git diff --name-status` — `<status>\t<path>` per line, with a rename or
/// copy adding a second path (`R100\told\tnew`). The **last** field is taken, so a
/// rename reports where the content ended up; only the first character of the
/// status is kept, dropping the similarity score.
fn parse_name_status(stdout: &str) -> Vec<(char, String)> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let status = fields.next()?.chars().next()?;
            let path = fields.last()?;
            if path.is_empty() {
                return None;
            }
            Some((status, path.to_string()))
        })
        .collect()
}

/// Whether `root` is inside a git work tree
/// (`git rev-parse --is-inside-work-tree`). Drives §4.4's state machine and the
/// adopt-vs-init decision.
pub fn is_repo(root: &Path) -> bool {
    let Some(output) = run_git(root, &["rev-parse", "--is-inside-work-tree"])
    else {
        return false; // git missing, or `root` does not exist
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
}

/// The author date of the commit a stopped rebase is replaying (`REBASE_HEAD`),
/// pre-formatted as §9's `<ts>` — `YYYYMMDDThhmmssZ`, UTC.
///
/// Git formats it for us (`--date=format-local:%Y%m%dT%H%M%SZ` with `TZ=UTC`),
/// so no time crate enters the workspace. The **author** date, not the wall
/// clock, because it records when the edit was *made* — what the human
/// reconciling the fork needs — and is stable across an aborted-rebase retry.
/// `None` when no rebase is in progress.
pub fn rebase_head_timestamp(root: &Path) -> Option<String> {
    let output = run_git_env(
        root,
        &[
            "log",
            "-1",
            "--format=%ad",
            "--date=format-local:%Y%m%dT%H%M%SZ",
            "REBASE_HEAD",
        ],
        // `format-local` renders in the *local* zone, so pin the child's zone to
        // UTC rather than pulling in a time crate.
        &[("TZ", "UTC")],
    )?;
    if !output.status.success() {
        return None; // no rebase in progress: REBASE_HEAD does not resolve
    }
    let ts = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if ts.is_empty() {
        None
    } else {
        Some(ts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commit::{commit, CommitIdentity};
    use crate::git::history::FileHistory;
    use crate::git::test_support::{git, git_available, ident, temp_dir};
    use std::path::PathBuf;

    // --- Pure parsing for the sync primitives (§7) --------------------------

    #[test]
    fn parse_unmerged_dedupes_stages_preserving_order() {
        // `-z`: NUL-terminated `<mode> <object> <stage>\t<path>` records.
        let stdout = "100644 aaa 1\tnotes/f.md\0100644 bbb 2\tnotes/f.md\0\
                      100644 ccc 3\tnotes/f.md\0100644 ddd 2\ta b.md\0";
        assert_eq!(
            parse_unmerged(stdout),
            vec!["notes/f.md".to_string(), "a b.md".to_string()]
        );
        assert!(parse_unmerged("").is_empty());
        assert!(parse_unmerged("garbage-without-a-tab\0").is_empty());
    }

    #[test]
    fn parse_name_status_takes_the_letter_and_the_destination_path() {
        let stdout = "M\tnotes/a.md\nA\tnotes/new.md\nD\told.md\nR100\tfrom.md\tto.md\n";
        assert_eq!(
            parse_name_status(stdout),
            vec![
                ('M', "notes/a.md".to_string()),
                ('A', "notes/new.md".to_string()),
                ('D', "old.md".to_string()),
                ('R', "to.md".to_string()),
            ]
        );
        assert!(parse_name_status("").is_empty());
    }

    #[test]
    fn push_rejection_is_distinguished_from_a_transport_failure() {
        assert!(is_push_rejected(
            "git push failed: ! [rejected]        HEAD -> main (fetch first)"
        ));
        assert!(is_push_rejected(
            "git push failed: error: failed to push some refs\nhint: Updates were rejected because the remote contains work (non-fast-forward)"
        ));
        assert!(!is_push_rejected(
            "git push failed: ssh: connect to host example.com port 22: Network is unreachable"
        ));
        assert!(!is_push_rejected(
            "git push failed: ERROR: Permission to org/repo.git denied to deploy key"
        ));
    }

    // --- Live-git tests for the sync primitives -----------------------------

    /// A tracked-file write that creates parent directories.
    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let abs = root.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, bytes).unwrap();
    }

    fn rev_parse(root: &Path, rev: &str) -> String {
        let out = std::process::Command::new("git")
            .current_dir(root)
            .arg("rev-parse")
            .args(rev.split_whitespace())
            .output()
            .unwrap();
        assert!(out.status.success(), "rev-parse {rev} failed: {out:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repo on `main` created through the [`init`] primitive itself, with a
    /// local identity and signing off (the ambient `~/.gitconfig` must not
    /// decide whether the suite passes).
    fn repo_on_main(tag: &str) -> PathBuf {
        let root = temp_dir(tag);
        init(&root, "main").unwrap();
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "user.name", "Test User"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        root
    }

    fn commit_all(root: &Path, msg: &str) {
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", msg]);
    }

    /// Plant `refs/remotes/origin/main` at HEAD. `origin/<branch>` is just a ref
    /// as far as a rebase is concerned, so divergence is reproducible with no
    /// network and no second repository.
    fn plant_origin(root: &Path) {
        let sha = rev_parse(root, "HEAD");
        git(root, &["update-ref", "refs/remotes/origin/main", &sha]);
    }

    /// The base commit, then an origin-side commit planted as `origin/main`, then
    /// local `main` rewound to the base — a genuine fork of the two lines.
    /// Returns the repo root.
    fn diverged_repo(tag: &str, origin_side: impl Fn(&Path), web_side: impl Fn(&Path)) -> PathBuf {
        let root = repo_on_main(tag);
        put(&root, "notes/f.md", b"base\n");
        commit_all(&root, "base");
        let base = rev_parse(&root, "HEAD");

        origin_side(&root);
        commit_all(&root, "edit on origin");
        plant_origin(&root);

        git(&root, &["reset", "-q", "--hard", &base]);
        web_side(&root);
        commit_all(&root, "edit notes/f.md via web");
        root
    }

    /// Deliberately not valid UTF-8: proves `stage_entry` hands back raw bytes,
    /// because §9 writes stage 3 verbatim and a lossy round-trip would corrupt a
    /// non-text file.
    const WEB_BYTES: &[u8] = b"web version\n\xff\xfe\x80 tail\n";

    #[test]
    fn is_repo_and_init() {
        if !git_available() {
            return;
        }
        let plain = temp_dir("isrepo-plain");
        assert!(!is_repo(&plain), "a bare directory is not a repo");
        assert!(!is_repo(&plain.join("does-not-exist")));

        init(&plain, "main").unwrap();
        assert!(is_repo(&plain));
        // `--initial-branch` is one of `SUNSTONE_GIT_BRANCH`'s four jobs (§2.1).
        put(&plain, "a.md", b"x\n");
        git(&plain, &["config", "user.email", "t@e.io"]);
        git(&plain, &["config", "user.name", "T"]);
        git(&plain, &["config", "commit.gpgsign", "false"]);
        commit_all(&plain, "first");
        assert_eq!(rev_parse(&plain, "--abbrev-ref HEAD"), "main");
        assert_eq!(remote_url(&plain), None, "no origin remote yet");
    }

    #[test]
    fn rev_list_count_and_diff_name_status_read_a_range() {
        if !git_available() {
            return;
        }
        let root = diverged_repo(
            "ranges",
            |r| put(r, "notes/f.md", b"origin version\n"),
            |r| {
                put(r, "notes/f.md", b"web version\n");
                put(r, "notes/new.md", b"# new\n");
            },
        );

        // One commit each side of the fork (§8.2's ahead/behind).
        assert_eq!(rev_list_count(&root, "origin/main..HEAD").unwrap(), 1);
        assert_eq!(rev_list_count(&root, "HEAD..origin/main").unwrap(), 1);
        assert_eq!(rev_list_count(&root, "HEAD..HEAD").unwrap(), 0);
        assert!(rev_list_count(&root, "origin/nope..HEAD").is_err());

        let mut changed = diff_name_status(&root, "origin/main..HEAD").unwrap();
        changed.sort();
        assert_eq!(
            changed,
            vec![('A', "notes/new.md".to_string()), ('M', "notes/f.md".to_string())]
        );
    }

    #[test]
    fn rebase_stops_on_conflict_then_continues_after_resolution() {
        if !git_available() {
            return;
        }
        let root = diverged_repo(
            "rebase-conflict",
            |r| put(r, "notes/f.md", b"origin version\n"),
            |r| {
                put(r, "notes/f.md", WEB_BYTES);
                put(r, "notes/new.md", b"# new\n");
            },
        );

        assert_eq!(
            rebase_onto(&root, "main").unwrap(),
            RebaseOutcome::Stopped,
            "a content conflict must be Stopped, not Refused"
        );

        // The resolver's work list, de-duplicated across the three stages.
        assert_eq!(unmerged_paths(&root).unwrap(), vec!["notes/f.md".to_string()]);

        // All three stages, as raw bytes. In a rebase, stage 2 (*ours*) IS the
        // origin base being replayed onto — which is what makes "origin keeps the
        // name" and `checkout --ours` the same operation (§9).
        assert_eq!(stage_entry(&root, "notes/f.md", 1).unwrap(), b"base\n");
        assert_eq!(
            stage_entry(&root, "notes/f.md", 2).unwrap(),
            b"origin version\n"
        );
        assert_eq!(
            stage_entry(&root, "notes/f.md", 3).unwrap(),
            WEB_BYTES,
            "stage 3 must come back byte-for-byte, invalid UTF-8 included"
        );
        assert_eq!(stage_entry(&root, "notes/absent.md", 3), None);

        // §9's `<ts>`, from the author date of the commit being replayed.
        let ts = rebase_head_timestamp(&root).expect("a stopped rebase has REBASE_HEAD");
        assert_eq!(ts.len(), 16, "YYYYMMDDThhmmssZ, got {ts:?}");
        assert!(ts.ends_with('Z') && ts.as_bytes()[8] == b'T', "got {ts:?}");

        // Origin keeps the name.
        checkout_ours(&root, "notes/f.md").unwrap();
        assert_eq!(
            std::fs::read(root.join("notes/f.md")).unwrap(),
            b"origin version\n"
        );
        // `notes/new.md` is still part of the replayed commit, so it is not empty.
        assert!(anything_staged(&root).unwrap());

        assert_eq!(rebase_continue(&root).unwrap(), RebaseOutcome::Completed);
        assert!(!rebase_in_progress(&root));

        // The replayed commit reduces to the add — staging *ours* left no diff on
        // the conflicted path, which is §9.1's idempotence.
        assert_eq!(rev_list_count(&root, "origin/main..HEAD").unwrap(), 1);
        assert_eq!(
            diff_name_status(&root, "origin/main..HEAD").unwrap(),
            vec![('A', "notes/new.md".to_string())]
        );
    }

    #[test]
    fn origin_deletion_leaves_no_stage_two_and_the_empty_commit_is_skipped() {
        if !git_available() {
            return;
        }
        // §9.3, "origin deleted / web modified": stage 2 absent, stage 3 present.
        let root = diverged_repo(
            "rebase-delete",
            |r| std::fs::remove_file(r.join("notes/f.md")).unwrap(),
            |r| put(r, "notes/f.md", WEB_BYTES),
        );

        assert_eq!(rebase_onto(&root, "main").unwrap(), RebaseOutcome::Stopped);
        assert_eq!(unmerged_paths(&root).unwrap(), vec!["notes/f.md".to_string()]);
        assert_eq!(
            stage_entry(&root, "notes/f.md", 2),
            None,
            "no stage 2 is how §9 detects origin's deletion"
        );
        assert_eq!(stage_entry(&root, "notes/f.md", 3).unwrap(), WEB_BYTES);

        // Honour origin's deletion. (The fork of the web bytes is the server's
        // job; here the point is that `rm` works on an unmerged path.)
        rm_path(&root, "notes/f.md").unwrap();
        assert!(!root.join("notes/f.md").exists());

        // Nothing is left for this commit, so `--continue` is the wrong call
        // (§9.4) — `--skip` drops it and finishes the rebase.
        assert!(!anything_staged(&root).unwrap());
        assert_eq!(rebase_skip(&root).unwrap(), RebaseOutcome::Completed);
        assert!(!rebase_in_progress(&root));
        assert_eq!(rev_list_count(&root, "origin/main..HEAD").unwrap(), 0);
        assert_eq!(rev_parse(&root, "HEAD"), rev_parse(&root, "origin/main"));
    }

    #[test]
    fn rebase_refuses_a_dirty_tree_and_leaves_it_alone() {
        if !git_available() {
            return;
        }
        let root = diverged_repo(
            "rebase-dirty",
            |r| put(r, "notes/f.md", b"origin version\n"),
            |r| put(r, "notes/g.md", b"# g\n"),
        );
        // An in-flight edit, uncommitted.
        put(&root, "notes/g.md", b"# g, being edited\n");

        match rebase_onto(&root, "main").unwrap() {
            RebaseOutcome::Refused { reason } => {
                assert!(!reason.is_empty(), "the reason carries git's own message");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        // §8.3: never stash, never `reset --hard`, never clean — the tree is
        // exactly as we left it and no rebase is half-started.
        assert_eq!(
            std::fs::read(root.join("notes/g.md")).unwrap(),
            b"# g, being edited\n"
        );
        assert!(!rebase_in_progress(&root));
        assert!(
            rebase_abort(&root).is_err(),
            "there is no rebase to abort after a refusal"
        );
    }

    #[test]
    fn rebase_abort_unwinds_a_stopped_rebase() {
        if !git_available() {
            return;
        }
        let root = diverged_repo(
            "rebase-abort",
            |r| put(r, "notes/f.md", b"origin version\n"),
            |r| put(r, "notes/f.md", WEB_BYTES),
        );
        let before = rev_parse(&root, "HEAD");
        assert_eq!(rebase_onto(&root, "main").unwrap(), RebaseOutcome::Stopped);
        rebase_abort(&root).unwrap();
        assert!(!rebase_in_progress(&root));
        assert_eq!(rev_parse(&root, "HEAD"), before, "abort is a full unwind");
    }

    #[test]
    fn clone_push_and_fetch_over_a_local_bare_remote() {
        if !git_available() {
            return;
        }
        let bare = temp_dir("bare");
        git(&bare, &["init", "--bare", "-q", "--initial-branch=main"]);
        let origin = bare.to_string_lossy().into_owned();

        // A first repo pushes the branch into existence.
        let work = repo_on_main("push-work");
        git(&work, &["remote", "add", "origin", &origin]);
        put(&work, "a.md", b"a\n");
        commit_all(&work, "a");
        push(&work, "main").unwrap();

        // Clone it (the §4.4 fresh-volume path).
        let dest = temp_dir("clone-parent").join("repo");
        clone(&origin, "main", &dest).unwrap();
        assert!(is_repo(&dest));
        assert_eq!(remote_url(&dest).as_deref(), Some(origin.as_str()));
        git(&dest, &["config", "commit.gpgsign", "false"]);

        // The clone commits and pushes: a fast-forward, so it lands.
        put(&dest, "b.md", b"b\n");
        commit(&dest, &["b.md"], "edit b.md via web", &ident("Ada", "ada@x.io")).unwrap();
        assert_eq!(rev_list_count(&dest, "origin/main..HEAD").unwrap(), 1);
        push(&dest, "main").unwrap();
        assert_eq!(rev_list_count(&dest, "origin/main..HEAD").unwrap(), 0);

        // Now the first repo is behind, so its push is REJECTED — a normal
        // result (§8.3), distinguishable from a transport fault, carrying git's
        // own text for §10.6's transition log.
        put(&work, "c.md", b"c\n");
        commit_all(&work, "c");
        let err = push(&work, "main").expect_err("a non-fast-forward must be rejected");
        assert!(
            is_push_rejected(&err),
            "expected a rejection, got {err:?}"
        );
        assert!(err.starts_with("git push failed:"), "got {err:?}");

        // Re-fetch, and the divergence is visible for the next tick's rebase.
        fetch(&work, "main").unwrap();
        assert_eq!(rev_list_count(&work, "HEAD..origin/main").unwrap(), 1);
        assert_eq!(rev_list_count(&work, "origin/main..HEAD").unwrap(), 1);
    }

    #[test]
    fn fetch_fails_with_gits_text_when_the_remote_is_unusable() {
        if !git_available() {
            return;
        }
        let root = repo_on_main("fetch-fail");
        git(
            &root,
            &["remote", "add", "origin", "/nonexistent/sunstone-not-a-repo"],
        );
        let err = fetch(&root, "main").expect_err("an absent remote cannot be fetched");
        assert!(err.starts_with("git fetch failed:"), "got {err:?}");
        assert!(!err.trim_end_matches(':').ends_with("failed:"), "got {err:?}");
    }

    #[test]
    fn add_paths_is_a_no_op_for_an_empty_list() {
        if !git_available() {
            return;
        }
        let root = repo_on_main("add-empty");
        // No pathspec must not become `git add` over the whole tree.
        put(&root, "a.md", b"a\n");
        add_paths(&root, &[]).unwrap();
        assert!(matches!(
            crate::git::history::file_history(&root, "a.md"),
            FileHistory::Untracked
        ));
    }

    #[test]
    fn primitives_on_a_non_repo_fail_without_panicking() {
        if !git_available() {
            return;
        }
        let root = temp_dir("prims-norepo");
        assert!(!is_repo(&root));
        assert!(fetch(&root, "main").is_err());
        assert!(rev_list_count(&root, "HEAD").is_err());
        assert!(unmerged_paths(&root).is_err());
        assert!(diff_name_status(&root, "HEAD").is_err());
        assert!(anything_staged(&root).is_err());
        assert!(rebase_onto(&root, "main").is_ok_and(|o| matches!(o, RebaseOutcome::Refused { .. })));
        assert_eq!(remote_url(&root), None);
        assert_eq!(stage_entry(&root, "a.md", 2), None);
        assert_eq!(rebase_head_timestamp(&root), None);
    }
}
