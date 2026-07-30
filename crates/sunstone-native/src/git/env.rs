//! Process-global git environment injection (Spec 2 §3).
//!
//! This module is host-agnostic and shared with the desktop, so it must not learn
//! container paths. Instead the *server* sets a process-global environment once at
//! boot; this module only knows how to apply it.

use std::process::Command;
use std::sync::OnceLock;

use super::CommitIdentity;

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
/// `run_git` and `run_git_env` apply, so there is deliberately no second
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
pub(super) fn apply_git_env(cmd: &mut Command) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
            committer: Some(CommitIdentity {
                name: "Sunstone Sync".to_string(),
                email: "sync@sunstone.invalid".to_string(),
            }),
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
}
