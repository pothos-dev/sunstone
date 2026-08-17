//! The boot-refusing [`ConfigError`]s and the non-fatal [`ConfigWarning`]s,
//! with the operator-facing messages an admin reads in `docker logs`.

use std::fmt;

use super::{
    BRANCH_ENV, BUNDLE_ENV, DEFAULT_SYNC_INTERVAL_SECS, GIT_VAR_PREFIX, INTERVAL_ENV,
    KNOWN_GIT_VARS, ORIGIN_ENV, REPO_DIR, SEED_FROM_ENV, SSH_KEY_ENV, SUBDIR_ENV,
};

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

/// One reason the configuration refuses to boot. [`crate::config::parse_env`]
/// returns **every** error it found, so N typos cost one crash-loop rather
/// than N.
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

#[cfg(test)]
mod tests {
    use super::*;

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
