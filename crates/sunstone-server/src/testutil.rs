//! Shared git test harness for the server's test modules (`boot`, `conflict`,
//! `history`, `sync`, `write`), mirroring `sunstone-native`'s
//! `git::test_support`: real temp repos driven through the `git` CLI, with
//! tests skipping cleanly when `git` is absent from PATH. Module-specific
//! fixtures (deployments, diverged forks, git-shaped configs, …) stay local
//! to their modules.
#![allow(dead_code)] // not every module uses every helper

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Skip cleanly when `git` is absent from PATH.
pub fn git_available() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

/// A fresh canonicalized temp directory, following `main.rs`'s counter idiom
/// (no `tempfile` dev-dependency in this crate). Collision-free across all
/// test modules: one shared counter, plus the process id.
pub fn temp_dir(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "sunstone-test-{tag}-{}-{}",
        std::process::id(),
        n
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// Run a git command in `root`, asserting success.
pub fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?} failed: {out:?}");
}

/// Run a git command in `root` and return its trimmed stdout.
pub fn git_stdout(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?} failed: {out:?}");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Write `bytes` at `rel` under `root`, creating parent directories.
pub fn put(root: &Path, rel: &str, bytes: &[u8]) {
    let abs = root.join(rel);
    std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
    std::fs::write(abs, bytes).unwrap();
}

pub fn read(root: &Path, rel: &str) -> Vec<u8> {
    std::fs::read(root.join(rel)).unwrap_or_else(|e| panic!("reading {rel}: {e}"))
}

/// Identity and signing come from the repo, never the ambient `~/.gitconfig`.
pub fn local_identity(root: &Path) {
    git(root, &["config", "user.email", "test@example.com"]);
    git(root, &["config", "user.name", "Test User"]);
    git(root, &["config", "commit.gpgsign", "false"]);
}

/// Commit everything. `date` fixes the **author** date, which is what §9's
/// `<ts>` is taken from.
pub fn commit_all(root: &Path, msg: &str, date: Option<&str>) {
    git(root, &["add", "-A"]);
    match date {
        Some(date) => git(root, &["commit", "-q", "-m", msg, "--date", date]),
        None => git(root, &["commit", "-q", "-m", msg]),
    }
}

pub fn head(root: &Path) -> String {
    git_stdout(root, &["rev-parse", "HEAD"])
}
