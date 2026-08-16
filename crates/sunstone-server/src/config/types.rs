//! The parsed configuration types: the deployment [`Shape`], the git family
//! ([`GitConfig`]) and the whole surface ([`Config`]).

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use sunstone_native::git::CommitIdentity;

// --- Shape ------------------------------------------------------------------

/// The deployment shape (Spec 1 §1), derived from the presence gate. Serialized
/// as `plain` / `git-local` / `git-synced` for `GET /api/sync-status` (§10.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Shape {
    /// No `SUNSTONE_GIT_*` at all. Bundle root is `SUNSTONE_BUNDLE`; Save
    /// writes the file and runs **no git whatsoever** (§5, §11.1).
    Plain,
    /// `SUNSTONE_GIT_BRANCH` only. Commits locally, never pushes, no loop.
    GitLocal,
    /// Branch + origin (+ key for an ssh origin). Runs the fetch → rebase →
    /// push loop (§8).
    GitSynced,
}

impl Shape {
    /// Whether git runs at all. The plain shape's *whole* feature is that it
    /// does not (read side §11.1, write side §5).
    pub fn is_git(self) -> bool {
        matches!(self, Shape::GitLocal | Shape::GitSynced)
    }

    /// Whether the sync loop is spawned (§4.7 — git-synced only).
    pub fn syncs(self) -> bool {
        matches!(self, Shape::GitSynced)
    }

    /// The wire/log spelling, identical to the serde rename.
    pub fn as_str(self) -> &'static str {
        match self {
            Shape::Plain => "plain",
            Shape::GitLocal => "git-local",
            Shape::GitSynced => "git-synced",
        }
    }
}

// --- The git family ---------------------------------------------------------

/// The `SUNSTONE_GIT_*` family, present exactly in the two git shapes. Every
/// entry is strict (§2.3): the parse either produced a usable value or a
/// [`crate::config::ConfigError`].
#[derive(Debug, Clone)]
pub struct GitConfig {
    /// `SUNSTONE_GIT_BRANCH` — **required**, no default. Does four jobs: clone
    /// `--branch`, rebase target `origin/<branch>`, push target, and
    /// `init --initial-branch`.
    pub branch: String,
    /// `SUNSTONE_GIT_ORIGIN` — unset ⇒ [`Shape::GitLocal`]. An **opaque**
    /// string passed to `git clone`; the *one* inspection ever made of it is
    /// [`is_ssh_shaped`], which gates the key requirement.
    pub origin: Option<String>,
    /// `SUNSTONE_GIT_BUNDLE_SUBDIR` — repo-relative, forward-slash, `""` for
    /// the repo root. Absolute or containing `..` ⇒ boot error, which is what
    /// makes [`Config::bundle_root`] contained **by construction** (§4.5).
    pub bundle_subdir: String,
    /// `SUNSTONE_GIT_SYNC_INTERVAL_SECS` (default
    /// [`crate::config::DEFAULT_SYNC_INTERVAL_SECS`]). Unparseable or `0` ⇒
    /// boot error: `0` would add a shape absent from §2.1's table; the escape
    /// hatch is a large interval.
    pub sync_interval: Duration,
    /// `SUNSTONE_GIT_SYNC_NAME` / `_EMAIL`. The loop's **committer** identity,
    /// and the author *only* of the git-local seed commit (§4.4) — the one
    /// thing it ever authors, since no OIDC user exists at boot.
    pub sync_identity: CommitIdentity,
    /// `SUNSTONE_GIT_SSH_KEY`, base64-decoded to the private PEM. Undecodable
    /// ⇒ boot error. Required when [`GitConfig::origin_is_ssh`].
    pub ssh_key_pem: Option<Vec<u8>>,
    /// `SUNSTONE_GIT_KNOWN_HOSTS` — `ssh-keyscan` lines. Set ⇒ strict host-key
    /// checking; unset ⇒ `accept-new` against the same (non-persistent) path.
    pub known_hosts: Option<String>,
}

impl GitConfig {
    /// The single inspection of the origin string (§2.3, Spec 1 §7): whether it
    /// is ssh-shaped, and therefore requires a deploy key.
    pub fn origin_is_ssh(&self) -> bool {
        self.origin.as_deref().is_some_and(is_ssh_shaped)
    }

    /// `StrictHostKeyChecking` value for `GIT_SSH_COMMAND`: `yes` when host
    /// keys are pinned via `SUNSTONE_GIT_KNOWN_HOSTS`, else `accept-new`
    /// (§4.2.3 — unpinned means re-trust on first connect after every
    /// recreate, since `/srv/ssh` is not a volume).
    pub fn strict_host_key_checking(&self) -> &'static str {
        if self.known_hosts.is_some() {
            "yes"
        } else {
            "accept-new"
        }
    }

    /// `origin/<branch>` — the rebase and `rev-list` counterpart ref (§8.2).
    pub fn upstream_ref(&self) -> String {
        format!("origin/{}", self.branch)
    }
}

/// Whether `origin` is ssh-shaped, i.e. git will shell out to `ssh` for it:
/// an `ssh://` URL or the `user@host:path` scp-like form. **Pure** — the only
/// inspection this codebase ever makes of the origin string, so relocating
/// origin to another forge changes nothing else (Spec 1 §7).
pub fn is_ssh_shaped(origin: &str) -> bool {
    let origin = origin.trim();

    // An explicit scheme settles it: only ssh (and git's `git+ssh` alias) shells
    // out to `ssh`. `https://`, `http://`, `git://` and `file://` do not.
    if let Some((scheme, _)) = origin.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        return scheme == "ssh" || scheme == "git+ssh";
    }

    // Otherwise git's scp-like rule: a `:` appearing before any `/` makes it
    // `[user@]host:path`. A bare local path (`/srv/repo`, `../x`) has no colon,
    // or has one only after a slash.
    let Some((host, _)) = origin.split_once(':') else {
        return false;
    };
    // A single-character "host" is a Windows drive letter (`C:\repos\wiki`), the
    // one form git itself excludes from the scp-like rule.
    !host.is_empty() && !host.contains('/') && host.chars().count() > 1
}

// --- The parsed surface -----------------------------------------------------

/// The whole environment surface the Rust server reads, git and pre-existing
/// alike, resolved once at boot.
#[derive(Debug, Clone)]
pub struct Config {
    /// The deployment shape from §2.1's presence gate.
    pub shape: Shape,
    /// The git family — `Some` in both git shapes, `None` in the plain shape.
    pub git: Option<GitConfig>,
    /// The repository root: `Some(`[`crate::config::REPO_DIR`]`)` in a git
    /// shape, `None` in the plain shape. Git runs **here**, not at the bundle
    /// root, so a rebase covers the whole repo even for a subdir bundle.
    pub repo_root: Option<PathBuf>,
    /// The resolved bundle root the index, watcher and write path use (§4.5):
    /// [`crate::config::REPO_DIR`] joined with `SUNSTONE_GIT_BUNDLE_SUBDIR` in
    /// a git shape, `SUNSTONE_BUNDLE` (or the dev default) in the plain shape.
    /// The join is pure and unit-testable; canonicalization happens in
    /// [`crate::boot`].
    pub bundle_root: PathBuf,
    /// `SUNSTONE_BUNDLE_SEED_FROM` — contents copied into [`Self::bundle_root`]
    /// before any git step (§4.3). Set **plus** an origin is a boot error.
    pub seed_from: Option<PathBuf>,
    /// `SUNSTONE_JWT_SECRET`. `None` ⇒ writes 401 **and** history is
    /// unavailable (§11) — with no auth provider wired there is no way to tell
    /// a viewer from a visitor.
    pub jwt_secret: Option<Vec<u8>>,
    /// `SUNSTONE_API_PORT`, lenient: unparseable ⇒ [`crate::DEFAULT_PORT`].
    pub api_port: u16,
    /// Non-fatal observations to print at boot (§2.4's log-and-ignore case).
    pub warnings: Vec<super::ConfigWarning>,
}

impl Config {
    /// A [`Shape::Plain`] config over `bundle_root`, with writes disabled.
    ///
    /// The trivially-correct plain config every module's tests build on;
    /// `main()` itself goes through [`crate::config::parse_env`] +
    /// [`crate::boot::run`].
    #[allow(dead_code)] // the trivially-correct plain config every module's tests build on
    pub fn plain(bundle_root: PathBuf) -> Config {
        Config {
            shape: Shape::Plain,
            git: None,
            repo_root: None,
            bundle_root,
            seed_from: None,
            jwt_secret: None,
            api_port: crate::DEFAULT_PORT,
            warnings: Vec::new(),
        }
    }

    /// Whether git runs at all — the read-side (§11.1) and write-side (§5)
    /// short-circuits both key off this.
    pub fn is_git(&self) -> bool {
        self.shape.is_git()
    }

    /// The git family, or `None` in the plain shape.
    pub fn git(&self) -> Option<&GitConfig> {
        self.git.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- The one origin inspection (§2.3, Spec 1 §7) -------------------------

    #[test]
    fn ssh_shaped_origins_are_recognised() {
        for origin in [
            "ssh://git@example.com/acme/wiki.git",
            "SSH://git@example.com/acme/wiki.git",
            "git+ssh://git@example.com/acme/wiki.git",
            "git@example.com:acme/wiki.git",
            "git@example.com:2222/acme/wiki.git",
            "example.com:acme/wiki.git",
            " git@example.com:acme/wiki.git ",
        ] {
            assert!(is_ssh_shaped(origin), "{origin} should be ssh-shaped");
        }
    }

    #[test]
    fn non_ssh_origins_are_not_ssh_shaped() {
        for origin in [
            "https://example.com/acme/wiki.git",
            "http://example.com/acme/wiki.git",
            "git://example.com/acme/wiki.git",
            "file:///srv/mirror/wiki.git",
            "/srv/mirror/wiki.git",
            "../mirror/wiki.git",
            "C:\\repos\\wiki",
            "",
        ] {
            assert!(!is_ssh_shaped(origin), "{origin} should not be ssh-shaped");
        }
    }

    // --- Surface bookkeeping ------------------------------------------------

    #[test]
    fn shape_serializes_kebab_case() {
        assert_eq!(Shape::Plain.as_str(), "plain");
        assert_eq!(Shape::GitLocal.as_str(), "git-local");
        assert_eq!(Shape::GitSynced.as_str(), "git-synced");
        for shape in [Shape::Plain, Shape::GitLocal, Shape::GitSynced] {
            assert_eq!(
                serde_json::to_string(&shape).unwrap(),
                format!("\"{}\"", shape.as_str())
            );
        }
    }
}
