//! One **pure** parse of the whole environment surface, done once at boot
//! (Spec 2 §2).
//!
//! `main()` passes `|k| std::env::var(k).ok()`; the resulting [`Config`] is
//! stored in `ServerState`, so neither the sync loop nor the write path ever
//! re-reads the environment. Three reasons, by weight (ticket 12):
//!
//! 1. **Fail fast, once.** Every problem is reported together as a
//!    `Vec<ConfigError>` — one crash-loop for N typos rather than N.
//! 2. **Testability**, per CLAUDE.md's pure-logic convention: every rule,
//!    default and the subdir join is unit-testable over a `HashMap`, with no
//!    `std::env` mutation (`set_var` is `unsafe` in edition 2024 and flaky
//!    under `cargo test`'s threads).
//! 3. The loop takes `&Config`.
//!
//! **This module must stay pure**: no `std::env`, no filesystem, no `git`. The
//! filesystem consequences of a `Config` (writing ssh material, cloning,
//! probing writability) all live in [`crate::boot`].
//!
//! # The gate (§2.1)
//!
//! The deployment [`Shape`] is derived from the **presence** of any
//! `SUNSTONE_GIT_*` variable — there is no mode flag:
//!
//! | any `SUNSTONE_GIT_*` | `_BRANCH` | `_ORIGIN` | Shape |
//! | --- | --- | --- | --- |
//! | no | — | — | [`Shape::Plain`] |
//! | yes | **unset** | — | boot error ([`ConfigError::GitBranchRequired`]) |
//! | yes | set | unset | [`Shape::GitLocal`] |
//! | yes | set | set | [`Shape::GitSynced`] |
//!
//! # The namespace is closed (§2.2)
//!
//! An **unrecognised** `SUNSTONE_GIT_*` variable is a boot error. That is what
//! catches a typo'd `SUNSTONE_GIT_ORGIN=…` and — load-bearing — turns a stale
//! sidecar env file still carrying `SUNSTONE_GIT_REPO` / `_REF` / `_PERIOD`
//! into a *caught migration* rather than a wiki that quietly serves un-synced
//! content.
//!
//! # Strictness (§2.4)
//!
//! Every git variable is **strict**: malformed ⇒ refuse to boot. Pre-existing
//! variables keep their current **leniency** (`SUNSTONE_API_PORT=banana` still
//! falls back to the default) — knowingly inconsistent, because making them
//! fatal would be a behaviour change for deployments that exist today.
//!
//! The one *log-and-ignore* case is [`ConfigWarning::BundleIgnoredInGitShape`]:
//! `SUNSTONE_BUNDLE` is baked into the image ENV, so an operator's override is
//! indistinguishable from the image default. That is the whole line: log-and-
//! ignore applies **only** where a value cannot be told apart from an image
//! default; everything else fails.
//!
//! # Not read here
//!
//! `SUNSTONE_API_INTERNAL`, `HOST` and `PORT` belong to the **Node SSR
//! process**, not to this binary, and `SUNSTONE_UID` / `SUNSTONE_GID` /
//! `SUNSTONE_WEB_PORT` / `SUNSTONE_BUNDLE_HOST` / `SUNSTONE_OIDC_*` /
//! `SUNSTONE_TEST_AUTH*` are read by compose, the entrypoint or the hook. They
//! are named here so the surface is accounted for, and deliberately have no
//! field: this struct is what the *Rust server* reads.
//!
//! **Deleted** (must not reappear): `SUNSTONE_GIT_MODE` (never shipped),
//! `SUNSTONE_SEED_COMMIT_NAME` / `_EMAIL` (subsumed by the sync identity).

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
    Engine,
};
use serde::Serialize;
use sunstone_native::git::CommitIdentity;

// --- Constants, not env (§2.3) ----------------------------------------------
//
// `/srv/repo` and `/srv/ssh` both exist in the image chowned to `node`, so an
// env var could only ever carry "the one correct value" or "broken at boot"
// (ticket 10). A volume mounted at a path *absent* from the image is created
// `root:root` and uid 1000 cannot write it.

/// The clone. A named volume in the git-synced stack; plain container
/// filesystem in the git-local dev stack.
pub const REPO_DIR: &str = "/srv/repo";

/// The deploy key + `known_hosts`. **Never** a volume — it dies with the
/// container and is rewritten from env on every boot.
pub const SSH_DIR: &str = "/srv/ssh";

/// Where [`crate::boot::write_ssh_material`] writes the decoded private key
/// (mode `0600`, owner correct by construction since our own uid creates it).
pub const SSH_KEY_PATH: &str = "/srv/ssh/id_ed25519";

/// `UserKnownHostsFile`: written from `SUNSTONE_GIT_KNOWN_HOSTS` when set
/// (⇒ `StrictHostKeyChecking=yes`), otherwise the `accept-new` TOFU target.
pub const KNOWN_HOSTS_PATH: &str = "/srv/ssh/known_hosts";

/// Prefix whose mere presence selects a git shape (§2.1) and whose unknown
/// members are a boot error (§2.2).
pub const GIT_VAR_PREFIX: &str = "SUNSTONE_GIT_";

/// The **closed** set of recognised `SUNSTONE_GIT_*` variables (§2.2). Any
/// other `SUNSTONE_GIT_*` key is [`ConfigError::UnknownGitVar`].
pub const KNOWN_GIT_VARS: &[&str] = &[
    "SUNSTONE_GIT_BRANCH",
    "SUNSTONE_GIT_ORIGIN",
    "SUNSTONE_GIT_BUNDLE_SUBDIR",
    "SUNSTONE_GIT_SYNC_INTERVAL_SECS",
    "SUNSTONE_GIT_SYNC_NAME",
    "SUNSTONE_GIT_SYNC_EMAIL",
    "SUNSTONE_GIT_SSH_KEY",
    "SUNSTONE_GIT_KNOWN_HOSTS",
];

/// Bundle root in the plain shape (lenient; empty ⇒ unset ⇒ the dev default).
pub const BUNDLE_ENV: &str = "SUNSTONE_BUNDLE";

/// Optional seed source copied into the resolved bundle root before any git
/// step (§4.3). Plus an origin ⇒ boot error.
pub const SEED_FROM_ENV: &str = "SUNSTONE_BUNDLE_SEED_FROM";

/// Inbound poll period default. Saves kick the loop, so this governs *inbound*
/// latency only (§8.1).
pub const DEFAULT_SYNC_INTERVAL_SECS: u64 = 10;

/// Default sync committer name (`SUNSTONE_GIT_SYNC_NAME`).
pub const DEFAULT_SYNC_NAME: &str = "Sunstone Sync";

/// Default sync committer email (`SUNSTONE_GIT_SYNC_EMAIL`).
pub const DEFAULT_SYNC_EMAIL: &str = "sync@sunstone.invalid";

// Individual git keys. Spelled once each here and asserted against the closed
// [`KNOWN_GIT_VARS`] set by `known_vars_match_the_read_sites`, so a key that is
// recognised but never read (or vice versa) fails the test suite.
const BRANCH_ENV: &str = "SUNSTONE_GIT_BRANCH";
const ORIGIN_ENV: &str = "SUNSTONE_GIT_ORIGIN";
const SUBDIR_ENV: &str = "SUNSTONE_GIT_BUNDLE_SUBDIR";
const INTERVAL_ENV: &str = "SUNSTONE_GIT_SYNC_INTERVAL_SECS";
const SYNC_NAME_ENV: &str = "SUNSTONE_GIT_SYNC_NAME";
const SYNC_EMAIL_ENV: &str = "SUNSTONE_GIT_SYNC_EMAIL";
const SSH_KEY_ENV: &str = "SUNSTONE_GIT_SSH_KEY";
const KNOWN_HOSTS_ENV: &str = "SUNSTONE_GIT_KNOWN_HOSTS";

/// `SUNSTONE_API_PORT` — lenient (§2.3): unparseable ⇒ [`crate::DEFAULT_PORT`].
const API_PORT_ENV: &str = "SUNSTONE_API_PORT";

/// base64 for `SUNSTONE_GIT_SSH_KEY`: the standard alphabet, **indifferent** to
/// padding so both `base64 -w0` output and an unpadded paste decode. Strict
/// about the alphabet itself — that is what [`ConfigError::SshKeyNotBase64`]
/// catches. (`base64` is already a direct dependency of this crate, used by
/// [`crate::auth`] for JWTs; nothing new was added.)
const SSH_KEY_B64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

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
/// [`ConfigError`].
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
    /// [`DEFAULT_SYNC_INTERVAL_SECS`]). Unparseable or `0` ⇒ boot error: `0`
    /// would add a shape absent from §2.1's table; the escape hatch is a large
    /// interval.
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
    /// The repository root: `Some(`[`REPO_DIR`]`)` in a git shape, `None` in
    /// the plain shape. Git runs **here**, not at the bundle root, so a
    /// rebase covers the whole repo even for a subdir bundle.
    pub repo_root: Option<PathBuf>,
    /// The resolved bundle root the index, watcher and write path use (§4.5):
    /// [`REPO_DIR`] joined with `SUNSTONE_GIT_BUNDLE_SUBDIR` in a git shape,
    /// `SUNSTONE_BUNDLE` (or the dev default) in the plain shape. The join is
    /// pure and unit-testable; canonicalization happens in [`crate::boot`].
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
    pub warnings: Vec<ConfigWarning>,
}

impl Config {
    /// A [`Shape::Plain`] config over `bundle_root`, with writes disabled.
    ///
    /// The trivially-correct plain config every module's tests build on;
    /// `main()` itself goes through [`parse_env`] + [`crate::boot::run`].
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

/// A non-fatal configuration observation, printed at boot. Deliberately a
/// closed enum: §2.4's line is that log-and-ignore applies **only** where a
/// value cannot be distinguished from an image default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigWarning {
    /// `SUNSTONE_BUNDLE` set in a git shape, where the bundle root is
    /// repo-relative. Not fatal because `Dockerfile` bakes
    /// `SUNSTONE_BUNDLE=/bundle` into the image ENV, so an operator's override
    /// is indistinguishable from the image's default.
    BundleIgnoredInGitShape { value: String },
}

/// Renders the message **body only** — no `sunstone-server: ` prefix, so the
/// caller keeps the crate's existing `eprintln!("sunstone-server: {w}")` idiom
/// and the text also composes into other messages.
impl fmt::Display for ConfigWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigWarning::BundleIgnoredInGitShape { value } => write!(
                f,
                "{BUNDLE_ENV}={value} is ignored in a git shape — the bundle root is \
                 {REPO_DIR} joined with {SUBDIR_ENV}. Nothing to do if you did not set it: \
                 the image bakes {BUNDLE_ENV}=/bundle into its ENV."
            ),
        }
    }
}

/// One reason the configuration refuses to boot. [`parse`] returns **every**
/// error it found, so N typos cost one crash-loop rather than N.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// A `SUNSTONE_GIT_*` variable is set but `SUNSTONE_GIT_BRANCH` is not
    /// (§2.1). No default — a default would contradict omission meaning off.
    GitBranchRequired,
    /// An unrecognised `SUNSTONE_GIT_*` variable (§2.2) — a typo, or a stale
    /// sidecar env file carrying the retired `SUNSTONE_GIT_REPO` / `_REF` /
    /// `_PERIOD` / `_MODE`.
    UnknownGitVar { name: String },
    /// `SUNSTONE_GIT_BUNDLE_SUBDIR` is absolute or contains a `..` segment.
    /// Rejecting here is what removes boot-time containment validation
    /// downstream (§4.5).
    BundleSubdirEscapes { value: String },
    /// `SUNSTONE_GIT_SYNC_INTERVAL_SECS` is unparseable or `0`.
    BadSyncInterval { value: String },
    /// The origin is ssh-shaped but `SUNSTONE_GIT_SSH_KEY` is unset. Caught
    /// here rather than deep in the first loop tick, where ticket 13 would
    /// report a *sync error* for what is a misconfiguration.
    SshKeyRequired,
    /// `SUNSTONE_GIT_SSH_KEY` is not valid base64.
    SshKeyNotBase64,
    /// `SUNSTONE_BUNDLE_SEED_FROM` together with an origin: you cannot seed a
    /// clone, and `git clone` requires an empty target. Fatal rather than
    /// log-and-ignore because this var has no baked image default, so its
    /// presence is always an explicit operator act (§2.4, §4.3).
    SeedWithOrigin { seed: String },
}

/// Every message names the offending **variable** and the fix — this is what an
/// operator reads in `docker logs` immediately before the container exits, and
/// under `restart: unless-stopped` it is the only artefact of the crash loop.
///
/// Like [`ConfigWarning`], the body carries no `sunstone-server: ` prefix; the
/// caller adds it.
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::GitBranchRequired => write!(
                f,
                "{BRANCH_ENV} is required as soon as any {GIT_VAR_PREFIX}* variable is set, \
                 and has no default. Set it to the branch to track (e.g. {BRANCH_ENV}=main), \
                 or unset every {GIT_VAR_PREFIX}* variable to run the plain shape."
            ),
            ConfigError::UnknownGitVar { name } => write!(
                f,
                "{name} is not a recognised variable and the {GIT_VAR_PREFIX}* namespace is \
                 closed. Check the spelling; the recognised names are {}. \
                 (SUNSTONE_GIT_REPO, SUNSTONE_GIT_REF, SUNSTONE_GIT_PERIOD and \
                 SUNSTONE_GIT_MODE are retired — the server now owns the sync loop, so a \
                 sidecar env file carrying them must be migrated.)",
                KNOWN_GIT_VARS.join(", ")
            ),
            ConfigError::BundleSubdirEscapes { value } => write!(
                f,
                "{SUBDIR_ENV}={value} must be a repository-relative forward-slash path: it may \
                 not be absolute and may not contain a `..` segment. Use an empty value (or \
                 unset it) for the repository root, or e.g. {SUBDIR_ENV}=docs."
            ),
            ConfigError::BadSyncInterval { value } => write!(
                f,
                "{INTERVAL_ENV}={value} must be a whole number of seconds greater than zero \
                 (default {DEFAULT_SYNC_INTERVAL_SECS}). Zero is not a way to stop polling — \
                 use a large interval instead; outbound saves are pushed immediately either way."
            ),
            ConfigError::SshKeyRequired => write!(
                f,
                "{ORIGIN_ENV} is ssh-shaped, so {SSH_KEY_ENV} is required. Set it to the \
                 base64 of a passphrase-less private deploy key \
                 (`base64 -w0 < id_ed25519`), or use an https origin."
            ),
            ConfigError::SshKeyNotBase64 => write!(
                f,
                "{SSH_KEY_ENV} is not valid base64. It must be the base64 encoding of the \
                 private key **file**, not the key itself: `base64 -w0 < id_ed25519`."
            ),
            ConfigError::SeedWithOrigin { seed } => write!(
                f,
                "{SEED_FROM_ENV}={seed} cannot be combined with {ORIGIN_ENV}: `git clone` \
                 requires an empty target, so a clone cannot be seeded. Unset {SEED_FROM_ENV} \
                 to clone from the origin, or unset {ORIGIN_ENV} to seed a local repository."
            ),
        }
    }
}

// --- The parse --------------------------------------------------------------

/// Parse the environment surface (Spec 2 §2). `get` answers for any key; an
/// **empty value means unset**, uniformly (§2.3), so a blank line in an env
/// file means "default".
///
/// This entry point cannot see *unrecognised* `SUNSTONE_GIT_*` keys — a
/// key-lookup function has no enumeration — so it enforces §2.2 over the
/// closed [`KNOWN_GIT_VARS`] set only. `main()` calls [`parse_env`], which
/// takes the present key names too; unit tests over a `HashMap` can use either.
#[cfg(test)] // the `HashMap`-friendly entry point for tests; `main()` calls `parse_env`
pub fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Config, Vec<ConfigError>> {
    parse_env(KNOWN_GIT_VARS.iter().map(|s| s.to_string()), get)
}

/// [`parse`] plus §2.2's closed-namespace check over the **present** env keys.
///
/// `names` is every key in the environment (only `SUNSTONE_GIT_*` ones are
/// inspected); `get` reads a value. `main()` calls
/// `parse_env(std::env::vars().map(|(k, _)| k), |k| std::env::var(k).ok())`.
/// Still pure: it touches neither `std::env` nor the filesystem itself.
pub fn parse_env(
    names: impl IntoIterator<Item = String>,
    get: impl Fn(&str) -> Option<String>,
) -> Result<Config, Vec<ConfigError>> {
    // Nothing short-circuits: every rule below *pushes* and carries on, so N
    // typos cost one crash-loop rather than N (§2).
    let mut errors: Vec<ConfigError> = Vec::new();
    let mut warnings: Vec<ConfigWarning> = Vec::new();

    // --- The gate (§2.1) + the closed namespace (§2.2) ----------------------
    //
    // One prefix scan does both jobs. Sorted so the error list is stable
    // regardless of how the caller enumerates the environment (a `HashMap` in
    // tests, `std::env::vars()` in `main`).
    let mut git_names: Vec<String> = names
        .into_iter()
        .filter(|n| n.starts_with(GIT_VAR_PREFIX))
        .collect();
    git_names.sort();
    git_names.dedup();

    let mut any_git_var = false;
    for name in git_names {
        // `VAR=` is unset (§2.3), so it neither trips the gate nor — for an
        // unrecognised name — is an error: a blank line in an env file means
        // "default", uniformly.
        if non_empty(&get, &name).is_none() {
            continue;
        }
        if KNOWN_GIT_VARS.contains(&name.as_str()) {
            any_git_var = true;
        } else {
            // Deliberately does *not* trip the gate: a stale sidecar env file
            // carrying only retired names reports exactly its own problem,
            // rather than that plus a spurious "branch required".
            errors.push(ConfigError::UnknownGitVar { name });
        }
    }

    let branch = non_empty(&get, BRANCH_ENV);
    let origin = non_empty(&get, ORIGIN_ENV);

    // --- The git family (§2.3) — strict, and validated even when the branch is
    // missing, so one boot reports every git problem at once ------------------
    let mut subdir = String::new();
    let mut git: Option<GitConfig> = None;
    let mut shape = Shape::Plain;

    if any_git_var {
        subdir = non_empty(&get, SUBDIR_ENV).unwrap_or_default();
        if subdir_escapes(&subdir) {
            errors.push(ConfigError::BundleSubdirEscapes {
                value: subdir.clone(),
            });
            // Do not join an escaping value into the bundle root; §4.5's
            // by-construction containment assumes this error already fired.
            subdir = String::new();
        }

        let sync_interval = match non_empty(&get, INTERVAL_ENV) {
            None => Duration::from_secs(DEFAULT_SYNC_INTERVAL_SECS),
            Some(value) => match value.parse::<u64>() {
                Ok(secs) if secs > 0 => Duration::from_secs(secs),
                // `0` would add a shape absent from §2.1's table.
                _ => {
                    errors.push(ConfigError::BadSyncInterval { value });
                    Duration::from_secs(DEFAULT_SYNC_INTERVAL_SECS)
                }
            },
        };

        let raw_key = non_empty(&get, SSH_KEY_ENV);
        let ssh_key_pem = match &raw_key {
            None => None,
            // Whitespace is stripped first: a key pasted across lines is still
            // the operator's clear intent, and stripping cannot make an invalid
            // alphabet valid.
            Some(value) => match SSH_KEY_B64.decode(strip_whitespace(value)) {
                Ok(pem) => Some(pem),
                Err(_) => {
                    errors.push(ConfigError::SshKeyNotBase64);
                    None
                }
            },
        };

        // The *one* inspection of the origin string ever made (§2.3). Keyed off
        // presence of the variable, not off `ssh_key_pem`, so an undecodable key
        // reports `SshKeyNotBase64` alone rather than that plus a misleading
        // `SshKeyRequired`.
        if origin.as_deref().is_some_and(is_ssh_shaped) && raw_key.is_none() {
            errors.push(ConfigError::SshKeyRequired);
        }

        shape = if origin.is_some() {
            Shape::GitSynced
        } else {
            Shape::GitLocal
        };

        // No branch ⇒ no usable git family; `GitBranchRequired` is already in
        // `errors`, so the `Err` return below is guaranteed.
        match branch {
            Some(branch) => {
                git = Some(GitConfig {
                    branch,
                    origin: origin.clone(),
                    bundle_subdir: subdir.clone(),
                    sync_interval,
                    sync_identity: CommitIdentity {
                        name: non_empty(&get, SYNC_NAME_ENV)
                            .unwrap_or_else(|| DEFAULT_SYNC_NAME.to_string()),
                        email: non_empty(&get, SYNC_EMAIL_ENV)
                            .unwrap_or_else(|| DEFAULT_SYNC_EMAIL.to_string()),
                    },
                    ssh_key_pem,
                    known_hosts: non_empty(&get, KNOWN_HOSTS_ENV),
                });
            }
            None => errors.push(ConfigError::GitBranchRequired),
        }
    }

    // --- Bundle root (§4.5) and the one log-and-ignore case (§2.4) ----------
    //
    // `SUNSTONE_BUNDLE` keeps `main.rs`'s exact leniency: whitespace-only counts
    // as unset, but the surviving value is *not* trimmed.
    let bundle_env = get(BUNDLE_ENV).filter(|v| !v.trim().is_empty());
    let (repo_root, bundle_root) = if shape.is_git() {
        if let Some(value) = &bundle_env {
            // Not fatal: the image bakes `SUNSTONE_BUNDLE=/bundle` into its ENV,
            // so an operator's override is indistinguishable from that default.
            warnings.push(ConfigWarning::BundleIgnoredInGitShape {
                value: value.clone(),
            });
        }
        let repo_root = PathBuf::from(REPO_DIR);
        let bundle_root = join_bundle_subdir(&repo_root, &subdir);
        (Some(repo_root), bundle_root)
    } else {
        (
            None,
            bundle_env
                .map(PathBuf::from)
                .unwrap_or_else(default_dev_bundle_root),
        )
    };

    // --- Seed (§4.3) --------------------------------------------------------
    let seed_from = non_empty(&get, SEED_FROM_ENV);
    if let (Some(seed), Some(_)) = (&seed_from, &origin) {
        // Fatal rather than log-and-ignore: this variable has no baked image
        // default, so its presence is always an explicit operator act (§2.4).
        errors.push(ConfigError::SeedWithOrigin { seed: seed.clone() });
    }

    if !errors.is_empty() {
        return Err(errors);
    }

    Ok(Config {
        shape,
        git,
        repo_root,
        bundle_root,
        seed_from: seed_from.map(PathBuf::from),
        // Pre-existing and lenient, byte-identical to `main.rs`: empty is unset,
        // but the value is passed through untrimmed — a secret's whitespace is
        // part of the secret, and the Node hook mints against the raw value.
        jwt_secret: get(crate::auth::SECRET_ENV)
            .filter(|v| !v.is_empty())
            .map(String::into_bytes),
        // Pre-existing and lenient: `SUNSTONE_API_PORT=banana` falls back rather
        // than refusing to boot. Knowingly inconsistent with the git family
        // (§2.4) — making it fatal is a behaviour change for deployments that
        // exist today.
        api_port: get(API_PORT_ENV)
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(crate::DEFAULT_PORT),
        warnings,
    })
}

/// Whether a `SUNSTONE_GIT_BUNDLE_SUBDIR` value would escape [`REPO_DIR`]:
/// absolute, or carrying a `..` **component**. Rejecting here is what makes
/// [`Config::bundle_root`] contained by construction (§4.5), so no boot-time
/// containment check is needed downstream.
fn subdir_escapes(subdir: &str) -> bool {
    let absolute = subdir.starts_with('/')
        || subdir.starts_with('\\')
        || Path::new(subdir).is_absolute()
        // A Windows drive-qualified path is absolute in intent even where
        // `Path::is_absolute` (which is platform-specific) says otherwise.
        || subdir.chars().nth(1) == Some(':');
    // A *component*, so a legitimate `..dotdir` is untouched.
    let dotdot = subdir.split(['/', '\\']).any(|part| part == "..");
    absolute || dotdot
}

/// Drop every ASCII whitespace byte, so a base64 blob that survived an env file
/// as multiple lines still decodes (§2.3's `SUNSTONE_GIT_SSH_KEY`).
fn strip_whitespace(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The plain shape's dev fallback bundle root when `SUNSTONE_BUNDLE` is unset:
/// the repo's `examples/` directory, exactly as `main::default_dev_root`. Still
/// **pure** — `CARGO_MANIFEST_DIR` is resolved at compile time, and
/// canonicalization is [`crate::boot::resolve_bundle_root`]'s job.
fn default_dev_bundle_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples")
}

/// Read a variable, treating an empty/whitespace-only value as **unset** —
/// already the repo's idiom at all three existing read sites (§2.3).
pub fn non_empty(get: &impl Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Join [`REPO_DIR`] with a validated `SUNSTONE_GIT_BUNDLE_SUBDIR` (§4.5).
/// Pure and unit-testable; `""` yields the repo root unchanged. Containment is
/// guaranteed by [`ConfigError::BundleSubdirEscapes`] having already fired for
/// an absolute or `..`-bearing value.
pub fn join_bundle_subdir(repo_root: &std::path::Path, subdir: &str) -> PathBuf {
    let subdir = subdir.trim().trim_matches('/');
    if subdir.is_empty() {
        repo_root.to_path_buf()
    } else {
        repo_root.join(subdir)
    }
}

// --- Tests ------------------------------------------------------------------
//
// Spec 2 §14's first bullet, in full. Everything runs over a `HashMap`: the whole
// point of the pure parse is that no test mutates `std::env` (`set_var` is
// `unsafe` in edition 2024 and flaky under `cargo test`'s threads).

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Parse an environment given as pairs. Goes through [`parse_env`] with the
    /// map's **own** key set, so §2.2's closed-namespace check sees exactly the
    /// keys a real environment would present.
    fn parse_vars(vars: &[(&str, &str)]) -> Result<Config, Vec<ConfigError>> {
        let env: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        let names: Vec<String> = env.keys().cloned().collect();
        parse_env(names, move |k| env.get(k).cloned())
    }

    fn ok(vars: &[(&str, &str)]) -> Config {
        parse_vars(vars).expect("expected a valid config")
    }

    fn errs(vars: &[(&str, &str)]) -> Vec<ConfigError> {
        parse_vars(vars).expect_err("expected a boot error")
    }

    /// A minimal git-synced environment, ssh key included.
    fn git_synced() -> Vec<(&'static str, &'static str)> {
        vec![
            (BRANCH_ENV, "main"),
            (ORIGIN_ENV, "git@example.com:acme/wiki.git"),
            // base64 of "PEM"
            (SSH_KEY_ENV, "UEVN"),
        ]
    }

    // --- The three shapes (§2.1, Spec 1 §1) ---------------------------------

    #[test]
    fn no_git_vars_is_the_plain_shape() {
        let cfg = ok(&[(BUNDLE_ENV, "/bundle")]);
        assert_eq!(cfg.shape, Shape::Plain);
        assert!(cfg.git.is_none());
        assert!(cfg.repo_root.is_none());
        assert_eq!(cfg.bundle_root, PathBuf::from("/bundle"));
        assert!(!cfg.is_git());
        assert!(!cfg.shape.syncs());
        assert!(cfg.warnings.is_empty());
    }

    #[test]
    fn plain_shape_without_bundle_falls_back_to_the_dev_default() {
        let cfg = ok(&[]);
        assert_eq!(cfg.shape, Shape::Plain);
        assert_eq!(cfg.bundle_root, default_dev_bundle_root());
    }

    #[test]
    fn branch_only_is_the_git_local_shape() {
        let cfg = ok(&[(BRANCH_ENV, "main")]);
        assert_eq!(cfg.shape, Shape::GitLocal);
        assert!(cfg.is_git());
        assert!(!cfg.shape.syncs());
        assert_eq!(cfg.repo_root, Some(PathBuf::from(REPO_DIR)));
        assert_eq!(cfg.bundle_root, PathBuf::from(REPO_DIR));

        let git = cfg.git().expect("git family present in a git shape");
        assert_eq!(git.branch, "main");
        assert!(git.origin.is_none());
        assert!(!git.origin_is_ssh());
    }

    #[test]
    fn branch_plus_origin_is_the_git_synced_shape() {
        let cfg = ok(&git_synced());
        assert_eq!(cfg.shape, Shape::GitSynced);
        assert!(cfg.shape.syncs());
        assert_eq!(cfg.shape.as_str(), "git-synced");

        let git = cfg.git().unwrap();
        assert_eq!(git.origin.as_deref(), Some("git@example.com:acme/wiki.git"));
        assert!(git.origin_is_ssh());
        assert_eq!(git.upstream_ref(), "origin/main");
    }

    #[test]
    fn a_non_branch_git_var_alone_still_selects_a_git_shape() {
        // The gate is presence of *any* recognised git var, not of the branch —
        // which is precisely why the missing branch must be an error, not a
        // silent downgrade to plain.
        assert_eq!(errs(&[(SUBDIR_ENV, "docs")]), vec![ConfigError::GitBranchRequired]);
    }

    // --- The branch is required, with no default (§2.1) ---------------------

    #[test]
    fn a_git_var_without_a_branch_is_a_boot_error() {
        assert_eq!(
            errs(&[(ORIGIN_ENV, "https://example.com/acme/wiki.git")]),
            vec![ConfigError::GitBranchRequired]
        );
    }

    // --- The namespace is closed (§2.2) -------------------------------------

    #[test]
    fn an_unknown_git_var_is_a_boot_error() {
        assert_eq!(
            errs(&[
                (BRANCH_ENV, "main"),
                ("SUNSTONE_GIT_ORGIN", "git@example.com:acme/wiki.git"),
            ]),
            vec![ConfigError::UnknownGitVar {
                name: "SUNSTONE_GIT_ORGIN".to_string()
            }]
        );
    }

    #[test]
    fn a_stale_sidecar_env_file_is_a_caught_migration() {
        // The load-bearing case: the retired sidecar trio must not be silently
        // ignored into a wiki that serves un-synced content. Reported alone —
        // adding a spurious "branch required" would misdirect the operator.
        let errors = errs(&[
            ("SUNSTONE_GIT_REPO", "git@example.com:acme/wiki.git"),
            ("SUNSTONE_GIT_REF", "main"),
            ("SUNSTONE_GIT_PERIOD", "30"),
        ]);
        assert_eq!(
            errors,
            vec![
                ConfigError::UnknownGitVar {
                    name: "SUNSTONE_GIT_PERIOD".to_string()
                },
                ConfigError::UnknownGitVar {
                    name: "SUNSTONE_GIT_REF".to_string()
                },
                ConfigError::UnknownGitVar {
                    name: "SUNSTONE_GIT_REPO".to_string()
                },
            ]
        );
    }

    #[test]
    fn the_retired_mode_var_is_rejected() {
        let errors = errs(&[(BRANCH_ENV, "main"), ("SUNSTONE_GIT_MODE", "On")]);
        assert_eq!(
            errors,
            vec![ConfigError::UnknownGitVar {
                name: "SUNSTONE_GIT_MODE".to_string()
            }]
        );
    }

    #[test]
    fn parse_applies_every_rule_except_the_closed_set_it_cannot_see() {
        // `parse` takes a key-LOOKUP closure, so it can never observe an
        // unrecognised key and therefore cannot enforce the closed namespace —
        // that is `parse_env`'s job, and why `main()` must call it. What `parse`
        // must still do is apply every other rule; this pins that, and nothing
        // about §2.2.
        let env: HashMap<&str, &str> = HashMap::from([(BRANCH_ENV, "main")]);
        let cfg = parse(|k| env.get(k).map(|v| v.to_string())).unwrap();
        assert_eq!(cfg.shape, Shape::GitLocal);
    }

    // --- Every problem at once (§2) -----------------------------------------

    #[test]
    fn every_problem_is_reported_in_one_pass() {
        // One crash-loop for four typos, not four.
        let errors = errs(&[
            ("SUNSTONE_GIT_ORGIN", "git@example.com:acme/wiki.git"),
            (SUBDIR_ENV, "../etc"),
            (INTERVAL_ENV, "banana"),
            (SSH_KEY_ENV, "not base64!!"),
        ]);
        assert_eq!(errors.len(), 5, "unexpected error set: {errors:?}");
        assert!(errors.contains(&ConfigError::UnknownGitVar {
            name: "SUNSTONE_GIT_ORGIN".to_string()
        }));
        assert!(errors.contains(&ConfigError::BundleSubdirEscapes {
            value: "../etc".to_string()
        }));
        assert!(errors.contains(&ConfigError::BadSyncInterval {
            value: "banana".to_string()
        }));
        assert!(errors.contains(&ConfigError::SshKeyNotBase64));
        // And the missing branch, which must not be masked by the others.
        assert!(errors.contains(&ConfigError::GitBranchRequired));
    }

    #[test]
    fn a_seed_and_a_bad_interval_are_reported_together() {
        let errors = errs(&[
            (BRANCH_ENV, "main"),
            (ORIGIN_ENV, "https://example.com/acme/wiki.git"),
            (INTERVAL_ENV, "0"),
            (SEED_FROM_ENV, "/seed"),
        ]);
        assert_eq!(
            errors,
            vec![
                ConfigError::BadSyncInterval {
                    value: "0".to_string()
                },
                ConfigError::SeedWithOrigin {
                    seed: "/seed".to_string()
                },
            ]
        );
    }

    // --- Empty means unset, uniformly (§2.3) --------------------------------

    #[test]
    fn empty_git_vars_mean_unset_so_the_shape_is_plain() {
        let cfg = ok(&[
            (BRANCH_ENV, ""),
            (ORIGIN_ENV, "  "),
            (SUBDIR_ENV, ""),
            (INTERVAL_ENV, ""),
            (SSH_KEY_ENV, ""),
        ]);
        assert_eq!(cfg.shape, Shape::Plain);
        assert!(cfg.git.is_none());
    }

    #[test]
    fn an_empty_unknown_git_var_is_not_an_error() {
        // A blank line in an env file means "default" — including for a name we
        // do not recognise, so leniency stays uniform.
        let cfg = ok(&[("SUNSTONE_GIT_ORGIN", "")]);
        assert_eq!(cfg.shape, Shape::Plain);
    }

    #[test]
    fn an_empty_origin_downgrades_git_synced_to_git_local() {
        // Spec 1 §1's documented trap: a trap to document, not to fix. `GET
        // /api/sync-status` reporting `shape` is the prescribed post-deploy check.
        let cfg = ok(&[(BRANCH_ENV, "main"), (ORIGIN_ENV, "")]);
        assert_eq!(cfg.shape, Shape::GitLocal);
        assert!(cfg.git().unwrap().origin.is_none());
    }

    #[test]
    fn an_empty_bundle_is_unset() {
        let cfg = ok(&[(BUNDLE_ENV, "   ")]);
        assert_eq!(cfg.bundle_root, default_dev_bundle_root());
    }

    // --- The sync interval (§2.3) -------------------------------------------

    #[test]
    fn the_sync_interval_defaults_to_ten_seconds() {
        let cfg = ok(&[(BRANCH_ENV, "main")]);
        assert_eq!(
            cfg.git().unwrap().sync_interval,
            Duration::from_secs(DEFAULT_SYNC_INTERVAL_SECS)
        );
    }

    #[test]
    fn a_valid_sync_interval_is_honoured() {
        let cfg = ok(&[(BRANCH_ENV, "main"), (INTERVAL_ENV, "300")]);
        assert_eq!(cfg.git().unwrap().sync_interval, Duration::from_secs(300));
    }

    #[test]
    fn an_unparseable_sync_interval_is_a_boot_error() {
        for value in ["banana", "-5", "1.5", "10s"] {
            assert_eq!(
                errs(&[(BRANCH_ENV, "main"), (INTERVAL_ENV, value)]),
                vec![ConfigError::BadSyncInterval {
                    value: value.to_string()
                }],
                "{value} should be rejected"
            );
        }
    }

    #[test]
    fn a_zero_sync_interval_is_a_boot_error() {
        // `0` = never poll was rejected: it adds a shape absent from §2.1's
        // table. The escape hatch is a large interval.
        assert_eq!(
            errs(&[(BRANCH_ENV, "main"), (INTERVAL_ENV, "0")]),
            vec![ConfigError::BadSyncInterval {
                value: "0".to_string()
            }]
        );
    }

    // --- The bundle subdir (§2.3, §4.5) -------------------------------------

    #[test]
    fn a_relative_subdir_joins_onto_the_repo_dir() {
        let cfg = ok(&[(BRANCH_ENV, "main"), (SUBDIR_ENV, "docs/wiki")]);
        assert_eq!(cfg.repo_root, Some(PathBuf::from(REPO_DIR)));
        assert_eq!(cfg.bundle_root, PathBuf::from("/srv/repo/docs/wiki"));
        assert_eq!(cfg.git().unwrap().bundle_subdir, "docs/wiki");
    }

    #[test]
    fn an_absolute_subdir_is_a_boot_error() {
        assert_eq!(
            errs(&[(BRANCH_ENV, "main"), (SUBDIR_ENV, "/etc")]),
            vec![ConfigError::BundleSubdirEscapes {
                value: "/etc".to_string()
            }]
        );
    }

    #[test]
    fn a_dotdot_subdir_is_a_boot_error() {
        for value in ["..", "../etc", "docs/../../etc", "docs/.."] {
            assert_eq!(
                errs(&[(BRANCH_ENV, "main"), (SUBDIR_ENV, value)]),
                vec![ConfigError::BundleSubdirEscapes {
                    value: value.to_string()
                }],
                "{value} should be rejected"
            );
        }
    }

    #[test]
    fn a_dot_prefixed_subdir_component_is_not_a_dotdot_escape() {
        let cfg = ok(&[(BRANCH_ENV, "main"), (SUBDIR_ENV, "..docs")]);
        assert_eq!(cfg.bundle_root, PathBuf::from("/srv/repo/..docs"));
    }

    #[test]
    fn join_bundle_subdir_is_pure_and_handles_the_root() {
        let root = Path::new(REPO_DIR);
        assert_eq!(join_bundle_subdir(root, ""), PathBuf::from("/srv/repo"));
        assert_eq!(join_bundle_subdir(root, "  "), PathBuf::from("/srv/repo"));
        assert_eq!(join_bundle_subdir(root, "docs"), PathBuf::from("/srv/repo/docs"));
        assert_eq!(
            join_bundle_subdir(root, "docs/wiki"),
            PathBuf::from("/srv/repo/docs/wiki")
        );
        // A trailing (or, defensively, a leading) slash cannot escape the root.
        assert_eq!(join_bundle_subdir(root, "docs/"), PathBuf::from("/srv/repo/docs"));
        assert_eq!(join_bundle_subdir(root, "/docs"), PathBuf::from("/srv/repo/docs"));
    }

    // --- The one origin inspection, and the key it gates (§2.3, Spec 1 §7) --

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

    #[test]
    fn an_ssh_origin_requires_a_key() {
        // Caught here rather than deep in the first loop tick, where ticket 13
        // would report a *sync error* for what is a misconfiguration.
        assert_eq!(
            errs(&[
                (BRANCH_ENV, "main"),
                (ORIGIN_ENV, "git@example.com:acme/wiki.git"),
            ]),
            vec![ConfigError::SshKeyRequired]
        );
    }

    #[test]
    fn an_https_origin_needs_no_key() {
        let cfg = ok(&[
            (BRANCH_ENV, "main"),
            (ORIGIN_ENV, "https://example.com/acme/wiki.git"),
        ]);
        assert_eq!(cfg.shape, Shape::GitSynced);
        assert!(cfg.git().unwrap().ssh_key_pem.is_none());
    }

    #[test]
    fn a_key_without_an_origin_is_accepted() {
        // git-local with a stray key: inert, and not worth a crash loop.
        let cfg = ok(&[(BRANCH_ENV, "main"), (SSH_KEY_ENV, "UEVN")]);
        assert_eq!(cfg.shape, Shape::GitLocal);
        assert_eq!(cfg.git().unwrap().ssh_key_pem.as_deref(), Some(&b"PEM"[..]));
    }

    #[test]
    fn the_ssh_key_is_base64_decoded() {
        let cfg = ok(&git_synced());
        assert_eq!(cfg.git().unwrap().ssh_key_pem.as_deref(), Some(&b"PEM"[..]));
    }

    #[test]
    fn a_multiline_base64_key_still_decodes() {
        let cfg = ok(&[
            (BRANCH_ENV, "main"),
            (ORIGIN_ENV, "git@example.com:acme/wiki.git"),
            (SSH_KEY_ENV, "UEVN\nUEVN\n"),
        ]);
        assert_eq!(
            cfg.git().unwrap().ssh_key_pem.as_deref(),
            Some(&b"PEMPEM"[..])
        );
    }

    #[test]
    fn an_undecodable_ssh_key_is_a_boot_error_on_its_own() {
        // One problem, one error: `SshKeyRequired` must not also fire, or the
        // operator is told to set a variable they already set.
        assert_eq!(
            errs(&[
                (BRANCH_ENV, "main"),
                (ORIGIN_ENV, "git@example.com:acme/wiki.git"),
                (SSH_KEY_ENV, "not base64!!"),
            ]),
            vec![ConfigError::SshKeyNotBase64]
        );
    }

    // --- known_hosts and the sync identity (§2.3, §4.2.3) -------------------

    #[test]
    fn known_hosts_unset_means_accept_new() {
        let cfg = ok(&git_synced());
        let git = cfg.git().unwrap();
        assert!(git.known_hosts.is_none());
        assert_eq!(git.strict_host_key_checking(), "accept-new");
    }

    #[test]
    fn known_hosts_set_means_strict() {
        let mut vars = git_synced();
        vars.push((KNOWN_HOSTS_ENV, "example.com ssh-ed25519 AAAA..."));
        let cfg = ok(&vars);
        let git = cfg.git().unwrap();
        assert_eq!(
            git.known_hosts.as_deref(),
            Some("example.com ssh-ed25519 AAAA...")
        );
        assert_eq!(git.strict_host_key_checking(), "yes");
    }

    #[test]
    fn the_sync_identity_defaults_and_overrides() {
        let cfg = ok(&[(BRANCH_ENV, "main")]);
        let id = &cfg.git().unwrap().sync_identity;
        assert_eq!(id.name, DEFAULT_SYNC_NAME);
        assert_eq!(id.email, DEFAULT_SYNC_EMAIL);

        let cfg = ok(&[
            (BRANCH_ENV, "main"),
            (SYNC_NAME_ENV, "Wiki Bot"),
            (SYNC_EMAIL_ENV, "bot@example.com"),
        ]);
        let id = &cfg.git().unwrap().sync_identity;
        assert_eq!(id.name, "Wiki Bot");
        assert_eq!(id.email, "bot@example.com");
    }

    // --- The seed (§4.3) ----------------------------------------------------

    #[test]
    fn a_seed_plus_an_origin_is_a_boot_error() {
        // You cannot seed a clone: `git clone` requires an empty target.
        assert_eq!(
            errs(&[
                (BRANCH_ENV, "main"),
                (ORIGIN_ENV, "https://example.com/acme/wiki.git"),
                (SEED_FROM_ENV, "/seed"),
            ]),
            vec![ConfigError::SeedWithOrigin {
                seed: "/seed".to_string()
            }]
        );
    }

    #[test]
    fn a_seed_without_an_origin_is_accepted() {
        let cfg = ok(&[(BRANCH_ENV, "main"), (SEED_FROM_ENV, "/seed")]);
        assert_eq!(cfg.shape, Shape::GitLocal);
        assert_eq!(cfg.seed_from, Some(PathBuf::from("/seed")));
    }

    #[test]
    fn a_seed_in_the_plain_shape_is_accepted() {
        let cfg = ok(&[(BUNDLE_ENV, "/bundle"), (SEED_FROM_ENV, "/seed")]);
        assert_eq!(cfg.shape, Shape::Plain);
        assert_eq!(cfg.seed_from, Some(PathBuf::from("/seed")));
    }

    #[test]
    fn an_empty_seed_is_unset() {
        let cfg = ok(&[
            (BRANCH_ENV, "main"),
            (ORIGIN_ENV, "https://example.com/acme/wiki.git"),
            (SEED_FROM_ENV, ""),
        ]);
        assert!(cfg.seed_from.is_none());
    }

    // --- The one log-and-ignore case (§2.4) ---------------------------------

    #[test]
    fn bundle_in_a_git_shape_warns_and_is_ignored() {
        // Not fatal: `Dockerfile` bakes `SUNSTONE_BUNDLE=/bundle` into the image
        // ENV, so an override is indistinguishable from the image's default.
        let cfg = ok(&[
            (BRANCH_ENV, "main"),
            (SUBDIR_ENV, "docs"),
            (BUNDLE_ENV, "/bundle"),
        ]);
        assert_eq!(
            cfg.warnings,
            vec![ConfigWarning::BundleIgnoredInGitShape {
                value: "/bundle".to_string()
            }]
        );
        assert_eq!(cfg.bundle_root, PathBuf::from("/srv/repo/docs"));
    }

    #[test]
    fn an_empty_bundle_in_a_git_shape_does_not_warn() {
        let cfg = ok(&[(BRANCH_ENV, "main"), (BUNDLE_ENV, "")]);
        assert!(cfg.warnings.is_empty());
    }

    #[test]
    fn the_plain_shape_never_warns_about_its_own_bundle() {
        let cfg = ok(&[(BUNDLE_ENV, "/bundle")]);
        assert!(cfg.warnings.is_empty());
    }

    // --- Pre-existing vars keep their leniency (§2.3) -----------------------

    #[test]
    fn an_unparseable_api_port_falls_back_to_the_default() {
        // Knowingly inconsistent with the strict git family: making this fatal
        // is a behaviour change for deployments that exist today.
        for value in ["banana", "0.5", "70000", "-1", ""] {
            let cfg = ok(&[(API_PORT_ENV, value)]);
            assert_eq!(
                cfg.api_port,
                crate::DEFAULT_PORT,
                "{value} should fall back"
            );
        }
        assert_eq!(crate::DEFAULT_PORT, 8787);
    }

    #[test]
    fn a_valid_api_port_is_honoured() {
        assert_eq!(ok(&[(API_PORT_ENV, "9000")]).api_port, 9000);
    }

    #[test]
    fn the_jwt_secret_is_passed_through_untrimmed() {
        // Byte-identical to `main.rs`: empty is unset, but the surviving value
        // is *not* trimmed — whitespace is part of the secret the Node hook
        // mints against.
        assert!(ok(&[]).jwt_secret.is_none());
        assert!(ok(&[(crate::auth::SECRET_ENV, "")]).jwt_secret.is_none());
        assert_eq!(
            ok(&[(crate::auth::SECRET_ENV, " s3cret ")]).jwt_secret,
            Some(b" s3cret ".to_vec())
        );
    }

    #[test]
    fn a_bad_api_port_does_not_mask_a_git_error() {
        // Lenient and strict rules coexist in one pass.
        let errors = errs(&[(API_PORT_ENV, "banana"), (SUBDIR_ENV, "/etc")]);
        assert!(errors.contains(&ConfigError::GitBranchRequired));
        assert!(errors.contains(&ConfigError::BundleSubdirEscapes {
            value: "/etc".to_string()
        }));
    }

    // --- Surface bookkeeping ------------------------------------------------

    #[test]
    fn known_vars_match_the_read_sites() {
        let mut read: Vec<&str> = vec![
            BRANCH_ENV,
            ORIGIN_ENV,
            SUBDIR_ENV,
            INTERVAL_ENV,
            SYNC_NAME_ENV,
            SYNC_EMAIL_ENV,
            SSH_KEY_ENV,
            KNOWN_HOSTS_ENV,
        ];
        read.sort();
        let mut known: Vec<&str> = KNOWN_GIT_VARS.to_vec();
        known.sort();
        assert_eq!(read, known, "a recognised git var must have a read site");
        assert!(known.iter().all(|k| k.starts_with(GIT_VAR_PREFIX)));
        assert!(!KNOWN_GIT_VARS.contains(&"SUNSTONE_GIT_MODE"));
    }

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

    // --- Operator-facing messages (§4.1) ------------------------------------

    #[test]
    fn every_error_names_its_variable_and_a_fix() {
        let cases: Vec<(ConfigError, &str)> = vec![
            (ConfigError::GitBranchRequired, BRANCH_ENV),
            (
                ConfigError::UnknownGitVar {
                    name: "SUNSTONE_GIT_ORGIN".to_string(),
                },
                "SUNSTONE_GIT_ORGIN",
            ),
            (
                ConfigError::BundleSubdirEscapes {
                    value: "/etc".to_string(),
                },
                SUBDIR_ENV,
            ),
            (
                ConfigError::BadSyncInterval {
                    value: "0".to_string(),
                },
                INTERVAL_ENV,
            ),
            (ConfigError::SshKeyRequired, SSH_KEY_ENV),
            (ConfigError::SshKeyNotBase64, SSH_KEY_ENV),
            (
                ConfigError::SeedWithOrigin {
                    seed: "/seed".to_string(),
                },
                SEED_FROM_ENV,
            ),
        ];
        for (error, expected_var) in cases {
            let text = error.to_string();
            assert!(
                text.contains(expected_var),
                "{error:?} should name {expected_var}: {text}"
            );
            // A single line, since `docker logs` is the consumer, and no
            // `sunstone-server: ` prefix — the caller adds it.
            assert!(!text.contains('\n'), "{error:?} must be one line: {text}");
            assert!(!text.starts_with("sunstone-server:"), "{text}");
        }
    }

    #[test]
    fn the_unknown_var_message_lists_the_closed_set_and_the_retired_names() {
        let text = ConfigError::UnknownGitVar {
            name: "SUNSTONE_GIT_ORGIN".to_string(),
        }
        .to_string();
        for known in KNOWN_GIT_VARS {
            assert!(text.contains(known), "{known} missing from: {text}");
        }
        assert!(text.contains("SUNSTONE_GIT_REPO"));
    }

    #[test]
    fn the_bundle_warning_names_the_variable_and_the_real_root() {
        let text = ConfigWarning::BundleIgnoredInGitShape {
            value: "/bundle".to_string(),
        }
        .to_string();
        assert!(text.contains(BUNDLE_ENV));
        assert!(text.contains(REPO_DIR));
        assert!(text.contains(SUBDIR_ENV));
        assert!(!text.contains('\n'));
    }
}
