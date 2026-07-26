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
use std::sync::OnceLock;

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
///
/// [`apply_git_env`] is applied **after** `env`, so a configured committer wins
/// over a call-site `GIT_COMMITTER_*` — see its docs for why that is deliberate.
fn run_git_env(root: &Path, args: &[&str], env: &[(&str, &str)]) -> Option<Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    apply_git_env(&mut cmd);
    cmd.output().ok()
}

// --- Process-global git environment (Spec 2 §3) ------------------------------
//
// This module is host-agnostic and shared with the desktop, so it must not learn
// container paths. Instead the *server* sets a process-global environment once at
// boot; `git.rs` only knows how to apply it.

/// The process-global git environment, set once at boot by `sunstone-server`.
/// The **desktop never calls [`configure`]**, so nothing is injected there and
/// its behaviour is unchanged.
#[derive(Debug, Clone, Default)]
pub struct GitEnv {
    /// `GIT_SSH_COMMAND`, e.g.
    /// `ssh -i /srv/ssh/id_ed25519 -o IdentitiesOnly=yes
    /// -o StrictHostKeyChecking=<yes|accept-new>
    /// -o UserKnownHostsFile=/srv/ssh/known_hosts`.
    ///
    /// No `~/.ssh`, no ssh config file — measured unnecessary. `IdentitiesOnly`
    /// so no agent identity is picked up silently.
    pub ssh_command: Option<String>,
    /// The **sync identity**, injected as `GIT_COMMITTER_NAME` / `_EMAIL`. This
    /// intentionally overrides a call-site committer, so a web Save keeps the
    /// OIDC user as *author* while the container is the *committer* (Spec 1 §9).
    pub committer: Option<CommitIdentity>,
}

/// The one-shot slot. `OnceLock` rather than a mutable global: the environment is
/// established once, before anything spawns git, and never changes.
static GIT_ENV: OnceLock<GitEnv> = OnceLock::new();

/// Install the process-global git environment. Called exactly once, from the
/// server's boot sequence (Spec 2 §4.2.4), **before** any git child is spawned.
/// A second call is ignored.
pub fn configure(env: GitEnv) {
    let _ = GIT_ENV.set(env);
}

/// Apply the configured environment to a git child. The **single** helper both
/// [`run_git`] and [`run_git_env`] apply, so there is deliberately no second
/// classification of "networked" operations to keep in sync (Spec 2 §3).
///
/// Injected when [`configure`] has run:
///
/// | Injected | Why |
/// | --- | --- |
/// | `GIT_SSH_COMMAND` | the deploy key, `IdentitiesOnly`, the pinned `known_hosts` |
/// | `GIT_CONFIG_COUNT=1` + `commit.gpgsign=false` | immunity to a mounted `~/.gitconfig` enabling signing, which would fail every commit with no key present |
/// | `GIT_COMMITTER_NAME` / `_EMAIL` | the sync identity as committer |
///
/// **No `safe.directory`, ever** — measured to buy *reads* only (`commit` still
/// fails on filesystem permissions), and no supported deployment trips the guard.
/// If a future deployment needs it, inject via `GIT_CONFIG_*` naming the repo
/// **toplevel** (the subdir path does not satisfy the guard, and
/// `rev-parse --show-toplevel` is itself blocked by it) — never a global config
/// file, never a Dockerfile `ENV`.
fn apply_git_env(cmd: &mut Command) {
    let Some(env) = GIT_ENV.get() else {
        return; // desktop (and any pre-boot call): unchanged behaviour
    };
    inject(cmd, env);
}

/// The injection itself, split out from the `OnceLock` read purely so it is
/// unit-testable without touching the process-global (a test that called
/// [`configure`] would leak into every other test in the binary). There is still
/// exactly **one** place that decides what a git child gets.
fn inject(cmd: &mut Command, env: &GitEnv) {
    if let Some(ssh) = &env.ssh_command {
        cmd.env("GIT_SSH_COMMAND", ssh);
    }
    cmd.env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "commit.gpgsign")
        .env("GIT_CONFIG_VALUE_0", "false");
    if let Some(committer) = &env.committer {
        cmd.env("GIT_COMMITTER_NAME", &committer.name)
            .env("GIT_COMMITTER_EMAIL", &committer.email);
    }
}

// --- Sync primitives (Spec 2 §7) --------------------------------------------
//
// The thin git surface the server's sync loop (§8) and conflict resolver (§9)
// need. Every one runs through `run_git`/`run_git_env`, so all of them pick up
// `apply_git_env`.
//
// **Deliberately absent, despite ticket 06's list:** `merge-base`, `merge-file`
// and merge-commit creation. That list predates ticket 07 choosing
// rebase-always; there are no merge commits anywhere in this design.

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

/// The error every primitive returns when `git` could not be launched at all —
/// the `Result` twin of the `GitMissing` value the read side surfaces.
const GIT_MISSING: &str = "git is not available";

/// `GIT_EDITOR=true` for every `rebase` invocation, so git **never** waits on an
/// editor (§7): `--continue` would otherwise open one to confirm the replayed
/// commit's message and the loop would hang forever holding the write lock.
const NO_EDITOR: [(&str, &str); 1] = [("GIT_EDITOR", "true")];

/// [`run_git`] lifted into `Result`, so a primitive can `?` the git-missing case.
fn git_out(root: &Path, args: &[&str]) -> Result<Output, String> {
    run_git(root, args).ok_or_else(|| GIT_MISSING.to_string())
}

/// [`run_git_env`] lifted into `Result` — see [`git_out`].
fn git_out_env(root: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<Output, String> {
    run_git_env(root, args, env).ok_or_else(|| GIT_MISSING.to_string())
}

/// Collapse an [`Output`] into `Ok(())` / `Err(git's stderr)`, the convention the
/// pre-existing [`commit`] / [`stage`] path already uses.
fn unit(op: &str, output: Output) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(git_err(op, &output))
    }
}

/// Git's own message for a failed invocation: stderr, falling back to stdout
/// (`rebase` puts some refusals there). Used where the text is carried as a
/// *reason* rather than as an error (§8.3's `Refused`).
fn git_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stderr.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

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
/// [`file_at_rev`]'s convention and [`unmerged_paths`]' output (`ls-files` also
/// prints cwd-relative paths), so the pair composes even when `root` is not the
/// repository toplevel.
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

/// `git remote get-url origin`, or `None` when there is no `origin` remote / not
/// a repo. §4.4 compares it against the configured origin: a **mismatch fails
/// loudly and touches nothing.**
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
    let Some(output) = run_git(root, &["rev-parse", "--is-inside-work-tree"]) else {
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
///
/// Applies [`apply_git_env`], the single process-global environment helper, so
/// every git child — networked or not — is configured identically (Spec 2 §3).
fn run_git(root: &Path, args: &[&str]) -> Option<Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args);
    apply_git_env(&mut cmd);
    cmd.output().ok()
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
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "one"]);

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

    // --- Environment injection (Spec 2 §3) ----------------------------------
    //
    // `configure` writes a process-global `OnceLock`, so **no test may call it**:
    // it would leak into every other test in this binary (and there is no way to
    // un-set it). The injection is therefore tested through `inject`, and the
    // unconfigured no-op through the real `apply_git_env`.

    /// Every env var a `Command` carries, as owned `(key, value)` strings.
    fn command_envs(cmd: &Command) -> Vec<(String, String)> {
        cmd.get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                )
            })
            .collect()
    }

    #[test]
    fn unconfigured_git_env_injects_nothing() {
        // The desktop never calls `configure`, so this is the desktop's git
        // child: byte-identical to one built before §3 existed.
        let mut cmd = Command::new("git");
        apply_git_env(&mut cmd);
        assert!(
            command_envs(&cmd).is_empty(),
            "unconfigured injection must be a complete no-op, got {:?}",
            command_envs(&cmd)
        );
        assert!(
            GIT_ENV.get().is_none(),
            "no test may call configure(): the OnceLock is process-global and \
             would make this assertion order-dependent"
        );
    }

    #[test]
    fn configured_git_env_injects_ssh_gpgsign_and_committer_only() {
        let env = GitEnv {
            ssh_command: Some("ssh -i /srv/ssh/id_ed25519 -o IdentitiesOnly=yes".to_string()),
            committer: Some(ident("Sunstone Sync", "sync@sunstone.invalid")),
        };
        let mut cmd = Command::new("git");
        inject(&mut cmd, &env);
        let mut envs = command_envs(&cmd);
        envs.sort();
        assert_eq!(
            envs,
            vec![
                (
                    "GIT_COMMITTER_EMAIL".to_string(),
                    "sync@sunstone.invalid".to_string()
                ),
                ("GIT_COMMITTER_NAME".to_string(), "Sunstone Sync".to_string()),
                ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
                ("GIT_CONFIG_KEY_0".to_string(), "commit.gpgsign".to_string()),
                ("GIT_CONFIG_VALUE_0".to_string(), "false".to_string()),
                (
                    "GIT_SSH_COMMAND".to_string(),
                    "ssh -i /srv/ssh/id_ed25519 -o IdentitiesOnly=yes".to_string()
                ),
            ]
        );
        // The sync identity is the COMMITTER only — never the author, so `git log`
        // still shows the OIDC user (§3).
        assert!(
            !envs.iter().any(|(k, _)| k.starts_with("GIT_AUTHOR")),
            "the sync identity must never become the author"
        );
        // No `safe.directory`, ever (§3's last paragraph): a single
        // `GIT_CONFIG_COUNT=1` is the proof — a second key would need `2`.
        assert!(
            !envs.iter().any(|(_, v)| v.contains("safe.directory")),
            "safe.directory must never be injected"
        );
    }

    #[test]
    fn configured_git_env_without_ssh_or_committer_still_disables_signing() {
        let mut cmd = Command::new("git");
        inject(&mut cmd, &GitEnv::default());
        let mut envs = command_envs(&cmd);
        envs.sort();
        assert_eq!(
            envs.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            vec!["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
        );
    }

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
        let out = Command::new("git")
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
        assert!(matches!(file_history(&root, "a.md"), FileHistory::Untracked));
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
