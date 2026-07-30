//! Shared process-plumbing helpers used by every git submodule: spawning `git`
//! with the Bundle root as cwd, and turning its `Output` into the crate's error
//! conventions. Kept in one place so every git child — read, write or sync —
//! goes through the same [`super::env::apply_git_env`] call (Spec 2 §3).

use std::path::Path;
use std::process::{Command, Output};

use super::env::apply_git_env;

/// The error every primitive returns when `git` could not be launched at all —
/// the `Result` twin of the `GitMissing` value the read side surfaces.
pub(super) const GIT_MISSING: &str = "git is not available";

/// Run `git <args>` with the Bundle root as the working directory. Returns the
/// captured [`Output`], or `None` if `git` could not be launched at all (not on
/// PATH, or otherwise unspawnable — surfaced upstream as `GitMissing`).
///
/// Applies [`apply_git_env`], the single process-global environment helper, so
/// every git child — networked or not — is configured identically (Spec 2 §3).
pub(super) fn run_git(root: &Path, args: &[&str]) -> Option<Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args);
    apply_git_env(&mut cmd);
    cmd.output().ok()
}

/// Like [`run_git`] but with extra environment variables set on the child (used
/// to carry the commit identity without touching the repo config).
///
/// [`apply_git_env`] is applied **after** `env`, so a configured committer wins
/// over a call-site `GIT_COMMITTER_*` — see its docs for why that is deliberate.
pub(super) fn run_git_env(root: &Path, args: &[&str], env: &[(&str, &str)]) -> Option<Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    apply_git_env(&mut cmd);
    cmd.output().ok()
}

/// [`run_git`] lifted into `Result`, so a primitive can `?` the git-missing case.
pub(super) fn git_out(root: &Path, args: &[&str]) -> Result<Output, String> {
    run_git(root, args).ok_or_else(|| GIT_MISSING.to_string())
}

/// [`run_git_env`] lifted into `Result` — see [`git_out`].
pub(super) fn git_out_env(root: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<Output, String> {
    run_git_env(root, args, env).ok_or_else(|| GIT_MISSING.to_string())
}

/// Format a non-zero git invocation into an error string (trimmed stderr).
pub(super) fn git_err(op: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("git {op} failed: {}", stderr.trim())
}

/// Git's own message for a failed invocation: stderr, falling back to stdout
/// (`rebase` puts some refusals there). Used where the text is carried as a
/// *reason* rather than as an error (§8.3's `Refused`).
pub(super) fn git_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stderr.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Collapse an [`Output`] into `Ok(())` / `Err(git's stderr)`, the convention the
/// pre-existing `commit` / `stage` path already uses.
pub(super) fn unit(op: &str, output: Output) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(git_err(op, &output))
    }
}

/// Whether git's stderr indicates the directory is outside any repository.
pub(super) fn is_not_a_repo(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr).contains("not a git repository")
}
