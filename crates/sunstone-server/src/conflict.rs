//! The conflict resolver (Spec 2 §9): **one uniform rule, no per-case
//! analysis, no exceptions.**
//!
//! For every conflicted path `P` a rebase stops on:
//!
//! | Aspect | Rule |
//! | --- | --- |
//! | **Canonical side** | `P` takes **origin's** side. Stage 2 present → `checkout --ours P`; stage 2 absent (origin deleted `P`) → `git rm P` |
//! | **Web side** | Stage 3 present → write those bytes **verbatim** to `fork(P)`, `git add`. Stage 3 absent (web deleted `P`) → nothing to preserve; the deletion is **dropped** |
//! | **`fork(P)`** | Same directory, suffix before the final extension: `notes/foo.md` → `notes/foo-<ts>.md` |
//! | **`<ts>`** | `YYYYMMDDThhmmssZ` UTC, from the **author date of the web commit being replayed** |
//! | **Coalescing** | A `path → fork` map lives for the whole rebase **run** ([`ForkMap`]) |
//! | **Collision** | If the minted name already exists (either side, or an earlier run) → append `-2`, `-3`, … |
//! | **Exceptions** | **None.** Reserved names like `index.md` / `log.md` fork like anything else |
//!
//! In a rebase, *ours* **is** the origin base being replayed onto — which is
//! what makes "origin keeps the name" and `checkout --ours` the same operation.
//!
//! # Why (§9.1)
//!
//! - **Origin keeps `foo.md`** because origin is the shared line every clone and
//!   every inbound link references. It also buys **idempotence**: staging *ours*
//!   leaves the replayed commit with no diff on `P`, so a rejected push does not
//!   re-run the resolver next tick.
//! - **One fork per path per run.** Every Save is its own commit, so an offline
//!   stretch replays *N* commits touching `foo.md` and each re-conflicts.
//!   Naïvely that is *N* forks, of which *N-1* are intermediate drafts. The map
//!   collapses them to one fork carrying the **final** content, whose git
//!   history still holds every author's edit — so ticket 01's identity rule
//!   survives, unlike the squash ticket 07 rejected for exactly that reason.
//! - **Verbatim bytes, no frontmatter key, no body note.** The resolver stays a
//!   pure git/byte operation with no markdown or YAML knowledge: it cannot
//!   corrupt a file and works unchanged for a non-`.md` path. Provenance is
//!   already free — the replayed commit keeps its subject and OIDC author, and
//!   stripping `-<ts>` recovers the canonical path.
//! - **Beside the original**, so the fork's own relative links keep resolving
//!   and it sits next to the file it must be diffed against. Not `conflicts/`
//!   (breaks those links), not `.conflicts/` or a gitignored path (the walker is
//!   hidden- and gitignore-aware, so the fork would vanish from the index).
//! - **The author date, not the wall clock**, because it records when the edit
//!   was *made* and is stable across an aborted-rebase retry.
//!
//! # Reaching the file (§9.2)
//!
//! Write the fork with plain filesystem + `git add`. **Never** through
//! `write.rs`'s `rename_path` / `move_path`: those trigger inbound + outbound
//! link rewriting, which would drag the whole bundle's links onto the fork.
//! Inbound links stay pointing at the canonical `foo.md`; the orphaned fork is
//! tolerated.
//!
//! # Path relativity: the resolver is repo-root-relative throughout
//!
//! Every `git.rs` primitive the resolver uses runs with the **repository** root
//! as git's working directory and speaks paths relative to it —
//! [`sunstone_native::git::unmerged_paths`] included — because a rebase covers
//! the whole repo even when the Bundle is a subdirectory
//! (`SUNSTONE_GIT_BUNDLE_SUBDIR`). Conflicts *outside* the bundle subdir must be
//! resolved too, or `rebase --continue` refuses on a leftover unmerged entry.
//!
//! So **[`Resolution`] carries repo-root-relative paths**, and the strip to the
//! bundle-relative, forward-slash path §10.2 requires happens **once, at the
//! notice boundary in `sync.rs`**, via [`Resolution::to_bundle_relative`] before
//! `SyncNotice::from_resolution`. `to_bundle_relative` returns `None` for a path
//! outside the bundle: that conflict is still resolved, it just produces no
//! user-facing notice, because a notice naming a path no client can open is
//! noise. Doing the strip here instead would mean either threading the subdir
//! through [`resolve_all_unmerged`] (whose signature is fixed, and which needs
//! the *unstripped* path for every git call anyway) or keeping two path flavours
//! alive inside one function — the exact ambiguity this note exists to close.

use std::collections::BTreeMap;
use std::path::Path;

use sunstone_native::git;

/// What one conflicted path's resolution actually did. **Notices are emitted
/// from which branch a resolution took, not from emptiness** (§9.4): deriving
/// them from emptiness would miss both a fork inside a non-empty commit and a
/// dropped deletion that a sibling fork made non-empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Stage 3 was present: the web bytes were written verbatim to `fork` and
    /// staged. `path` keeps origin's content.
    Forked { path: String, fork: String },
    /// Stage 2 present, stage 3 absent: the web side deleted `path` while
    /// origin modified it. **Origin's file survives and the web deletion is
    /// dropped** — a deletion carries no content, so nothing is *lost*, only
    /// the intent, and origin's concurrent edit is evidence someone still wants
    /// the file. The single case where a web action does not survive, hence
    /// §10.2 surfaces it (§9.3).
    DeletionDropped { path: String },
}

impl Resolution {
    /// The path the notice is *about* (the canonical path in both variants),
    /// **repo-root-relative** — see the module note on path relativity;
    /// [`Self::to_bundle_relative`] is what makes it user-facing.
    #[allow(dead_code)] // the resolver's documented accessor; the loop matches on the variants
    pub fn path(&self) -> &str {
        match self {
            Resolution::Forked { path, .. } => path,
            Resolution::DeletionDropped { path } => path,
        }
    }

    /// The same resolution with both paths made **bundle-relative** (§10.2), or
    /// `None` when the canonical path lies outside `bundle_subdir` — resolved
    /// all the same, but not something to tell a client about.
    ///
    /// `bundle_subdir` is `GitConfig::bundle_subdir` (empty = the bundle *is*
    /// the repo root, the common case, where this is a copy).
    pub fn to_bundle_relative(&self, bundle_subdir: &str) -> Option<Resolution> {
        match self {
            Resolution::Forked { path, fork } => Some(Resolution::Forked {
                path: bundle_relative(path, bundle_subdir)?,
                // The fork is a sibling of `path`, so it is inside the bundle
                // whenever `path` is; the `?` is belt-and-braces.
                fork: bundle_relative(fork, bundle_subdir)?,
            }),
            Resolution::DeletionDropped { path } => Some(Resolution::DeletionDropped {
                path: bundle_relative(path, bundle_subdir)?,
            }),
        }
    }
}

/// Strip `bundle_subdir` off a repo-root-relative path, yielding the
/// bundle-relative forward-slash path §10.2's payload carries. `None` when the
/// path is not inside the subdir.
///
/// Matches on whole components (`docs` never matches `docsy/a.md`) and tolerates
/// the surrounding slashes `config.rs`'s `join_bundle_subdir` also trims.
pub fn bundle_relative(repo_relative: &str, bundle_subdir: &str) -> Option<String> {
    let subdir = bundle_subdir.trim().trim_matches('/');
    if subdir.is_empty() {
        return Some(repo_relative.to_string());
    }
    let rest = repo_relative
        .strip_prefix(subdir)?
        .strip_prefix('/')
        .filter(|rest| !rest.is_empty())?;
    Some(rest.to_string())
}

/// The per-**run** `path → fork` coalescing map (§9's Coalescing row). The
/// first conflict on `P` mints the name; every later conflicting commit on `P`
/// in the same rebase run writes to that **same** path, so N replayed commits
/// touching one file produce **one** fork carrying the final content.
///
/// Lives for the duration of one rebase run and is then dropped — a later run
/// mints a fresh name, and [`disambiguate`] keeps it from colliding with the
/// earlier one.
#[derive(Debug, Default)]
pub struct ForkMap {
    minted: BTreeMap<String, String>,
}

impl ForkMap {
    /// An empty map for one rebase run.
    pub fn new() -> Self {
        ForkMap {
            minted: BTreeMap::new(),
        }
    }

    /// The fork already minted for `path` in this run, if any.
    #[allow(dead_code)] // the coalescing invariant's test seam; `fork_for` is the loop's call
    pub fn get(&self, path: &str) -> Option<&str> {
        self.minted.get(path).map(String::as_str)
    }

    /// The fork path to write for `path`: the one already minted in this run,
    /// or a freshly minted [`fork_path`] disambiguated by `exists` against
    /// **both sides and earlier runs**.
    ///
    /// `ts` is the [`fork_timestamp`] of the commit being replayed; it is
    /// ignored once a name exists for `path`.
    pub fn fork_for(&mut self, path: &str, ts: &str, exists: impl Fn(&str) -> bool) -> String {
        // The already-minted name wins unconditionally — that *is* the
        // coalescing rule: a later commit on `P` in the same run rewrites the
        // same fork, so N offline saves collapse to one fork holding the final
        // content. `ts` is deliberately ignored on that path, which is why a
        // later replayed commit's (newer) author date never renames the fork.
        if let Some(existing) = self.minted.get(path) {
            return existing.clone();
        }
        let fork = disambiguate(&fork_path(path, ts), exists);
        self.minted.insert(path.to_string(), fork.clone());
        fork
    }

    /// Every resolution minted in this run, by canonical path — the source of
    /// the run's log lines.
    #[allow(dead_code)] // §9.4: the loop logs from the resolution record, not from the map
    pub fn entries(&self) -> impl Iterator<Item = (&str, &str)> {
        self.minted.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }
}

/// The fork name for `path` at `ts`: same directory, suffix inserted **before
/// the final extension** — `notes/foo.md` → `notes/foo-<ts>.md`. A path with no
/// extension gets the suffix appended. **Pure**, and the unit-test seam for
/// §9's naming rule.
pub fn fork_path(path: &str, ts: &str) -> String {
    let (stem, ext) = split_extension(path);
    format!("{stem}-{ts}{ext}")
}

/// Split a forward-slash path into `(everything before the final extension,
/// the extension including its dot)`. `""` for the extension when the final
/// component has none.
///
/// The dot must be *inside* the final component and not its first byte, so a
/// dotfile is a hidden **name**, not an extension: `.gitignore` →
/// `(".gitignore", "")`, and `notes/.hidden.md` → `("notes/.hidden", ".md")`.
/// Only the **final** extension moves: `a.tar.gz` → `("a.tar", ".gz")`.
fn split_extension(path: &str) -> (&str, &str) {
    let name_start = path.rfind('/').map_or(0, |i| i + 1);
    match path[name_start..].rfind('.') {
        Some(dot) if dot > 0 => path.split_at(name_start + dot),
        _ => (path, ""),
    }
}

/// How many `-N` attempts [`disambiguate`] makes before falling back to a
/// nanosecond stamp. Unreachable in practice (it would take 1,000 forks of one
/// path in one second); the bound exists because the alternative to *some*
/// fallback is either an unbounded loop or returning an occupied path, and the
/// fork is written with a plain filesystem write that would clobber it.
const MAX_DISAMBIGUATION: u32 = 1_000;

/// Append `-2`, `-3`, … before the extension until `exists` says the name is
/// free (§9's Collision row). Pure over the `exists` predicate, so the
/// same-second-collision case is unit-testable without a repo; the caller
/// passes a closure that checks the working tree **and** the index.
pub fn disambiguate(candidate: &str, exists: impl Fn(&str) -> bool) -> String {
    if !exists(candidate) {
        return candidate.to_string();
    }
    let (stem, ext) = split_extension(candidate);
    for n in 2..=MAX_DISAMBIGUATION {
        let next = format!("{stem}-{n}{ext}");
        if !exists(&next) {
            return next;
        }
    }
    // Never clobber: a name nothing sane can already hold.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{stem}-{nanos}{ext}")
}

/// The stamp used when git handed back something that is not a `<ts>` at all
/// (no `REBASE_HEAD`, a garbled date). Same shape and length, so stripping
/// `-<ts>` still recovers the canonical path, and obviously synthetic.
/// Collisions between two such forks fall to [`disambiguate`]'s `-2`.
const UNKNOWN_TS: &str = "00000000T000000Z";

/// Format an author date as §9's `<ts>`: `YYYYMMDDThhmmssZ`, UTC.
///
/// Sourced from [`sunstone_native::git::rebase_head_timestamp`], which asks git
/// to format it (there is no time crate in this workspace); this helper exists
/// so the shape is validated in one place and the loop can substitute a stamp.
///
/// Validation is a **filename** guard, not date arithmetic: anything that is not
/// exactly `8 digits`+`T`+`6 digits`+`Z` becomes [`UNKNOWN_TS`], so no byte git
/// ever prints (a `/`, a `..`, a quote, a newline) can reach a minted path.
pub fn fork_timestamp(git_formatted: &str) -> String {
    let ts = git_formatted.trim();
    if is_ts_shaped(ts) {
        ts.to_string()
    } else {
        UNKNOWN_TS.to_string()
    }
}

/// Whether `ts` is exactly §9's `YYYYMMDDThhmmssZ`.
fn is_ts_shaped(ts: &str) -> bool {
    let bytes = ts.as_bytes();
    bytes.len() == 16
        && bytes[8] == b'T'
        && bytes[15] == b'Z'
        && bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[9..15].iter().all(u8::is_ascii_digit)
}

/// Resolve **every** unmerged path of the currently stopped rebase, in one
/// uniform pass, and report which branch each took.
///
/// `repo_root` is the repository root (git runs there, not at the bundle root).
/// `forks` is the run-scoped [`ForkMap`], carried across every stop of one
/// rebase. `ts` is the replayed commit's [`fork_timestamp`].
///
/// Per path, from `git ls-files --unmerged` / `git show :N:path`:
/// stage 2 present → `checkout --ours`; absent → `git rm`. Stage 3 present →
/// write verbatim to the fork + `git add` ([`Resolution::Forked`]); absent →
/// [`Resolution::DeletionDropped`].
///
/// Both stages absent (only the base stage 1 survives) is **both sides deleted
/// `P`**: honour it with the same `git rm` and report nothing — the two sides
/// agree, no content and no intent is lost, so §10.2 has nothing to say.
///
/// Returned paths are **repo-root-relative** (see the module note); `sync.rs`
/// strips them with [`Resolution::to_bundle_relative`].
///
/// Returns `Err` for a state the resolver does not recognise; §8.3 then requires
/// the caller to `rebase --abort`, log the git error text, and retry next tick.
pub fn resolve_all_unmerged(
    repo_root: &Path,
    forks: &mut ForkMap,
    ts: &str,
) -> Result<Vec<Resolution>, String> {
    let mut resolutions = Vec::new();
    for path in git::unmerged_paths(repo_root)? {
        // **Read both stages before touching the index.** `checkout_ours` stages
        // the path and `rm_path` removes it — either collapses the unmerged entry
        // and stages 1-3 stop resolving, so a later `stage_entry(3)` would report
        // a web deletion that never happened.
        let ours = git::stage_entry(repo_root, &path, 2);
        let theirs = git::stage_entry(repo_root, &path, 3);

        // Canonical side: `P` is origin's, always. In a rebase *ours* IS the
        // origin base being replayed onto.
        if ours.is_some() {
            git::checkout_ours(repo_root, &path)?;
        } else {
            git::rm_path(repo_root, &path)?;
        }

        // Web side: preserve the bytes, or accept that a deletion has none.
        match theirs {
            Some(bytes) => {
                let fork = forks.fork_for(&path, ts, |candidate| {
                    exists_either_side(repo_root, candidate)
                });
                write_fork(repo_root, &fork, &bytes)?;
                git::add_paths(repo_root, &[&fork])?;
                resolutions.push(Resolution::Forked { path, fork });
            }
            None if ours.is_some() => {
                resolutions.push(Resolution::DeletionDropped { path });
            }
            // Both sides deleted it — nothing preserved, nothing surfaced.
            None => {}
        }
    }
    Ok(resolutions)
}

/// Write `bytes` **verbatim** to `fork` (repo-root-relative) with a plain
/// filesystem write — §9.2's "reach the file directly", never `write.rs`'s
/// rename/move path, which would rewrite the whole bundle's links onto the fork.
///
/// Creates the parent directory: honouring origin's deletion can have just
/// removed the last file in it, and `git rm` prunes the empty directory.
/// Truncating an existing fork is the coalescing rule working as intended — the
/// second conflicting commit on `P` overwrites the first's draft.
fn write_fork(repo_root: &Path, fork: &str, bytes: &[u8]) -> Result<(), String> {
    let abs = repo_root.join(fork);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(&abs, bytes).map_err(|e| format!("could not write {}: {e}", abs.display()))
}

/// Whether `rel` exists on **either** side — working tree or index — the
/// `exists` predicate [`ForkMap::fork_for`] needs so a fork never lands on a
/// path an earlier run already minted or origin already carries.
///
/// The index is asked through [`sunstone_native::git::stage_entry`] rather than a
/// second git seam of our own: stage **0** is the ordinary merged entry (an
/// earlier run's committed fork, or origin's own file), stages **2** and **3**
/// cover a candidate name that is *itself* conflicted in this very stop, where
/// there is no stage 0 to find.
pub fn exists_either_side(repo_root: &Path, rel: &str) -> bool {
    if repo_root.join(rel).exists() {
        return true;
    }
    [0u8, 2, 3]
        .iter()
        .any(|stage| git::stage_entry(repo_root, rel, *stage).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use sunstone_native::git::RebaseOutcome;

    // --- The pure helpers (§9's naming and collision rules) ------------------

    #[test]
    fn fork_path_inserts_the_stamp_before_the_final_extension() {
        const TS: &str = "20260726T101500Z";
        assert_eq!(
            fork_path("notes/foo.md", TS),
            "notes/foo-20260726T101500Z.md"
        );
        assert_eq!(fork_path("foo.md", TS), "foo-20260726T101500Z.md");
        // No exceptions: a reserved Concept name forks like anything else.
        assert_eq!(fork_path("index.md", TS), "index-20260726T101500Z.md");
        assert_eq!(fork_path("notes/log.md", TS), "notes/log-20260726T101500Z.md");
        // No extension: appended.
        assert_eq!(fork_path("notes/LICENSE", TS), "notes/LICENSE-20260726T101500Z");
        // A dotfile is a hidden *name*, not an extension.
        assert_eq!(fork_path(".gitignore", TS), ".gitignore-20260726T101500Z");
        assert_eq!(
            fork_path("notes/.hidden.md", TS),
            "notes/.hidden-20260726T101500Z.md"
        );
        // Only the final extension moves, and a dot in a *directory* is not one.
        assert_eq!(fork_path("a/b.c/d.tar.gz", TS), "a/b.c/d.tar-20260726T101500Z.gz");
        assert_eq!(fork_path("a.d/plain", TS), "a.d/plain-20260726T101500Z");
    }

    #[test]
    fn disambiguate_appends_2_then_3_before_the_extension() {
        let free = disambiguate("notes/f-20260726T101500Z.md", |_| false);
        assert_eq!(free, "notes/f-20260726T101500Z.md");

        let taken = ["notes/f-20260726T101500Z.md"];
        assert_eq!(
            disambiguate("notes/f-20260726T101500Z.md", |c| taken.contains(&c)),
            "notes/f-20260726T101500Z-2.md"
        );

        let taken = [
            "notes/f-20260726T101500Z.md",
            "notes/f-20260726T101500Z-2.md",
        ];
        assert_eq!(
            disambiguate("notes/f-20260726T101500Z.md", |c| taken.contains(&c)),
            "notes/f-20260726T101500Z-3.md"
        );
        // Extensionless candidates disambiguate too.
        let taken = ["LICENSE-20260726T101500Z"];
        assert_eq!(
            disambiguate("LICENSE-20260726T101500Z", |c| taken.contains(&c)),
            "LICENSE-20260726T101500Z-2"
        );
    }

    #[test]
    fn disambiguate_terminates_and_never_returns_an_occupied_name() {
        // Pathological predicate: it must still terminate, and must not hand back
        // a path a plain filesystem write would clobber.
        let out = disambiguate("notes/f-20260726T101500Z.md", |_| true);
        assert_ne!(out, "notes/f-20260726T101500Z.md");
        assert!(out.starts_with("notes/f-20260726T101500Z-"));
        assert!(out.ends_with(".md"));
    }

    #[test]
    fn fork_timestamp_keeps_a_well_shaped_stamp_and_replaces_anything_else() {
        assert_eq!(fork_timestamp("20260726T101500Z"), "20260726T101500Z");
        // git's stdout arrives with a trailing newline.
        assert_eq!(fork_timestamp("20260726T101500Z\n"), "20260726T101500Z");
        // Anything else could put a path separator or worse into a filename.
        for bad in [
            "",
            "2026-07-26T10:15:00Z",
            "20260726T101500",
            "20260726T101500Zx",
            "2026072aT101500Z",
            "../../etc/passwd",
        ] {
            assert_eq!(fork_timestamp(bad), UNKNOWN_TS, "for {bad:?}");
        }
    }

    #[test]
    fn the_fork_map_coalesces_a_path_and_ignores_later_stamps() {
        let mut forks = ForkMap::new();
        let first = forks.fork_for("notes/f.md", "20260726T101500Z", |_| false);
        assert_eq!(first, "notes/f-20260726T101500Z.md");
        // A later commit on the same path in the same run reuses the name, so N
        // offline saves collapse into one fork holding the final content — even
        // though its author date (and thus its stamp) is newer.
        let second = forks.fork_for("notes/f.md", "20260726T101600Z", |_| true);
        assert_eq!(second, first);
        assert_eq!(forks.get("notes/f.md"), Some(first.as_str()));
        // A different path mints its own.
        let other = forks.fork_for("notes/g.md", "20260726T101600Z", |_| false);
        assert_eq!(other, "notes/g-20260726T101600Z.md");
        assert_eq!(
            forks.entries().collect::<Vec<_>>(),
            vec![
                ("notes/f.md", "notes/f-20260726T101500Z.md"),
                ("notes/g.md", "notes/g-20260726T101600Z.md"),
            ]
        );
    }

    // --- §10.2's bundle-relative strip --------------------------------------

    #[test]
    fn bundle_relative_strips_whole_components_only() {
        // The common case: the bundle IS the repo root.
        assert_eq!(
            bundle_relative("notes/f.md", "").as_deref(),
            Some("notes/f.md")
        );
        assert_eq!(
            bundle_relative("docs/wiki/notes/f.md", "docs/wiki").as_deref(),
            Some("notes/f.md")
        );
        // Surrounding slashes are tolerated, as in `config::join_bundle_subdir`.
        assert_eq!(
            bundle_relative("docs/wiki/f.md", "/docs/wiki/").as_deref(),
            Some("f.md")
        );
        // Outside the bundle: resolved, but nothing to tell a client.
        assert_eq!(bundle_relative("README.md", "docs"), None);
        assert_eq!(bundle_relative("docsy/f.md", "docs"), None);
        assert_eq!(bundle_relative("docs", "docs"), None);
    }

    #[test]
    fn a_resolution_maps_both_paths_into_the_bundle() {
        let forked = Resolution::Forked {
            path: "docs/wiki/notes/f.md".into(),
            fork: "docs/wiki/notes/f-20260726T101500Z.md".into(),
        };
        assert_eq!(
            forked.to_bundle_relative("docs/wiki"),
            Some(Resolution::Forked {
                path: "notes/f.md".into(),
                fork: "notes/f-20260726T101500Z.md".into(),
            })
        );
        assert_eq!(forked.to_bundle_relative("other"), None);

        let dropped = Resolution::DeletionDropped {
            path: "docs/wiki/f.md".into(),
        };
        assert_eq!(
            dropped.to_bundle_relative("docs/wiki"),
            Some(Resolution::DeletionDropped { path: "f.md".into() })
        );
    }

    // --- Live-git tests over real temp repos, skipped cleanly when `git` is
    // absent from PATH (the convention in write.rs / history.rs / git.rs). ---

    use crate::testutil::{
        commit_all, git as run, git_available, git_stdout as stdout, local_identity, put, read,
        temp_dir,
    };

    /// A repo on `main` whose identity and signing come from the repo, never the
    /// ambient `~/.gitconfig`.
    fn repo_on_main(tag: &str) -> PathBuf {
        let root = temp_dir(tag);
        run(&root, &["init", "-q", "--initial-branch=main"]);
        local_identity(&root);
        root
    }

    /// `origin/main` is just a ref as far as a rebase is concerned, so divergence
    /// needs no network and no second repository.
    fn plant_origin(root: &Path) {
        let sha = stdout(root, &["rev-parse", "HEAD"]);
        run(root, &["update-ref", "refs/remotes/origin/main", &sha]);
    }

    /// Base commit → an origin-side commit planted as `origin/main` → local
    /// `main` rewound to the base → the web-side commits. A genuine fork.
    fn diverged(
        tag: &str,
        base: impl Fn(&Path),
        origin_side: impl Fn(&Path),
        web_side: impl Fn(&Path),
    ) -> PathBuf {
        let root = repo_on_main(tag);
        base(&root);
        commit_all(&root, "base", None);
        let base_sha = stdout(&root, &["rev-parse", "HEAD"]);

        origin_side(&root);
        commit_all(&root, "edit on origin", None);
        plant_origin(&root);

        run(&root, &["reset", "-q", "--hard", &base_sha]);
        web_side(&root);
        root
    }

    /// The plain `notes/f.md` base every conflict class here diverges from.
    fn base_note(root: &Path) {
        put(root, "notes/f.md", b"base\n");
    }

    /// §8.2's replay loop, minus fetch and push: rebase, then resolve → continue
    /// (or skip when nothing is staged) until the rebase finishes. Returns the
    /// resolutions and how many commits ended up **empty** (`--skip`), because
    /// §9.4 keeps those two facts apart: emptiness decides continue-vs-skip,
    /// the resolution record drives notices.
    fn replay(root: &Path, forks: &mut ForkMap) -> (Vec<Resolution>, usize) {
        let mut resolutions = Vec::new();
        let mut skips = 0;
        let mut outcome = git::rebase_onto(root, "main").unwrap();
        let mut guard = 0;
        while outcome == RebaseOutcome::Stopped {
            guard += 1;
            assert!(guard < 16, "the resolver is not converging");
            let ts = fork_timestamp(&git::rebase_head_timestamp(root).unwrap());
            resolutions.extend(resolve_all_unmerged(root, forks, &ts).unwrap());
            assert!(
                git::unmerged_paths(root).unwrap().is_empty(),
                "every conflict must be resolved before --continue"
            );
            outcome = if git::anything_staged(root).unwrap() {
                git::rebase_continue(root).unwrap()
            } else {
                skips += 1;
                git::rebase_skip(root).unwrap()
            };
        }
        assert_eq!(outcome, RebaseOutcome::Completed);
        (resolutions, skips)
    }

    /// Every entry of `notes/`, sorted — the "exactly one fork" assertion.
    fn notes_dir(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root.join("notes"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    const WEB_DATE: &str = "2026-07-26T10:15:00+00:00";
    const WEB_TS: &str = "20260726T101500Z";
    /// Deliberately not valid UTF-8: the fork is written **verbatim**, so a lossy
    /// round-trip anywhere in the resolver would corrupt a non-text file.
    const WEB_BYTES: &[u8] = b"web version\n\xff\xfe\x80 tail\n";

    #[test]
    fn a_clean_rebase_yields_nothing_to_resolve() {
        if !git_available() {
            return;
        }
        // Disjoint paths: git replays the web commit with no conflict at all.
        let root = diverged(
            "clean",
            base_note,
            |r| put(r, "origin-only.md", b"origin\n"),
            |r| {
                put(r, "web-only.md", b"web\n");
                commit_all(r, "web save", Some(WEB_DATE));
            },
        );

        let mut forks = ForkMap::new();
        let (resolutions, skips) = replay(&root, &mut forks);
        assert!(resolutions.is_empty(), "no conflict, so no resolution");
        assert_eq!(skips, 0);
        assert_eq!(forks.entries().count(), 0, "nothing was minted");
        // Both sides survive under their own names, and there is no fork.
        assert_eq!(read(&root, "origin-only.md"), b"origin\n");
        assert_eq!(read(&root, "web-only.md"), b"web\n");
        assert_eq!(notes_dir(&root), vec!["f.md".to_string()]);
        // Note this proves the resolver has NOTHING to do on a clean rebase, not
        // that the loop refrains from calling it — `sync.rs`'s tick owns that,
        // since a clean rebase simply never reports `Stopped`.
        assert!(resolve_all_unmerged(&root, &mut forks, WEB_TS)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_text_conflict_keeps_origins_bytes_and_forks_the_web_side() {
        if !git_available() {
            return;
        }
        let root = diverged(
            "text",
            base_note,
            |r| put(r, "notes/f.md", b"origin version\n"),
            |r| {
                put(r, "notes/f.md", b"web version\n");
                commit_all(r, "web save", Some(WEB_DATE));
            },
        );

        let mut forks = ForkMap::new();
        let (resolutions, skips) = replay(&root, &mut forks);

        let fork = format!("notes/f-{WEB_TS}.md");
        assert_eq!(
            resolutions,
            vec![Resolution::Forked {
                path: "notes/f.md".into(),
                fork: fork.clone(),
            }]
        );
        assert_eq!(skips, 0, "the fork itself makes the commit non-empty");
        // Origin keeps the name; the web bytes live beside it, verbatim — no
        // conflict markers, no frontmatter key, no body note.
        assert_eq!(read(&root, "notes/f.md"), b"origin version\n");
        assert_eq!(read(&root, &fork), b"web version\n");
        assert_eq!(notes_dir(&root), vec![format!("f-{WEB_TS}.md"), "f.md".to_string()]);
        // The fork is tracked, so the walker and a later run both see it.
        assert_eq!(
            stdout(&root, &["ls-files", "--", &fork]),
            fork,
            "the fork must be committed, not left untracked"
        );
        // §10.2's payload is bundle-relative; here the bundle IS the repo root.
        assert_eq!(
            resolutions[0].to_bundle_relative(""),
            Some(resolutions[0].clone())
        );
        assert_eq!(resolutions[0].path(), "notes/f.md");
    }

    #[test]
    fn an_add_add_conflict_forks_like_any_other() {
        if !git_available() {
            return;
        }
        // Both sides create the same new path — no base version exists.
        let root = diverged(
            "addadd",
            base_note,
            |r| put(r, "notes/index.md", b"origin index\n"),
            |r| {
                put(r, "notes/index.md", b"web index\n");
                commit_all(r, "web save", Some(WEB_DATE));
            },
        );

        let mut forks = ForkMap::new();
        let (resolutions, _) = replay(&root, &mut forks);

        // "Exceptions: none" — a reserved Concept name forks like anything else.
        let fork = format!("notes/index-{WEB_TS}.md");
        assert_eq!(
            resolutions,
            vec![Resolution::Forked {
                path: "notes/index.md".into(),
                fork: fork.clone(),
            }]
        );
        assert_eq!(read(&root, "notes/index.md"), b"origin index\n");
        assert_eq!(read(&root, &fork), b"web index\n");
    }

    #[test]
    fn origin_deleted_web_modified_honours_the_deletion_and_forks_verbatim() {
        if !git_available() {
            return;
        }
        // §9.3, first direction: stage 2 absent, stage 3 present.
        let root = diverged(
            "origin-delete",
            base_note,
            |r| std::fs::remove_file(r.join("notes/f.md")).unwrap(),
            |r| {
                put(r, "notes/f.md", WEB_BYTES);
                commit_all(r, "web save", Some(WEB_DATE));
            },
        );

        let mut forks = ForkMap::new();
        let (resolutions, _) = replay(&root, &mut forks);

        let fork = format!("notes/f-{WEB_TS}.md");
        assert_eq!(
            resolutions,
            vec![Resolution::Forked {
                path: "notes/f.md".into(),
                fork: fork.clone(),
            }]
        );
        assert!(
            !root.join("notes/f.md").exists(),
            "origin's deletion is honoured"
        );
        // Byte-identical, including the invalid UTF-8 — the resolver never
        // parses, decodes or re-encodes what it preserves.
        assert_eq!(read(&root, &fork), WEB_BYTES);
        assert_eq!(notes_dir(&root), vec![format!("f-{WEB_TS}.md")]);
    }

    #[test]
    fn web_deleted_origin_modified_keeps_origin_and_drops_the_deletion() {
        if !git_available() {
            return;
        }
        // §9.3, other direction: stage 2 present, stage 3 absent. The single
        // case where a web action does not survive, hence §10.2 surfaces it.
        let root = diverged(
            "web-delete",
            base_note,
            |r| put(r, "notes/f.md", b"origin version\n"),
            |r| {
                std::fs::remove_file(r.join("notes/f.md")).unwrap();
                commit_all(r, "web delete", Some(WEB_DATE));
            },
        );

        let mut forks = ForkMap::new();
        let (resolutions, skips) = replay(&root, &mut forks);

        assert_eq!(
            resolutions,
            vec![Resolution::DeletionDropped {
                path: "notes/f.md".into(),
            }]
        );
        // §9.4: the commit was empty (so it had to be skipped) and the notice
        // still exists — proof the notice comes from the resolution branch, not
        // from emptiness.
        assert_eq!(skips, 1);
        assert_eq!(read(&root, "notes/f.md"), b"origin version\n");
        assert_eq!(notes_dir(&root), vec!["f.md".to_string()], "no fork: a deletion has no content");
        assert_eq!(forks.entries().count(), 0);
    }

    /// §9.4's **motivating** case, and the reason notices are driven by the
    /// resolution branch rather than by emptiness: one commit that both drops a
    /// web deletion *and* forks a sibling. The commit is non-empty (the fork is
    /// staged), so an emptiness-derived notice would miss the dropped deletion
    /// entirely.
    #[test]
    fn a_dropped_deletion_still_surfaces_inside_a_commit_a_sibling_fork_made_non_empty() {
        if !git_available() {
            return;
        }
        let root = diverged(
            "mixed",
            |r| {
                put(r, "notes/f.md", b"base f\n");
                put(r, "notes/g.md", b"base g\n");
            },
            |r| {
                // origin modifies BOTH, so both conflict.
                put(r, "notes/f.md", b"origin f\n");
                put(r, "notes/g.md", b"origin g\n");
            },
            |r| {
                // One commit: delete f (deletion will be dropped), edit g (forks).
                std::fs::remove_file(r.join("notes/f.md")).unwrap();
                put(r, "notes/g.md", WEB_BYTES);
                commit_all(r, "web delete f, edit g", Some(WEB_DATE));
            },
        );

        let mut forks = ForkMap::new();
        let (resolutions, skips) = replay(&root, &mut forks);

        let fork = format!("notes/g-{WEB_TS}.md");
        assert!(
            resolutions.contains(&Resolution::DeletionDropped {
                path: "notes/f.md".into()
            }),
            "the dropped deletion is surfaced even though the commit was not empty: {resolutions:?}"
        );
        assert!(
            resolutions.contains(&Resolution::Forked {
                path: "notes/g.md".into(),
                fork: fork.clone(),
            }),
            "{resolutions:?}"
        );
        assert_eq!(resolutions.len(), 2);
        // Non-empty, so it was committed rather than skipped — the exact
        // combination an emptiness-derived notice would get wrong.
        assert_eq!(skips, 0, "the sibling fork made the commit non-empty");
        assert_eq!(read(&root, "notes/f.md"), b"origin f\n");
        assert_eq!(read(&root, "notes/g.md"), b"origin g\n");
        assert_eq!(read(&root, &fork), WEB_BYTES);
    }

    /// Both stages absent — the `None => {}` arm. A normal rebase does **not**
    /// produce this (git auto-resolves an identical deletion on both sides with
    /// no conflict at all), so it is defensive code, and the only honest way to
    /// exercise it is to fabricate the unmerged index entry git would have to hand
    /// us. This also pins the thing that was otherwise unverified: `rm_path`'s
    /// `-f -q --` on an entry that has only stage 1 and no worktree file.
    #[test]
    fn an_unmerged_entry_with_neither_stage_is_removed_and_surfaces_nothing() {
        if !git_available() {
            return;
        }
        let root = repo_on_main("stage1-only");
        base_note(&root);
        commit_all(&root, "base", None);
        let blob = stdout(&root, &["rev-parse", "HEAD:notes/f.md"]);

        // Replace the stage-0 entry with a stage-1-only (base only) entry and
        // drop the worktree file: "both sides deleted it".
        run(&root, &["rm", "-q", "--cached", "notes/f.md"]);
        std::fs::remove_file(root.join("notes/f.md")).unwrap();
        let mut child = std::process::Command::new("git")
            .current_dir(&root)
            .args(["update-index", "--index-info"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        write!(
            child.stdin.as_mut().unwrap(),
            "100644 {blob} 1\tnotes/f.md\n"
        )
        .unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(
            git::unmerged_paths(&root).unwrap(),
            vec!["notes/f.md".to_string()],
            "the fixture really is unmerged, so the branch is genuinely reached"
        );

        let mut forks = ForkMap::new();
        let resolutions = resolve_all_unmerged(&root, &mut forks, WEB_TS).unwrap();

        assert!(
            resolutions.is_empty(),
            "neither side wants it: nothing lost, nothing dropped, nothing to surface: {resolutions:?}"
        );
        assert_eq!(forks.entries().count(), 0, "nothing minted");
        assert!(!root.join("notes/f.md").exists(), "it stays deleted");
        assert!(
            git::unmerged_paths(&root).unwrap().is_empty(),
            "and the entry is resolved, so `rebase --continue` will not refuse"
        );
    }

    #[test]
    fn a_same_second_collision_appends_2() {
        if !git_available() {
            return;
        }
        // origin already carries the exact name this second's stamp mints — an
        // earlier run's fork, replayed here as "already exists on either side".
        let taken = format!("notes/f-{WEB_TS}.md");
        let root = diverged(
            "collision",
            base_note,
            |r| {
                put(r, "notes/f.md", b"origin version\n");
                put(r, &taken, b"an earlier run's fork\n");
            },
            |r| {
                put(r, "notes/f.md", b"web version\n");
                commit_all(r, "web save", Some(WEB_DATE));
            },
        );

        let mut forks = ForkMap::new();
        let (resolutions, _) = replay(&root, &mut forks);

        let fork = format!("notes/f-{WEB_TS}-2.md");
        assert_eq!(
            resolutions,
            vec![Resolution::Forked {
                path: "notes/f.md".into(),
                fork: fork.clone(),
            }]
        );
        assert_eq!(
            read(&root, &taken),
            b"an earlier run's fork\n",
            "the earlier fork must not be clobbered"
        );
        assert_eq!(read(&root, &fork), b"web version\n");
    }

    #[test]
    fn n_commits_on_one_path_yield_one_fork_with_the_final_content() {
        if !git_available() {
            return;
        }
        // An offline stretch: three Saves, three commits, each re-conflicting
        // (after the first resolution `notes/f.md` holds origin's content again).
        let root = diverged(
            "coalesce",
            base_note,
            |r| put(r, "notes/f.md", b"origin version\n"),
            |r| {
                put(r, "notes/f.md", b"web draft 1\n");
                commit_all(r, "web save 1", Some("2026-07-26T10:15:00+00:00"));
                put(r, "notes/f.md", b"web draft 2\n");
                commit_all(r, "web save 2", Some("2026-07-26T10:16:00+00:00"));
                put(r, "notes/f.md", b"web final\n");
                commit_all(r, "web save 3", Some("2026-07-26T10:17:00+00:00"));
            },
        );

        let mut forks = ForkMap::new();
        let (resolutions, _) = replay(&root, &mut forks);

        // Three conflicts, three resolutions — but ONE fork, named from the
        // FIRST commit's author date, carrying the LAST commit's content.
        let fork = format!("notes/f-{WEB_TS}.md");
        assert_eq!(resolutions.len(), 3);
        assert!(resolutions
            .iter()
            .all(|r| *r == Resolution::Forked {
                path: "notes/f.md".into(),
                fork: fork.clone(),
            }));
        assert_eq!(
            forks.entries().collect::<Vec<_>>(),
            vec![("notes/f.md", fork.as_str())]
        );
        assert_eq!(notes_dir(&root), vec![format!("f-{WEB_TS}.md"), "f.md".to_string()]);
        assert_eq!(read(&root, "notes/f.md"), b"origin version\n");
        assert_eq!(read(&root, &fork), b"web final\n");
        // Every author is still preserved — in the fork's own git history, which
        // is what the squash alternative could not offer.
        let log = stdout(&root, &["log", "--format=%s", "--", &fork]);
        assert_eq!(
            log.lines().collect::<Vec<_>>(),
            vec!["web save 3", "web save 2", "web save 1"]
        );
    }

    #[test]
    fn resolution_is_idempotent_so_a_retry_does_not_refork() {
        if !git_available() {
            return;
        }
        let root = diverged(
            "idempotent",
            base_note,
            |r| put(r, "notes/f.md", b"origin version\n"),
            |r| {
                put(r, "notes/f.md", b"web version\n");
                commit_all(r, "web save", Some(WEB_DATE));
            },
        );
        let fork = format!("notes/f-{WEB_TS}.md");

        // Stop once by hand: staging *ours* leaves the replayed commit with NO
        // diff on `P`, so the commit reduces to an add of the fork (§9.1).
        assert_eq!(git::rebase_onto(&root, "main").unwrap(), RebaseOutcome::Stopped);
        let ts = fork_timestamp(&git::rebase_head_timestamp(&root).unwrap());
        assert_eq!(ts, WEB_TS, "the stamp is the web commit's author date");
        let mut forks = ForkMap::new();
        resolve_all_unmerged(&root, &mut forks, &ts).unwrap();
        assert_eq!(
            stdout(&root, &["diff", "--cached", "--name-only"]),
            fork,
            "the replayed commit must touch only the fork"
        );

        // §8.3's self-healing exit unwinds everything, including the fork.
        git::rebase_abort(&root).unwrap();
        assert!(!root.join(&fork).exists());

        // The retry mints the SAME name (the author date is stable across an
        // abort, unlike a wall clock) and ends with exactly one fork.
        let mut forks = ForkMap::new();
        let (resolutions, _) = replay(&root, &mut forks);
        assert_eq!(
            resolutions,
            vec![Resolution::Forked {
                path: "notes/f.md".into(),
                fork: fork.clone(),
            }]
        );
        assert_eq!(notes_dir(&root), vec![format!("f-{WEB_TS}.md"), "f.md".to_string()]);

        // And the next tick (a rejected push re-rebases onto an unchanged
        // origin) neither conflicts nor forks again.
        let mut forks = ForkMap::new();
        let (resolutions, skips) = replay(&root, &mut forks);
        assert!(resolutions.is_empty(), "nothing left to resolve");
        assert_eq!(skips, 0);
        assert_eq!(notes_dir(&root), vec![format!("f-{WEB_TS}.md"), "f.md".to_string()]);
        assert_eq!(read(&root, &fork), b"web version\n");
    }

    #[test]
    fn exists_either_side_sees_the_worktree_and_the_index() {
        if !git_available() {
            return;
        }
        let root = repo_on_main("exists");
        put(&root, "notes/f.md", b"base\n");
        commit_all(&root, "base", None);

        assert!(exists_either_side(&root, "notes/f.md"), "tracked and on disk");
        assert!(!exists_either_side(&root, "notes/nope.md"));

        // Untracked but on disk: still taken, or the fork write would clobber it.
        put(&root, "notes/untracked.md", b"draft\n");
        assert!(exists_either_side(&root, "notes/untracked.md"));

        // In the index but not on disk (staged, then removed from the worktree).
        put(&root, "notes/staged.md", b"staged\n");
        run(&root, &["add", "notes/staged.md"]);
        std::fs::remove_file(root.join("notes/staged.md")).unwrap();
        assert!(exists_either_side(&root, "notes/staged.md"));
    }
}
