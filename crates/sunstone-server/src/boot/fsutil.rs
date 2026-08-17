//! Small filesystem helpers for the boot sequence.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::{REPO_DIR, SSH_DIR};

use super::{UID_HINT, WRITE_PROBE_NAME};

/// The writability probe: **create then remove** [`WRITE_PROBE_NAME`] in `dir`.
///
/// *Never* compare ownership — group permissions and `:ro` mounts both mean
/// ownership does not imply writability. Removing the probe again is part of the
/// contract: a leftover file would be a permanent tree-dirtying artefact that
/// stalls every rebase.
pub fn probe_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(WRITE_PROBE_NAME);
    fs::File::create(&probe)
        .map_err(|e| format!("{} is not writable: {e}", dir.display()))?;
    fs::remove_file(&probe).map_err(|e| {
        format!(
            "{} is writable but the probe file {WRITE_PROBE_NAME} could not be removed again: \
             {e}",
            dir.display()
        )
    })
}

/// `mkdir -p` with a message naming what the directory is *for*, so the failure
/// is actionable rather than a bare `errno`.
pub(super) fn ensure_dir(dir: &Path, what: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| {
        format!(
            "could not create {what} {}: {e}. {UID_HINT}. (A volume mounted at a path absent \
             from the image lands `root:root` and our uid cannot write it — {REPO_DIR} and \
             {SSH_DIR} both exist in the image for exactly this reason.)",
            dir.display()
        )
    })
}

/// Create `path` if it is missing, leaving an existing file untouched.
pub(super) fn touch(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, "").map_err(|e| format!("could not create {}: {e}", path.display()))
}

/// Recursive copy of a directory's **contents** into `dest` (`cp -a src/.
/// dest/`), dotfiles included. Symlinked directories are followed, so the
/// destination is a plain tree of real files.
pub(super) fn copy_dir_contents(src: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_contents(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Whether `dir` has no entries — missing counts as empty (§4.4's
/// "missing / empty" row is one branch).
pub(super) fn dir_is_empty(dir: &Path) -> Result<bool, String> {
    match fs::read_dir(dir) {
        Ok(mut entries) => Ok(entries.next().is_none()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(format!("could not read {}: {e}", dir.display())),
    }
}

/// `canonicalize`, falling back to the path as given (it may not exist yet).
pub(super) fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// The first line of a child's stderr — enough to name the fault without
/// pasting `ssh-keygen`'s multi-line banner into the boot log.
pub(super) fn first_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no output")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::tests::{is_root, tree};
    use crate::testutil::temp_dir;

    // --- §4.6 the probe -----------------------------------------------------

    #[test]
    fn probe_succeeds_on_a_writable_dir_and_leaves_nothing_behind() {
        let dir = temp_dir("probe-ok");
        assert!(probe_writable(&dir).is_ok());
        // Load-bearing: a leftover probe file would dirty the tree forever and
        // stall every rebase.
        assert!(tree(&dir).is_empty(), "probe left {:?} behind", tree(&dir));
    }

    #[test]
    #[cfg(unix)]
    fn probe_fails_on_a_read_only_dir() {
        use std::os::unix::fs::PermissionsExt;
        if is_root() {
            return; // root writes anything; the probe cannot be defeated by mode
        }
        let dir = temp_dir("probe-ro");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let err = probe_writable(&dir).unwrap_err();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            err.contains("is not writable") && err.contains(&dir.display().to_string()),
            "unhelpful probe error: {err}"
        );
    }
}
