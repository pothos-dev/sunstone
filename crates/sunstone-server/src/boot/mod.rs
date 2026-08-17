//! The ordered boot sequence (Spec 2 §4) — everything with a filesystem or git
//! side effect that must happen *before* the server serves a request.
//!
//! Strictly ordered; **every failure exits non-zero with an actionable
//! message**, which is why each step returns `Result<_, String>` and `main()`
//! prints and exits rather than degrading. The honest cost (§2.4): under
//! `restart: unless-stopped` that is a crash loop, not a friendly error.
//! Accepted — the alternative is a wiki that serves perfectly, commits nothing,
//! and accumulates edits in a volume classed as a disposable cache.
//!
//! The **server** owns this, not `docker/entrypoint.sh`, for two reasons: it is
//! shape-aware (in a git shape only the server knows the bundle destination),
//! and it shares the write path's in-process lock.
//!
//! Order, and why:
//!
//! 1. [`crate::config::parse`] — §4.1, in `main()`.
//! 2. [`write_ssh_material`] then [`configure_git`] — §4.2. Nothing may spawn
//!    git before `configure`, or a child would miss `GIT_SSH_COMMAND`.
//! 3. [`preflight_repo_writable`] — §4.6's first predicate, run **before** the
//!    state machine so a permission failure is reported as such rather than as
//!    a clone error.
//! 4. [`seed_copy`] — §4.3, before any git step. It targets the *resolved*
//!    bundle root, so [`resolve_bundle_root`] runs first in this one case; safe
//!    because a seed can never coexist with an origin (`config::parse` rejects
//!    the pair), so there is no clone whose empty target it could spoil.
//! 5. [`prepare_repo`] — §4.4.
//! 6. [`resolve_bundle_root`] — §4.5, again after the clone, since a subdir
//!    bundle only exists once the repo does.
//! 7. [`preflight_bundle_writable`] — §4.6's second predicate.
//!
//! **No boot `ls-remote` probe** (§4.2): on a fresh volume the clone already
//! proves reachability, and on an adopted repo a network hiccup must not stop
//! the container from serving reads. Ongoing reachability is
//! `GET /api/sync-status`'s job.

mod fsutil;
mod ssh;

pub use fsutil::probe_writable;
pub use ssh::write_ssh_material;

use std::path::{Path, PathBuf};

use sunstone_native::git::{self, GitEnv};

use crate::config::{Config, GitConfig, SEED_FROM_ENV};

use fsutil::{canonical, copy_dir_contents, dir_is_empty, ensure_dir};
use ssh::{ssh_command, SSH_KEY_ENV};

/// Filename of the writability probe (§4.6). **Dot-prefixed on purpose**: §6's
/// watcher filter drops every path with a dot-prefixed component, so the probe
/// cannot leak an SSE event.
pub const WRITE_PROBE_NAME: &str = ".sunstone-write-probe";

/// The `git-local` seed commit's subject (§4.4). Deliberately the same wording
/// `docker/entrypoint.sh` used before the server took the job over, so a repo
/// initialised by the old entrypoint and one initialised here read alike.
const SEED_COMMIT_MSG: &str = "seed bundle";

/// The compose escape hatch every permission message points at (§4.6, ticket
/// 10): non-root removed root's blanket permission bypass, so a bind mount not
/// owned by uid 1000 must either be chowned or run as its owner.
pub(super) const UID_HINT: &str = "either chown it to the container's uid (1000 by default) \
                        or run the container as its owner — compose: \
                        `user: \"${SUNSTONE_UID:-1000}:${SUNSTONE_GID:-1000}\"`";

/// What the boot sequence established, handed to `AppState` construction.
#[derive(Debug, Clone)]
pub struct BootOutcome {
    /// The canonical bundle root to index, watch and write (§4.5).
    pub bundle_root: PathBuf,
    /// The repository root git runs in — `Some(/srv/repo)` in a git shape.
    /// Distinct from `bundle_root` whenever a subdir is configured.
    pub repo_root: Option<PathBuf>,
    /// What §4.4's state machine did, for the boot log line.
    pub repo_action: RepoAction,
    /// Whether §4.3 copied a seed into the bundle root.
    pub seeded: bool,
}

/// The branch §4.4's state machine took at [`crate::config::REPO_DIR`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepoAction {
    /// Plain shape — git never ran.
    None,
    /// git-synced, `/srv/repo` missing or empty ⇒ `git clone --branch`.
    Cloned,
    /// An existing repo taken over as-is (git-synced with a matching origin
    /// URL, or git-local). The loop takes it from here.
    Adopted,
    /// git-local over a non-repo (including a just-seeded tree) ⇒ `git init
    /// --initial-branch` plus the sync-identity seed commit.
    Initialized,
}

/// Drive the whole sequence in order and return what it established. Prints
/// nothing on success beyond the existing boot lines; every `Err` is a message
/// `main()` prints verbatim before exiting non-zero.
pub fn run(cfg: &Config) -> Result<BootOutcome, String> {
    // §4.2 — the ssh material and the process-global git environment, before
    // anything can spawn a git child.
    write_ssh_material(cfg)?;
    configure_git(cfg);
    run_after_git_env(cfg)
}

/// §4.3–§4.6: everything after the git environment is installed.
///
/// Split out **only** so the tests can drive the whole ordered tail without
/// [`configure_git`] writing `sunstone-native`'s process-global `OnceLock`,
/// which would leak a committer override into every other git-touching test in
/// this binary. `run` is still the one production entry point.
fn run_after_git_env(cfg: &Config) -> Result<BootOutcome, String> {
    // The probe (and `git clone`, which only creates the final component) needs
    // the repo directory to exist. In the image it does, chowned to `node`; a
    // fresh named volume inherits that owner (ticket 10).
    if let Some(repo_root) = cfg.repo_root.as_ref() {
        ensure_dir(repo_root, "the repository directory")?;
    }

    // §4.6's first predicate, deliberately **before** §4.4: a permission
    // failure must read as a permission failure, not as a clone error.
    preflight_repo_writable(cfg)?;

    // §4.3 — into the *resolved* bundle root, before any git step. Only
    // reachable without an origin (`config::parse` rejects seed + origin), so
    // creating the bundle directory here can never spoil a clone's empty target.
    let seeded = if cfg.seed_from.is_some() {
        let bundle_root = resolve_bundle_root(cfg)?;
        seed_copy(cfg, &bundle_root)?
    } else {
        false
    };

    // §4.4 — clone | adopt | init+seed | fail loudly.
    let repo_action = prepare_repo(cfg)?;

    // §4.5 — after the clone, since a subdir bundle only exists once the repo
    // does.
    let bundle_root = resolve_bundle_root(cfg)?;

    // §4.6's second predicate.
    preflight_bundle_writable(cfg, &bundle_root)?;

    Ok(BootOutcome {
        bundle_root,
        // Canonical, like `bundle_root`, so `bundle_root.strip_prefix(repo_root)`
        // is a plain prefix comparison for the loop and the resolver.
        repo_root: cfg
            .repo_root
            .as_ref()
            .map(|r| r.canonicalize().unwrap_or_else(|_| r.clone())),
        repo_action,
        seeded,
    })
}

/// §4.2.4 — hand the process-global git environment to `sunstone-native`:
/// `GIT_SSH_COMMAND` built from [`crate::config::SSH_KEY_PATH`] +
/// [`crate::config::KNOWN_HOSTS_PATH`] + the strict-host-key mode, and the sync
/// [`sunstone_native::git::CommitIdentity`] as committer.
///
/// Must run **before** anything spawns git. A no-op in the plain shape; the
/// desktop never calls it at all, so its behaviour is unchanged (§3).
pub fn configure_git(cfg: &Config) {
    let Some(git) = cfg.git() else {
        return; // plain: git never runs at all (§5, §11.1)
    };
    git::configure(GitEnv {
        // Only where `ssh` can actually be spawned. An https origin gets no
        // `GIT_SSH_COMMAND` at all rather than one pointing `-i` at a key file
        // §4.2 deliberately never wrote.
        ssh_command: git.origin_is_ssh().then(|| ssh_command(git)),
        committer: Some(git.sync_identity.clone()),
    });
}

/// §4.3 — copy `SUNSTONE_BUNDLE_SEED_FROM`'s **contents** into the resolved
/// bundle root, before any git step. Returns whether anything was copied.
///
/// This moved out of `docker/entrypoint.sh` because in a git shape only the
/// server knows the destination — the bundle is `/srv/repo/<subdir>` and
/// `SUNSTONE_BUNDLE` is ignored there, so a shell script reading
/// `SUNSTONE_BUNDLE` would write to the wrong place.
///
/// Seed **plus an origin** never reaches here: [`crate::config::parse`] already
/// rejected it (`git clone` requires an empty target).
pub fn seed_copy(cfg: &Config, bundle_root: &Path) -> Result<bool, String> {
    let Some(seed) = cfg.seed_from.as_ref() else {
        return Ok(false);
    };
    if !seed.is_dir() {
        return Err(format!(
            "{SEED_FROM_ENV}={} is not a directory that exists in the container. Point it at \
             the mounted source bundle (e.g. a `:ro` bind mount at /bundle-src), or unset it.",
            seed.display()
        ));
    }
    // Overlapping source and destination would copy files onto themselves
    // (`fs::copy` truncates first) or recurse forever. Caught rather than
    // survived: the operator asked for something that cannot mean anything.
    let (src, dest) = (canonical(seed), canonical(bundle_root));
    if src.starts_with(&dest) || dest.starts_with(&src) {
        return Err(format!(
            "{SEED_FROM_ENV}={} overlaps the bundle root {} — the seed source must be a \
             separate directory (the copy would otherwise overwrite its own source).",
            seed.display(),
            bundle_root.display()
        ));
    }

    // The directory's **contents**, not the directory itself — `cp -a <src>/.
    // <dest>/`, exactly what the retired entrypoint block did, dotfiles included.
    copy_dir_contents(seed, bundle_root).map_err(|e| {
        format!(
            "copying {SEED_FROM_ENV}={} into the bundle root {} failed: {e}. The source must be \
             readable and the destination writable — {UID_HINT}.",
            seed.display(),
            bundle_root.display()
        )
    })?;
    Ok(true)
}

/// §4.4 — bring [`crate::config::REPO_DIR`] into a usable state:
///
/// | Shape | State at `/srv/repo` | Action |
/// | --- | --- | --- |
/// | git-synced | missing / empty | `git clone <origin> --branch <branch>` |
/// | git-synced | repo, origin URL **matches** | adopt |
/// | git-synced | repo, origin URL **differs** | **fail loudly, touch nothing** |
/// | git-synced | non-empty, **not** a repo | **fail loudly, touch nothing** |
/// | git-local | repo | adopt |
/// | git-local | non-repo (incl. just-seeded) | `git init --initial-branch`, then a seed commit **authored and committed** by the sync identity |
///
/// The seed commit is the only thing the sync identity ever authors — no OIDC
/// user exists at boot. Call [`preflight_repo_writable`] first so a permission
/// failure is not misreported as a clone error.
pub fn prepare_repo(cfg: &Config) -> Result<RepoAction, String> {
    let (Some(git), Some(repo_root)) = (cfg.git(), cfg.repo_root.as_ref()) else {
        return Ok(RepoAction::None); // plain: git never runs
    };
    // Idempotent, and never "touching" an existing tree: git needs a cwd, and a
    // clone needs its target's parent.
    ensure_dir(repo_root, "the repository directory")?;
    let is_repo = git::is_repo(repo_root);

    let Some(origin) = git.origin.as_deref() else {
        // --- git-local ------------------------------------------------------
        if is_repo {
            return Ok(RepoAction::Adopted);
        }
        return init_and_seed(repo_root, git).map(|()| RepoAction::Initialized);
    };

    // --- git-synced ---------------------------------------------------------
    if is_repo {
        // The origin URL decides adopt-vs-refuse. Compared as the opaque string
        // it is (only trailing slashes are ignored): a repo pointing somewhere
        // else is not ours to fetch into, and guessing an equivalence between
        // two spellings is how a wiki ends up silently synced to the wrong remote.
        match git::remote_url(repo_root) {
            Some(url) if same_origin(&url, origin) => {}
            found => return Err(origin_mismatch(repo_root, origin, found.as_deref())),
        }
        // The origin matching is not enough: the loop rebases onto
        // `origin/<branch>` and pushes `HEAD:refs/heads/<branch>`, so if HEAD is
        // on some *other* branch that push is still a fast-forward and quietly
        // republishes the wrong branch's content as `<branch>`.
        //
        // §2.1 gives SUNSTONE_GIT_BRANCH four jobs and none of them is "check out",
        // so we do not switch branches under an operator — that is exactly the
        // destructive surprise the other refusal rows of §4.4 exist to prevent.
        // Refuse, touch nothing.
        return match git::current_branch(repo_root) {
            Some(branch) if branch == git.branch => Ok(RepoAction::Adopted),
            found => Err(branch_mismatch(repo_root, &git.branch, found.as_deref())),
        };
    }
    if dir_is_empty(repo_root)? {
        return git::clone(origin, &git.branch, repo_root)
            .map(|()| RepoAction::Cloned)
            .map_err(|e| {
                format!(
                    "cloning SUNSTONE_GIT_ORIGIN={origin} (branch {}) into {} failed: {e}. \
                     Check the origin URL, that the branch exists, and — for an ssh origin — \
                     that {SSH_KEY_ENV} is a deploy key with access.",
                    git.branch,
                    repo_root.display()
                )
            });
    }
    // Non-empty and not a repo: neither cloneable nor adoptable. Touch nothing.
    Err(format!(
        "{} is not empty and is not a git repository, so it can neither be cloned into nor \
         adopted. Nothing was changed. Empty it (for the compose stack: `docker compose down` \
         then `docker volume rm <project>_repo`), or unset SUNSTONE_GIT_ORIGIN to run the \
         git-local shape over its current contents.",
        repo_root.display()
    ))
}

/// git-local over a non-repo (§4.4's last row): `git init --initial-branch`,
/// then the seed commit **authored and committed by the sync identity** — the
/// only thing it ever authors, since no OIDC user exists at boot.
fn init_and_seed(repo_root: &Path, git: &GitConfig) -> Result<(), String> {
    git::init(repo_root, &git.branch).map_err(|e| {
        format!(
            "initialising a git repository in {} failed: {e}. {UID_HINT}.",
            repo_root.display()
        )
    })?;
    git::add_paths(repo_root, &["."]).map_err(|e| {
        format!(
            "staging the initial contents of {} failed: {e}",
            repo_root.display()
        )
    })?;
    // An empty tree (git-local with no seed and no existing content) has nothing
    // to record and `git commit` would refuse; the repo is still perfectly
    // usable, and the first Save creates the first commit. `unwrap_or(true)`
    // because a git too old to diff a HEAD-less index should let git itself
    // speak rather than stop the boot.
    if git::anything_staged(repo_root).unwrap_or(true) {
        git::commit(repo_root, &["."], SEED_COMMIT_MSG, &git.sync_identity).map_err(|e| {
            format!(
                "the seed commit in {} failed: {e}. {UID_HINT}.",
                repo_root.display()
            )
        })?;
    }
    Ok(())
}

/// §4.5 — resolve the bundle root to a canonical path.
///
/// The join itself already happened purely in [`crate::config`]
/// ([`crate::config::join_bundle_subdir`] for a git shape, `SUNSTONE_BUNDLE`
/// for plain), and containment holds **by construction** given §2.3's
/// absolute/`..` rejection — ticket 09's boot-time containment validation is
/// *gone*, not merely relaxed. This step only creates a missing subdir and
/// canonicalizes, so `sunstone-native`'s `resolve` containment check holds.
pub fn resolve_bundle_root(cfg: &Config) -> Result<PathBuf, String> {
    let path = cfg.bundle_root.clone();
    if cfg.is_git() {
        // A subdir bundle need not exist in a fresh clone or a just-initialised
        // repo. No containment check here on purpose: `config` already rejected
        // an absolute or `..`-bearing `SUNSTONE_GIT_BUNDLE_SUBDIR`.
        ensure_dir(&path, "the bundle root")?;
    }
    // Canonicalize so the seam's path checks compare like with like; fall back
    // to the path itself exactly as `main.rs` does today, since the plain
    // shape's root (including the dev default) may legitimately be missing.
    Ok(path.canonicalize().unwrap_or(path))
}

/// §4.6, first predicate — in a git shape, the **repository** must be writable
/// by our uid. Catches git over a repo we cannot write (where `commit` fails on
/// filesystem permissions, which is also why `safe.directory` is never set).
/// The message names `SUNSTONE_UID` / `SUNSTONE_GID`.
pub fn preflight_repo_writable(cfg: &Config) -> Result<(), String> {
    let Some(repo_root) = cfg.repo_root.as_ref() else {
        return Ok(()); // plain: no repo, no git
    };
    probe_writable(repo_root).map_err(|e| {
        format!(
            "{e}. A git shape commits into the repository as our own uid, so it must be \
             writable by us ({UID_HINT}). Note that git's `safe.directory` would not help: it \
             buys reads only, `commit` still fails on filesystem permissions.",
        )
    })
}

/// §4.6, second predicate — when `SUNSTONE_JWT_SECRET` is set, the **bundle**
/// must be writable by our uid. Catches a `:ro` mount plus a write secret (the
/// plain shape still writes files).
///
/// Named cost, accepted: that operator gets a container which will not start
/// rather than one that starts and 401s. Correct — they asked for writes and
/// cannot have them. Today `write.rs` commits unconditionally, so such a
/// deployment **500s at request time** with nothing visible at boot: a
/// container that looks healthy until someone loses an edit is the worst option.
pub fn preflight_bundle_writable(cfg: &Config, bundle_root: &Path) -> Result<(), String> {
    if cfg.jwt_secret.is_none() {
        return Ok(()); // read-only deployment: an unwritable bundle is fine
    }
    probe_writable(bundle_root).map_err(|e| {
        format!(
            "{e}. SUNSTONE_JWT_SECRET is set, so this deployment accepts writes and the bundle \
             must be writable by our uid ({UID_HINT}). If the bundle is a `:ro` mount, either \
             drop `:ro` or unset SUNSTONE_JWT_SECRET to run read-only — a container that starts \
             and then loses an edit is the worse outcome.",
        )
    })
}

/// Whether the checked-out repo's `origin` is the configured one. Trailing
/// slashes are ignored; nothing else is normalised, because the origin is an
/// opaque string everywhere else in this codebase (Spec 1 §7).
fn same_origin(found: &str, configured: &str) -> bool {
    found.trim().trim_end_matches('/') == configured.trim().trim_end_matches('/')
}

/// §4.4's "fail loudly, touch nothing" for an adopted repo sitting on the wrong
/// branch — a restored or hand-prepared volume with the right origin but another
/// branch checked out.
fn branch_mismatch(repo_root: &Path, configured: &str, found: Option<&str>) -> String {
    let found = match found {
        Some(branch) => format!("has {branch} checked out"),
        None => "has no branch checked out (detached HEAD, or no commits yet)".to_string(),
    };
    format!(
        "the git repository at {} {found}, but SUNSTONE_GIT_BRANCH={configured}. Nothing was \
         changed — the sync loop rebases onto origin/{configured} and pushes HEAD to \
         refs/heads/{configured}, so running it here would republish this branch's content as \
         {configured}. Either check {configured} out in the repository, set \
         SUNSTONE_GIT_BRANCH to the branch that is checked out, or discard the checkout to clone \
         afresh (for the compose stack: `docker compose down` then \
         `docker volume rm <project>_repo`).",
        repo_root.display()
    )
}

/// §4.4's loud refusal for an adopted repo pointing somewhere else. Names both
/// URLs and both ways out — the *only* place either URL is printed, since
/// `GET /api/sync-status` is content-free by rule (§10.5).
fn origin_mismatch(repo_root: &Path, configured: &str, found: Option<&str>) -> String {
    let found = match found {
        Some(url) => format!("has origin {url}"),
        None => "has no `origin` remote".to_string(),
    };
    format!(
        "the git repository at {} {found}, but SUNSTONE_GIT_ORIGIN={configured}. Nothing was \
         changed — syncing a repository to an origin it was not cloned from would push one \
         project's history into another. Either set SUNSTONE_GIT_ORIGIN to the repository's own \
         origin, or discard the checkout to clone afresh (for the compose stack: \
         `docker compose down` then `docker volume rm <project>_repo`).",
        repo_root.display()
    )
}

// --- Tests ------------------------------------------------------------------
//
// Everything runs over temp dirs and a `Config` built by hand — the whole point
// of the pure parse (§2) is that boot's filesystem behaviour is drivable without
// `/srv` and without mutating `std::env`.
//
// Two deliberate abstentions:
//
// - **No test calls [`configure_git`]** (or [`run`], which does): it writes
//   `sunstone-native`'s process-global `OnceLock`, whose committer override
//   would leak into every other git-touching test in this binary. The ordered
//   tail is driven through [`run_after_git_env`] instead.
// - **No test writes `/srv`**, so the `write_ssh_material` cases exercised here
//   are the ones that fail (or no-op) *before* any filesystem call.
#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Duration;
    use sunstone_native::git::CommitIdentity;

    use crate::testutil::{git, git_available, git_stdout, temp_dir};

    /// Whether we are root, for whom no directory mode is unwritable — a
    /// root-era CI would otherwise silently defeat the read-only probe test.
    pub(crate) fn is_root() -> bool {
        Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false)
    }

    fn sync_identity() -> CommitIdentity {
        CommitIdentity {
            name: "Sunstone Sync".into(),
            email: "sync@sunstone.invalid".into(),
        }
    }

    /// A `GitConfig` with the defaults `config::parse` would produce.
    pub(crate) fn git_config(branch: &str, origin: Option<&str>) -> GitConfig {
        GitConfig {
            branch: branch.to_string(),
            origin: origin.map(str::to_string),
            bundle_subdir: String::new(),
            sync_interval: Duration::from_secs(10),
            sync_identity: sync_identity(),
            ssh_key_pem: None,
            known_hosts: None,
        }
    }

    /// A git-shaped `Config` over a temp repo root, mirroring what
    /// `config::parse` builds (which points `repo_root` at `REPO_DIR`).
    pub(crate) fn git_shaped(repo_root: &Path, subdir: &str, origin: Option<&str>) -> Config {
        let mut git = git_config("main", origin);
        git.bundle_subdir = subdir.to_string();
        let bundle_root = crate::config::join_bundle_subdir(repo_root, subdir);
        Config {
            shape: if origin.is_some() {
                crate::config::Shape::GitSynced
            } else {
                crate::config::Shape::GitLocal
            },
            git: Some(git),
            repo_root: Some(repo_root.to_path_buf()),
            bundle_root,
            seed_from: None,
            jwt_secret: None,
            api_port: 8787,
            warnings: Vec::new(),
        }
    }

    /// Every path under `dir`, sorted — the "touched nothing" assertion.
    pub(crate) fn tree(dir: &Path) -> Vec<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
            let mut entries: Vec<_> = fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            entries.sort();
            for name in entries {
                let path = dir.join(&name);
                let rel = format!("{prefix}{name}");
                if path.is_dir() {
                    out.push(format!("{rel}/"));
                    walk(&path, &format!("{rel}/"), out);
                } else {
                    out.push(rel);
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, "", &mut out);
        out
    }

    /// A source repo with one commit on `main`, usable as a clone origin (a
    /// local path, so the tests need no network).
    fn origin_repo() -> PathBuf {
        let dir = temp_dir("origin");
        git(&dir, &["init", "-q", "--initial-branch=main"]);
        git(&dir, &["config", "user.email", "origin@example.com"]);
        git(&dir, &["config", "user.name", "Origin"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        fs::write(dir.join("upstream.md"), "hello\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "upstream"]);
        dir
    }

    // --- §4.6 the preflights --------------------------------------------------

    #[test]
    #[cfg(unix)]
    fn the_bundle_preflight_only_probes_when_a_write_secret_is_set() {
        use std::os::unix::fs::PermissionsExt;
        if is_root() {
            return;
        }
        let repo = temp_dir("preflight");
        let bundle = repo.join("bundle");
        fs::create_dir_all(&bundle).unwrap();
        fs::set_permissions(&bundle, fs::Permissions::from_mode(0o555)).unwrap();

        let mut cfg = git_shaped(&repo, "", None);
        // Read-only deployment: an unwritable bundle is none of our business.
        assert!(preflight_bundle_writable(&cfg, &bundle).is_ok());

        cfg.jwt_secret = Some(b"secret".to_vec());
        let err = preflight_bundle_writable(&cfg, &bundle).unwrap_err();
        fs::set_permissions(&bundle, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            err.contains("SUNSTONE_UID") && err.contains("SUNSTONE_GID"),
            "the preflight must name SUNSTONE_UID/SUNSTONE_GID: {err}"
        );
        assert!(err.contains("SUNSTONE_JWT_SECRET"), "{err}");
    }

    // --- §4.3 the seed copy -------------------------------------------------

    #[test]
    fn seed_copy_copies_the_contents_not_the_directory() {
        let seed = temp_dir("seed-src");
        fs::write(seed.join("a.md"), "a\n").unwrap();
        fs::create_dir_all(seed.join("sub")).unwrap();
        fs::write(seed.join("sub/b.md"), "b\n").unwrap();
        fs::write(seed.join(".hidden"), "h\n").unwrap();

        let bundle = temp_dir("seed-dest");
        let mut cfg = Config::plain(bundle.clone());
        cfg.seed_from = Some(seed.clone());

        assert!(seed_copy(&cfg, &bundle).unwrap());
        assert_eq!(
            tree(&bundle),
            vec![".hidden", "a.md", "sub/", "sub/b.md"],
            "the seed's CONTENTS must land in the bundle root, not the directory itself"
        );
        // Belt: the source directory's own name must not appear.
        let seed_name = seed.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!bundle.join(seed_name).exists());
    }

    #[test]
    fn no_seed_variable_copies_nothing() {
        let bundle = temp_dir("seed-none");
        assert!(!seed_copy(&Config::plain(bundle.clone()), &bundle).unwrap());
        assert!(tree(&bundle).is_empty());
    }

    #[test]
    fn a_missing_seed_source_names_the_variable() {
        let bundle = temp_dir("seed-missing");
        let mut cfg = Config::plain(bundle.clone());
        cfg.seed_from = Some(bundle.join("nope"));
        let err = seed_copy(&cfg, &bundle).unwrap_err();
        assert!(err.contains(SEED_FROM_ENV), "{err}");
    }

    // --- §4.4 the state machine, all six rows -------------------------------

    #[test]
    fn git_synced_clones_into_an_empty_repo_dir() {
        if !git_available() {
            return;
        }
        let origin = origin_repo();
        let repo = temp_dir("clone-dest"); // exists and is empty
        let cfg = git_shaped(&repo, "", Some(&origin.to_string_lossy()));

        assert_eq!(prepare_repo(&cfg).unwrap(), RepoAction::Cloned);
        assert!(repo.join(".git").is_dir());
        assert!(repo.join("upstream.md").is_file());
        assert_eq!(git_stdout(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    }

    #[test]
    fn git_synced_adopts_a_repo_whose_origin_matches() {
        if !git_available() {
            return;
        }
        let origin = origin_repo();
        let repo = temp_dir("adopt-match");
        git(&repo, &["clone", "-q", "--branch", "main", "--", &origin.to_string_lossy(), "."]);
        let before = tree(&repo);

        let cfg = git_shaped(&repo, "", Some(&origin.to_string_lossy()));
        assert_eq!(prepare_repo(&cfg).unwrap(), RepoAction::Adopted);
        assert_eq!(tree(&repo), before, "adopting must change nothing");
    }

    /// Origin matching is not sufficient to adopt. The loop rebases onto
    /// `origin/<branch>` and pushes `HEAD:refs/heads/<branch>`, so a repo sitting
    /// on another branch would have *that* branch's content fast-forwarded onto
    /// the configured one — silently, with no diagnostic.
    #[test]
    fn git_synced_fails_when_another_branch_is_checked_out() {
        if !git_available() {
            return;
        }
        let origin = origin_repo();
        let repo = temp_dir("adopt-branch");
        git(
            &repo,
            &[
                "clone",
                "-q",
                "--branch",
                "main",
                "--",
                &origin.to_string_lossy(),
                ".",
            ],
        );
        // A restored or hand-prepared volume: right origin, wrong branch.
        git(&repo, &["checkout", "-q", "-b", "dev"]);
        let before = tree(&repo);
        let head_before = git_stdout(&repo, &["rev-parse", "HEAD"]);

        let cfg = git_shaped(&repo, "", Some(&origin.to_string_lossy()));
        let err = prepare_repo(&cfg).unwrap_err();

        assert!(err.contains("SUNSTONE_GIT_BRANCH"), "{err}");
        assert!(err.contains("dev"), "names the branch it found: {err}");
        assert!(err.contains("main"), "names the branch configured: {err}");
        assert!(err.contains("Nothing was changed"), "{err}");
        assert_eq!(tree(&repo), before, "the refusal touches nothing");
        assert_eq!(git_stdout(&repo, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            git_stdout(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "dev",
            "and it does not switch branches under the operator"
        );
    }

    #[test]
    fn git_synced_fails_on_an_origin_mismatch_without_touching_anything() {
        if !git_available() {
            return;
        }
        let origin = origin_repo();
        let repo = temp_dir("adopt-mismatch");
        git(&repo, &["clone", "-q", "--branch", "main", "--", &origin.to_string_lossy(), "."]);
        let before = tree(&repo);
        let head_before = git_stdout(&repo, &["rev-parse", "HEAD"]);

        let cfg = git_shaped(&repo, "", Some("git@example.com:other/wiki.git"));
        let err = prepare_repo(&cfg).unwrap_err();

        assert!(err.contains("SUNSTONE_GIT_ORIGIN"), "{err}");
        assert!(err.contains("git@example.com:other/wiki.git"), "{err}");
        assert!(err.contains("Nothing was changed"), "{err}");
        assert_eq!(tree(&repo), before, "a mismatch must touch nothing");
        assert_eq!(git_stdout(&repo, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            git_stdout(&repo, &["remote", "get-url", "origin"]),
            origin.to_string_lossy(),
            "the existing origin must be left alone"
        );
    }

    #[test]
    fn git_synced_fails_on_a_non_empty_non_repo_without_touching_anything() {
        if !git_available() {
            return;
        }
        let repo = temp_dir("non-repo");
        fs::write(repo.join("stray.md"), "mine\n").unwrap();
        let before = tree(&repo);

        let cfg = git_shaped(&repo, "", Some("git@example.com:some/wiki.git"));
        let err = prepare_repo(&cfg).unwrap_err();

        assert!(err.contains("is not empty and is not a git repository"), "{err}");
        assert_eq!(tree(&repo), before, "a non-repo must be left exactly as found");
        assert!(!repo.join(".git").exists(), "nothing may be initialised here");
        assert_eq!(fs::read_to_string(repo.join("stray.md")).unwrap(), "mine\n");
    }

    #[test]
    fn git_local_adopts_an_existing_repo() {
        if !git_available() {
            return;
        }
        let repo = origin_repo(); // any repo; git-local never looks at a remote
        let before = tree(&repo);
        let cfg = git_shaped(&repo, "", None);
        assert_eq!(prepare_repo(&cfg).unwrap(), RepoAction::Adopted);
        assert_eq!(tree(&repo), before);
    }

    #[test]
    fn git_local_over_a_non_repo_seed_commits_as_the_sync_identity() {
        if !git_available() {
            return;
        }
        let seed = temp_dir("local-seed-src");
        fs::write(seed.join("a.md"), "a\n").unwrap();
        fs::create_dir_all(seed.join("sub")).unwrap();
        fs::write(seed.join("sub/b.md"), "b\n").unwrap();

        let repo = temp_dir("local-init");
        let mut cfg = git_shaped(&repo, "docs", None);
        cfg.seed_from = Some(seed.clone());

        // The whole ordered tail: preflight → resolve → seed → init+commit →
        // resolve → preflight. This is what proves the seed lands in the
        // *resolved* bundle root (`<repo>/docs`) rather than the repo root.
        let outcome = run_after_git_env(&cfg).unwrap();

        assert!(outcome.seeded);
        assert_eq!(outcome.repo_action, RepoAction::Initialized);
        assert_eq!(outcome.bundle_root, repo.join("docs"));
        assert_eq!(outcome.repo_root, Some(repo.clone()));
        assert!(repo.join("docs/a.md").is_file());
        assert!(repo.join("docs/sub/b.md").is_file());
        assert!(!repo.join("a.md").exists(), "the seed must not land in the repo root");

        // `--initial-branch` came from SUNSTONE_GIT_BRANCH, and the seed commit
        // is the only thing the sync identity ever authors — author AND
        // committer, since no OIDC user exists at boot.
        assert_eq!(git_stdout(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert_eq!(
            git_stdout(&repo, &["log", "-1", "--format=%s|%an|%ae|%cn|%ce"]),
            "seed bundle|Sunstone Sync|sync@sunstone.invalid|Sunstone Sync|sync@sunstone.invalid"
        );
        // The seeded tree is what was committed.
        assert_eq!(
            git_stdout(&repo, &["ls-files"]),
            "docs/a.md\ndocs/sub/b.md"
        );
    }

    #[test]
    fn git_local_over_an_empty_tree_initialises_without_a_commit() {
        if !git_available() {
            return;
        }
        // Nothing to record and `git commit` would refuse; the repo is still
        // usable and the first Save creates the first commit.
        let repo = temp_dir("local-empty");
        let cfg = git_shaped(&repo, "", None);
        assert_eq!(prepare_repo(&cfg).unwrap(), RepoAction::Initialized);
        assert!(repo.join(".git").is_dir());
        assert!(git::head_commit(&repo).is_none());
    }

    // --- §4.5 the bundle root -----------------------------------------------

    #[test]
    fn resolving_creates_a_missing_subdir_and_canonicalizes() {
        let repo = temp_dir("resolve");
        let cfg = git_shaped(&repo, "docs/inner", None);
        let root = resolve_bundle_root(&cfg).unwrap();
        assert_eq!(root, repo.join("docs/inner"));
        assert!(root.is_dir());
        assert_eq!(root, root.canonicalize().unwrap());
    }

    #[test]
    fn the_plain_shape_resolves_without_creating_anything() {
        let dir = temp_dir("resolve-plain");
        let missing = dir.join("absent");
        let cfg = Config::plain(missing.clone());
        // `main.rs`'s behaviour today: canonicalize if possible, otherwise pass
        // the path through — and never create it.
        assert_eq!(resolve_bundle_root(&cfg).unwrap(), missing);
        assert!(!missing.exists());
    }

    #[test]
    fn origin_comparison_ignores_only_trailing_slashes() {
        assert!(same_origin(
            "git@example.com:org/wiki.git",
            "git@example.com:org/wiki.git"
        ));
        assert!(same_origin("https://h/o/w.git/", "https://h/o/w.git"));
        // Not normalised any further on purpose: guessing an equivalence is how
        // a wiki ends up silently synced to the wrong remote.
        assert!(!same_origin("https://h/o/w", "https://h/o/w.git"));
    }
}
