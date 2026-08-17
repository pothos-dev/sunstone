//! §4.2 — the ssh material for a git-synced deployment with an ssh-shaped
//! origin: writing and validating the deploy key, the known-hosts file, the
//! `GIT_SSH_COMMAND` string, and scrubbing the key from our own environment.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::config::{Config, GitConfig, KNOWN_HOSTS_PATH, SSH_DIR, SSH_KEY_PATH};

use super::fsutil::{ensure_dir, first_line, touch};

// The two variables §4.2 acts on. `config` keeps its per-key constants private,
// so they are spelled again here and asserted against its closed
// `KNOWN_GIT_VARS` set by `spelled_env_names_are_in_configs_closed_set` — a
// rename that misses one fails the suite rather than drifting silently.
pub(super) const SSH_KEY_ENV: &str = "SUNSTONE_GIT_SSH_KEY";
pub(super) const KNOWN_HOSTS_ENV: &str = "SUNSTONE_GIT_KNOWN_HOSTS";

/// §4.2 — write the ssh material for a git-synced deployment with an ssh-shaped
/// origin, then **remove the key from our own environment**.
///
/// 1. `SUNSTONE_GIT_SSH_KEY` must be set and must base64-decode to something
///    `ssh-keygen -y -f` accepts (see [`validate_ssh_key`]) — otherwise exit
///    naming the variable.
/// 2. Write [`crate::config::SSH_KEY_PATH`] at `0600`; owner is correct **by
///    construction** because our own uid creates it. Then
///    `std::env::remove_var(SUNSTONE_GIT_SSH_KEY)` so no git or ssh child
///    inherits the material. (Residual, accepted: `docker inspect` and the
///    initial `/proc/<pid>/environ` still expose it — the same place this
///    deployment's other secrets already sit.)
/// 3. `SUNSTONE_GIT_KNOWN_HOSTS` set ⇒ write the lines to
///    [`crate::config::KNOWN_HOSTS_PATH`] and use `StrictHostKeyChecking=yes`;
///    unset ⇒ `accept-new` against that same path.
///
/// A no-op in every other shape. This is the **only** place in the crate that
/// mutates the process environment.
pub fn write_ssh_material(cfg: &Config) -> Result<(), String> {
    // Not ssh-shaped ⇒ nothing to write and nothing to hide: an https origin
    // never spawns `ssh`, and git-local/plain never talk to a remote at all.
    // Checked before any filesystem call so those shapes never touch `/srv/ssh`.
    let Some(git) = cfg.git().filter(|git| git.origin_is_ssh()) else {
        return Ok(());
    };

    // 1. `config::parse` already reported a missing (`SshKeyRequired`) or
    //    undecodable (`SshKeyNotBase64`) key, so this is belt-and-braces — but
    //    it is checked before touching the filesystem, so the message an
    //    operator reads names the variable either way.
    let pem = git.ssh_key_pem.as_deref().ok_or_else(|| {
        format!(
            "{SSH_KEY_ENV} is required because SUNSTONE_GIT_ORIGIN is ssh-shaped. Set it to \
             the base64 of a passphrase-less private deploy key (`base64 -w0 < id_ed25519`), \
             or use an https origin."
        )
    })?;

    ensure_dir(Path::new(SSH_DIR), "the ssh material directory")?;

    // 2. `0600` and owned by us: ssh refuses a key file *we own* at anything
    //    looser (measured, ticket 11), so the mode is load-bearing rather than
    //    hygiene. No chown — our own uid creates the file.
    write_private_key(Path::new(SSH_KEY_PATH), pem)?;
    validate_ssh_key(Path::new(SSH_KEY_PATH))?;
    forget_ssh_key_var();

    // 3. Host-key trust: pin if set, TOFU otherwise (§4.2.3).
    match &git.known_hosts {
        Some(lines) => write_known_hosts(Path::new(KNOWN_HOSTS_PATH), lines)?,
        // `/srv/ssh` is **not** a volume, so an unpinned deployment re-trusts the
        // remote on first connect after every container recreate. That is
        // intended: `accept-new` is the zero-config bring-up path, and pinning
        // (which the live stack does) never TOFUs at all. The file is created
        // empty so `accept-new` has somewhere of ours to append to.
        None => touch(Path::new(KNOWN_HOSTS_PATH))?,
    }

    Ok(())
}

/// Whether the decoded PEM is a private key `ssh` will accept, checked with
/// `ssh-keygen -y -f <path>` (which derives the public key, so it both parses
/// the file and proves it is a private key). Catches a truncated or
/// passphrase-protected key at boot instead of mid-tick.
pub fn validate_ssh_key(key_path: &Path) -> Result<(), String> {
    // `-P ""` and a null stdin keep this non-interactive: without them an
    // encrypted key makes `ssh-keygen` prompt for a passphrase, and a boot that
    // blocks on a prompt is worse than one that fails.
    let output = Command::new("ssh-keygen")
        .arg("-y")
        .arg("-P")
        .arg("")
        .arg("-f")
        .arg(key_path)
        .stdin(Stdio::null())
        .output();

    let output = match output {
        Ok(output) => output,
        Err(_) => {
            // `ssh-keygen` absent: there is nothing to validate *against*.
            // Refusing to boot over a missing validator would be wrong — if
            // `ssh-keygen` is missing so is `ssh`, and the clone/fetch then
            // fails with git's own message.
            eprintln!(
                "sunstone-server: ssh-keygen is not on PATH — skipping the {SSH_KEY_ENV} check"
            );
            return Ok(());
        }
    };
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "{SSH_KEY_ENV} does not decode to a usable private key — ssh-keygen rejected \
         {}: {}. It must be the base64 of a **passphrase-less private key file** \
         (`base64 -w0 < id_ed25519`), not a public key and not an encrypted key.",
        key_path.display(),
        first_line(&output.stderr)
    ))
}

/// The `GIT_SSH_COMMAND` string (§3, ticket 11). Built **here**, not in
/// `git.rs`: that module is host-agnostic and shared with the desktop, so it
/// must never learn container paths.
///
/// `-i` + `IdentitiesOnly=yes` so no agent or default identity can be picked up
/// silently; no `~/.ssh` and no ssh config file — measured unnecessary, and a
/// config file on disk would apply to every later `ssh` an operator execs.
pub(super) fn ssh_command(git: &GitConfig) -> String {
    format!(
        "ssh -i {SSH_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking={} \
         -o UserKnownHostsFile={KNOWN_HOSTS_PATH}",
        git.strict_host_key_checking()
    )
}

/// Write the private key at `0600` in one shot.
///
/// The mode is set at **creation** (so the material is never briefly readable by
/// others) and again afterwards, which covers a file that already existed with a
/// looser mode. Measured (ticket 11): a key file *we own* is refused by ssh at
/// anything looser than `0600`.
fn write_private_key(path: &Path, pem: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .map_err(|e| format!("could not write the deploy key to {}: {e}", path.display()))?;
    file.write_all(pem)
        .and_then(|()| {
            // OpenSSH's parser wants the PEM's final newline; `base64 -w0 <
            // id_ed25519` carries it, a hand-trimmed paste may not.
            if pem.last() == Some(&b'\n') {
                Ok(())
            } else {
                file.write_all(b"\n")
            }
        })
        .map_err(|e| format!("could not write the deploy key to {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| {
            format!(
                "could not set mode 0600 on {}: {e} — ssh refuses a key file we own at a looser \
                 mode.",
                path.display()
            )
        })?;
    }
    Ok(())
}

/// Write the pinned `ssh-keyscan` lines, newline-terminated (an unterminated
/// final line is not a host-key entry ssh will match).
fn write_known_hosts(path: &Path, lines: &str) -> Result<(), String> {
    let mut body = lines.to_string();
    if !body.ends_with('\n') {
        body.push('\n');
    }
    fs::write(path, body).map_err(|e| {
        format!(
            "could not write {KNOWN_HOSTS_ENV} to {}: {e}",
            path.display()
        )
    })
}

/// Drop `SUNSTONE_GIT_SSH_KEY` from our own environment (§4.2.2), so no git or
/// ssh child inherits the key material — `GIT_SSH_COMMAND` hands ssh the key by
/// *path*, and the bytes have no business in any child's environment.
///
/// SAFETY: `remove_var` requires that no other thread reads or writes the
/// environment concurrently. Verified against `main.rs`: this runs from the
/// boot sequence at the top of `main`, on the main thread — *before*
/// `watcher::start` spawns its notify thread, before the sync loop's
/// `tokio::spawn`, and before `axum::serve`, so no thread of ours exists that
/// could observe the environment. (`#[tokio::main]` has already built the
/// runtime, but its worker threads are parked and no code in this binary reads
/// `std::env` off the main thread at all; `main`'s own later reads —
/// `SUNSTONE_API_PORT`, the JWT secret — are on this same thread.) It is also
/// the crate's **only** environment mutation, by design: `config::parse` is pure.
///
/// The `unsafe` block documents that contract for edition 2024, where
/// `remove_var` carries the marker; this crate is still edition 2021, where the
/// call is safe — hence the `unused_unsafe` allow rather than a cfg dance.
#[allow(unused_unsafe)]
fn forget_ssh_key_var() {
    unsafe {
        std::env::remove_var(SSH_KEY_ENV);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::tests::{git_config, git_shaped};
    use crate::testutil::temp_dir;

    fn ssh_keygen_available() -> bool {
        // Spawnability is the whole question; `-h` exits non-zero with a usage
        // banner, which is fine.
        Command::new("ssh-keygen").arg("-h").output().is_ok()
    }

    // --- §4.2 the ssh material ----------------------------------------------

    #[test]
    fn the_ssh_command_is_exact_for_both_strict_settings() {
        let mut git = git_config("main", Some("git@example.com:org/wiki.git"));

        // Unpinned: TOFU against the same (non-persistent) path.
        assert_eq!(
            ssh_command(&git),
            "ssh -i /srv/ssh/id_ed25519 -o IdentitiesOnly=yes \
             -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/srv/ssh/known_hosts"
        );

        // Pinned via SUNSTONE_GIT_KNOWN_HOSTS: strict.
        git.known_hosts = Some("example.com ssh-ed25519 AAAA...".to_string());
        assert_eq!(
            ssh_command(&git),
            "ssh -i /srv/ssh/id_ed25519 -o IdentitiesOnly=yes \
             -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/srv/ssh/known_hosts"
        );
    }

    #[test]
    fn an_unusable_key_is_rejected_naming_the_variable() {
        if !ssh_keygen_available() {
            return;
        }
        let dir = temp_dir("bad-key");
        let key = dir.join("id_ed25519");
        // Decodes fine (so `config::parse` passed it) but is not a private key —
        // exactly the case that would otherwise surface as a *sync* error deep
        // in the first loop tick.
        write_private_key(&key, b"-----BEGIN OPENSSH PRIVATE KEY-----\nnot really\n").unwrap();
        let err = validate_ssh_key(&key).unwrap_err();
        assert!(err.contains(SSH_KEY_ENV), "must name the variable: {err}");
        assert!(err.contains("base64 -w0 < id_ed25519"), "must name the fix: {err}");
    }

    #[test]
    fn a_real_passphrase_less_key_is_accepted() {
        if !ssh_keygen_available() {
            return;
        }
        let dir = temp_dir("good-key");
        let generated = dir.join("generated");
        let out = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", ""])
            .arg("-f")
            .arg(&generated)
            .output()
            .unwrap();
        assert!(out.status.success(), "ssh-keygen failed: {out:?}");

        // Round-trip through our own writer, mode included.
        let key = dir.join("id_ed25519");
        write_private_key(&key, &fs::read(&generated).unwrap()).unwrap();
        assert!(validate_ssh_key(&key).is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&key).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "ssh refuses a key we own at a looser mode");
        }
    }

    #[test]
    fn a_missing_key_variable_is_reported_before_anything_is_written() {
        // ssh-shaped origin with no key: `config::parse` catches this first, but
        // the boot message must name the variable too — and must not reach
        // `/srv/ssh` (this test would fail if it did).
        let repo = temp_dir("ssh-nokey");
        let cfg = git_shaped(&repo, "", Some("git@example.com:org/wiki.git"));
        let err = write_ssh_material(&cfg).unwrap_err();
        assert!(err.contains(SSH_KEY_ENV), "{err}");
        assert!(!Path::new(SSH_KEY_PATH).exists());
    }

    #[test]
    fn a_non_ssh_shape_writes_no_ssh_material() {
        // Each of these must return before touching `/srv/ssh` — which is also
        // what makes the assertion below safe on a dev machine.
        let repo = temp_dir("ssh-noop");
        for cfg in [
            git_shaped(&repo, "", Some("https://example.com/org/wiki.git")),
            git_shaped(&repo, "", None),
            Config::plain(repo.clone()),
        ] {
            assert!(write_ssh_material(&cfg).is_ok());
        }
        assert!(!Path::new(SSH_KEY_PATH).exists());
    }

    #[test]
    fn spelled_env_names_are_in_configs_closed_set() {
        // `config` keeps its per-key constants private, so these two are spelled
        // again in this module; a rename must not drift (§2.2's namespace is
        // closed, so an unrecognised name is a boot error).
        for name in [SSH_KEY_ENV, KNOWN_HOSTS_ENV] {
            assert!(
                crate::config::KNOWN_GIT_VARS.contains(&name),
                "{name} is not in config::KNOWN_GIT_VARS"
            );
        }
    }
}
