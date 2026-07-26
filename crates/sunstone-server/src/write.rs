//! Write orchestration for the web write path (tickets 05/07/08).
//!
//! The server is the sole committer. Each op composes the unchanged, commitless
//! `sunstone-native` writers (`bundle` / `rewrite`) and then commits via the core
//! `git` primitive — every op **write-then-commits immediately** (there is no
//! server-side pending Save; the editor's Save *is* the `PUT`).
//!
//! Concurrency: the caller runs each op on a blocking thread while holding the
//! server-global write lock, so the whole write → (rewrite) → commit critical
//! section is serialized against a consistent working tree (ticket 05/07 §4).
//!
//! Self-write / SSE (ticket 08): a web write must reach every *other* browser as
//! a genuine change, and the *writer's* browser must drop its own echo. Rather
//! than suppress-before-broadcast (which drops the event for everyone) we
//! `note_self_write` the affected paths — muting the watcher's *unstamped* echo —
//! and return the change groups so the caller can broadcast ONE `FileChange`
//! **stamped with the write's `origin`** (clientId + author). Each browser then
//! drops the change whose `clientId` is its own. Divergence from ticket 08 §1's
//! "do NOT note_self_write" is deliberate: pairing suppression with an explicit
//! stamped broadcast yields exactly one attributed event, avoiding the duplicate
//! (stamped + unstamped) delivery the naive reading would produce.
//!
//! Shape gating (Spec 2 §5): every op runs through a [`WriteShape`], read off
//! the parsed [`Config`] in `ServerState` — never off the environment, and never
//! by sniffing the filesystem for a `.git`.
//!
//! - **plain** ([`WriteShape::Plain`]) — write the file and skip git entirely:
//!   no commit, no `head_commit` probe, no amend-else-fresh check (the amend rule
//!   is a git concept). The write-side half of the locked "plain runs no git at
//!   all" rule, whose read-side half is `history.rs`'s short-circuit (§11.1).
//!   Without it a non-repo bundle **500s on Save**, so the plain shape is a real
//!   feature, not the absence of one.
//! - **git-local / git-synced** ([`WriteShape::Git`]) — unchanged behaviour.
//!
//! The one part of §5 that cannot live here is the **sync-loop kick**: it must
//! happen *after* the write lock is released, so that the loop's first act is to
//! acquire a free lock — and every op below runs *inside* that lock (`main.rs`'s
//! `run_write` holds it for the whole call). The kick therefore belongs to the
//! caller, once, after `run_write` returns: `state.sync.kick()`
//! ([`crate::sync::SyncState::kick`], a no-op in a shape with no loop).

use crate::config::Config;
use sunstone_native::app_state::AppState;
use sunstone_native::bundle;
use sunstone_native::git::{self, CommitIdentity};
use sunstone_native::rewrite::{self, AnchorRename, RewriteSummary};

use axum::http::StatusCode;

/// One SSE change group to broadcast (becomes one stamped `FileChange`). A
/// rename yields two (a `removed` of the old path, a `modified`/`created` of the
/// new) so a client with the old path open falls into the "deleted" state
/// (ticket 08 §2).
pub struct ChangeGroup {
    pub kind: &'static str,
    pub paths: Vec<String>,
}

/// Result of a write op: the change groups to broadcast + an optional rewrite
/// summary (rename/move/rewrite-anchors) for the HTTP response body.
pub struct WriteResult {
    pub changes: Vec<ChangeGroup>,
    pub summary: Option<RewriteSummary>,
}

impl WriteResult {
    fn change(kind: &'static str, path: String) -> Self {
        WriteResult {
            changes: vec![ChangeGroup {
                kind,
                paths: vec![path],
            }],
            summary: None,
        }
    }
}

/// Whether this deployment's write path commits — the whole of §5's gate.
///
/// Only two values, because the *write* path cannot tell git-local from
/// git-synced: the one behavioural difference between them (the sync-loop kick)
/// happens after the write lock is released, outside every op below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteShape {
    /// **plain** — write the file, run **no git at all**.
    Plain,
    /// **git-local / git-synced** — write, then commit (or amend) as the
    /// authenticated user.
    Git,
}

impl WriteShape {
    /// Derive the gate from the one parse of the environment (§2) held in
    /// `ServerState`.
    pub fn for_config(cfg: &Config) -> WriteShape {
        if cfg.is_git() {
            WriteShape::Git
        } else {
            WriteShape::Plain
        }
    }

    /// Whether an op commits after writing. In [`WriteShape::Plain`] this is not
    /// "commit false" but "git is never invoked": callers short-circuit on it
    /// *before* probing HEAD, so the plain shape spawns no git process at all.
    fn commits(self) -> bool {
        matches!(self, WriteShape::Git)
    }

    /// `PUT /api/concept` — overwrite an existing Concept's body.
    ///
    /// Normally lands a fresh `edit <path> via web` commit. But the tree-CRUD
    /// "create a new Concept" flow is TWO seam calls — `createConcept` (→
    /// `create <path> via web`) then an immediate `writeConcept` of the
    /// frontmatter scaffold — which would otherwise be two commits for one user
    /// action. So, reusing the ticket 07 §5 amend-else-fresh rule: when HEAD is
    /// our OWN `create <path> via web` for this same path AND the file on disk is
    /// still empty (the scaffold has not landed yet), fold the scaffold write
    /// into the create commit via `amend` (it keeps its `create …` subject, now
    /// carrying the scaffolded body) → one commit. The empty-file guard is what
    /// distinguishes the scaffold write from a genuine later Save of the same new
    /// Concept: once the file has content, every Save is its own `edit` commit.
    /// An interleaved write from another client (the global lock releases between
    /// the two requests) also moves HEAD off `create …` and falls back to a fresh
    /// commit.
    ///
    /// In the plain shape the file is written and nothing else happens — the
    /// amend rule is a git concept, so it is not merely false there, it is never
    /// asked (no `head_commit` probe).
    pub fn write_concept(
        self,
        app: &AppState,
        ident: &CommitIdentity,
        path: &str,
        content: &str,
    ) -> Result<WriteResult, String> {
        // Decide BEFORE writing — the write is about to overwrite the empty file.
        // `self.commits()` first, so the plain shape never probes HEAD.
        let fold_into_create = self.commits()
            && head_is_ours(app, ident, &format!("create {path} via web"))
            && file_is_empty(&app.bundle_root.join(path));
        let resolved = bundle::write_concept(&app.bundle_root, path, content)?;
        app.note_self_write(resolved);
        if self.commits() {
            if fold_into_create {
                git::amend(&app.bundle_root, &[path], ident)?;
            } else {
                git::commit(
                    &app.bundle_root,
                    &[path],
                    &format!("edit {path} via web"),
                    ident,
                )?;
            }
        }
        Ok(WriteResult::change("modified", path.to_string()))
    }

    /// `POST /api/concept` — create a new empty Concept, commit `create`.
    pub fn create_concept(
        self,
        app: &AppState,
        ident: &CommitIdentity,
        path: &str,
    ) -> Result<WriteResult, String> {
        let resolved = bundle::create_concept(&app.bundle_root, path)?;
        app.note_self_write(resolved);
        if self.commits() {
            git::commit(
                &app.bundle_root,
                &[path],
                &format!("create {path} via web"),
                ident,
            )?;
        }
        Ok(WriteResult::change("created", path.to_string()))
    }

    /// `POST /api/folder` — create a folder. An empty directory cannot be
    /// committed (git tracks no empty dirs), so there is nothing to commit here
    /// in **any** shape; the folder enters history when its first Concept lands.
    /// We still broadcast a `created` so every client refreshes its tree.
    pub fn create_folder(
        self,
        app: &AppState,
        _ident: &CommitIdentity,
        path: &str,
    ) -> Result<WriteResult, String> {
        let resolved = bundle::create_folder(&app.bundle_root, path)?;
        app.note_self_write(resolved);
        Ok(WriteResult::change("created", path.to_string()))
    }

    /// `POST /api/rename` — rename/move + auto link rewrite, commit `rename`.
    pub fn rename_path(
        self,
        app: &AppState,
        ident: &CommitIdentity,
        from: &str,
        to: &str,
    ) -> Result<WriteResult, String> {
        // Mute the watcher echo for the old (removed) and new paths; core
        // `rename_and_rewrite` already `note_self_write`s the rewrite targets.
        app.note_self_write(app.bundle_root.join(from));
        let summary = rewrite::rename_and_rewrite(app, from, to)?;
        app.note_self_write(app.bundle_root.join(to));
        // Structural op → stage the whole tree (the op's move + every fixup); the
        // global lock guarantees no other write is in flight.
        if self.commits() {
            git::commit(
                &app.bundle_root,
                &[],
                &format!("rename {from} → {to} via web"),
                ident,
            )?;
        }
        Ok(structural_result(summary, from, to))
    }

    /// `POST /api/move` — move into a folder + auto link rewrite, commit `move`.
    pub fn move_path(
        self,
        app: &AppState,
        ident: &CommitIdentity,
        from: &str,
        to_dir: &str,
    ) -> Result<WriteResult, String> {
        // Compute the resulting path for the broadcast + commit message.
        let name = from
            .rsplit('/')
            .find(|s| !s.is_empty())
            .ok_or_else(|| format!("invalid source path: {from}"))?;
        let to = if to_dir.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", to_dir.trim_end_matches('/'), name)
        };
        app.note_self_write(app.bundle_root.join(from));
        let summary = rewrite::move_into(app, from, to_dir)?;
        app.note_self_write(app.bundle_root.join(&to));
        if self.commits() {
            git::commit(
                &app.bundle_root,
                &[],
                &format!("move {from} → {to} via web"),
                ident,
            )?;
        }
        Ok(structural_result(summary, from, &to))
    }

    /// `DELETE /api/concept?path=` — delete a Concept/folder, commit `delete`.
    pub fn delete_path(
        self,
        app: &AppState,
        ident: &CommitIdentity,
        path: &str,
    ) -> Result<WriteResult, String> {
        app.note_self_write(app.bundle_root.join(path));
        bundle::delete_path(&app.bundle_root, path)?;
        if self.commits() {
            git::commit(
                &app.bundle_root,
                &[path],
                &format!("delete {path} via web"),
                ident,
            )?;
        }
        Ok(WriteResult::change("removed", path.to_string()))
    }

    /// `POST /api/rewrite-anchors` — rewrite inbound anchors after a heading
    /// rename, folding into the preceding `edit … via web` commit when it is ours
    /// (ticket 07 §5: amend-else-fresh). The plain shape writes the fixups and
    /// stops there — again with no `head_commit` probe.
    pub fn rewrite_anchors(
        self,
        app: &AppState,
        ident: &CommitIdentity,
        target: &str,
        renames: &[AnchorRename],
    ) -> Result<WriteResult, String> {
        let summary = rewrite::rewrite_anchors(app, target, renames)?;
        // Nothing to write (no inbound anchors matched) → no commit, no broadcast.
        if summary.files_changed == 0 {
            return Ok(WriteResult {
                changes: Vec::new(),
                summary: Some(summary),
            });
        }

        // Amend iff HEAD is the matching `edit <target> via web` commit authored
        // by this same user; otherwise a fresh `relink` commit. Either way stage
        // the whole tree (the rewrite touched inbound sources we don't enumerate
        // here).
        if self.commits() {
            if head_is_ours(app, ident, &format!("edit {target} via web")) {
                git::amend(&app.bundle_root, &[], ident)?;
            } else {
                git::commit(
                    &app.bundle_root,
                    &[],
                    &format!("relink {target} via web"),
                    ident,
                )?;
            }
        }

        // The target's committed body is authoritative — broadcast a `modified` so
        // other clients reload it / refresh their sidebars.
        Ok(WriteResult {
            changes: vec![ChangeGroup {
                kind: "modified",
                paths: vec![target.to_string()],
            }],
            summary: Some(summary),
        })
    }
}

/// Whether HEAD is a commit with exactly `subject`, authored by `ident`. The
/// amend-else-fresh guard (ticket 07 §5): only ever fold a write into the tip
/// when it is our own, matching commit; never touch someone else's history.
/// Only ever reached in [`WriteShape::Git`].
fn head_is_ours(app: &AppState, ident: &CommitIdentity, subject: &str) -> bool {
    git::head_commit(&app.bundle_root).is_some_and(|h| {
        h.subject == subject && h.author_name == ident.name && h.author_email == ident.email
    })
}

/// Whether the file at `p` has no content (empty or whitespace-only) — the state
/// a just-`createConcept`'d Concept is in before its scaffold is written. A read
/// failure (missing file) counts as non-empty, so we never amend on a guess.
fn file_is_empty(p: &std::path::Path) -> bool {
    std::fs::read_to_string(p).is_ok_and(|s| s.trim().is_empty())
}

/// Build the two-group broadcast + summary for a rename/move.
fn structural_result(summary: RewriteSummary, from: &str, to: &str) -> WriteResult {
    WriteResult {
        changes: vec![
            ChangeGroup {
                kind: "removed",
                paths: vec![from.to_string()],
            },
            ChangeGroup {
                kind: "modified",
                paths: vec![to.to_string()],
            },
        ],
        summary: Some(summary),
    }
}

/// Classify a write failure into an HTTP status. Distinct from the READ
/// classifier (whose default is 404): a write's default failure is a *server*
/// fault (500). Auth failures never reach here (the extractor 401s first).
pub fn classify_write(msg: &str) -> StatusCode {
    if msg.contains("escapes the bundle")
        || msg.contains("must be bundle-relative")
        || msg.contains("must end in .md")
        || msg.contains("must not be empty")
    {
        StatusCode::BAD_REQUEST // 400 — invalid path (client)
    } else if msg.contains("already exists") || msg.contains("already in that folder") {
        StatusCode::CONFLICT // 409 — create/rename onto an existing target
    } else if msg.contains("does not exist") || msg.contains("No such file") {
        StatusCode::NOT_FOUND // 404 — referenced path/parent missing
    } else {
        StatusCode::INTERNAL_SERVER_ERROR // 500 — IO / git / poisoned lock
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};
    use sunstone_native::git::{self, FileHistory};

    use crate::config::Shape;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    // The pre-§5 call shape, kept **only** here: every test below that predates
    // the shape gate exercises the git shape, so these read as `write_concept(…)`
    // rather than repeating `WriteShape::Git.` on every line. Production callers
    // name the shape (`main.rs`'s `write_shape(&state)`); there is no ungated
    // free function left for one to reach for by mistake.
    fn write_concept(
        app: &AppState,
        ident: &CommitIdentity,
        path: &str,
        content: &str,
    ) -> Result<WriteResult, String> {
        WriteShape::Git.write_concept(app, ident, path, content)
    }

    fn create_concept(
        app: &AppState,
        ident: &CommitIdentity,
        path: &str,
    ) -> Result<WriteResult, String> {
        WriteShape::Git.create_concept(app, ident, path)
    }

    fn create_folder(
        app: &AppState,
        ident: &CommitIdentity,
        path: &str,
    ) -> Result<WriteResult, String> {
        WriteShape::Git.create_folder(app, ident, path)
    }

    fn rename_path(
        app: &AppState,
        ident: &CommitIdentity,
        from: &str,
        to: &str,
    ) -> Result<WriteResult, String> {
        WriteShape::Git.rename_path(app, ident, from, to)
    }

    fn delete_path(
        app: &AppState,
        ident: &CommitIdentity,
        path: &str,
    ) -> Result<WriteResult, String> {
        WriteShape::Git.delete_path(app, ident, path)
    }

    fn rewrite_anchors(
        app: &AppState,
        ident: &CommitIdentity,
        target: &str,
        renames: &[AnchorRename],
    ) -> Result<WriteResult, String> {
        WriteShape::Git.rewrite_anchors(app, ident, target, renames)
    }

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn run(root: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed: {out:?}");
    }

    /// A temp bundle that IS a git repo, with an initial commit so HEAD exists.
    fn temp_repo() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sunstone-write-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        run(&dir, &["init", "-q"]);
        run(&dir, &["config", "user.email", "seed@example.com"]);
        run(&dir, &["config", "user.name", "Seed"]);
        run(&dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join(".gitkeep"), "").unwrap();
        run(&dir, &["add", "-A"]);
        run(&dir, &["commit", "-q", "-m", "seed"]);
        dir
    }

    fn ident() -> CommitIdentity {
        CommitIdentity {
            name: "Ada Lovelace".into(),
            email: "ada@example.com".into(),
        }
    }

    fn head_subject(root: &Path) -> String {
        git::head_commit(root).unwrap().subject
    }

    #[test]
    fn write_concept_commits_edit_as_the_authed_user() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        std::fs::write(root.join("a.md"), "old\n").unwrap();
        let app = AppState::new(root.clone());

        let result = write_concept(&app, &ident(), "a.md", "new body\n").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "new body\n");
        assert_eq!(head_subject(&root), "edit a.md via web");
        let head = git::head_commit(&root).unwrap();
        assert_eq!(head.author_name, "Ada Lovelace");
        assert_eq!(head.author_email, "ada@example.com");
        // Broadcast group: a single `modified` for the edited path.
        assert_eq!(result.changes.len(), 1);
        assert_eq!(result.changes[0].kind, "modified");
        assert_eq!(result.changes[0].paths, vec!["a.md".to_string()]);
    }

    #[test]
    fn create_and_delete_commit_their_verbs() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        let app = AppState::new(root.clone());

        let created = create_concept(&app, &ident(), "n.md").unwrap();
        assert!(root.join("n.md").is_file());
        assert_eq!(head_subject(&root), "create n.md via web");
        assert_eq!(created.changes[0].kind, "created");

        let removed = delete_path(&app, &ident(), "n.md").unwrap();
        assert!(!root.join("n.md").exists());
        assert_eq!(head_subject(&root), "delete n.md via web");
        assert_eq!(removed.changes[0].kind, "removed");
    }

    #[test]
    fn create_then_scaffold_write_folds_into_one_commit() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        let app = AppState::new(root.clone());

        // The tree-CRUD new-Concept flow: create the empty file, then write the
        // frontmatter scaffold. The scaffold write amends the create commit.
        create_concept(&app, &ident(), "n.md").unwrap();
        assert_eq!(head_subject(&root), "create n.md via web");
        let after_create = commit_count(&root);

        write_concept(&app, &ident(), "n.md", "---\ntype:\ntitle: N\n---\n\n").unwrap();
        // Folded in: HEAD keeps the `create` subject, carrying the scaffold body,
        // and NO new commit was added.
        assert_eq!(head_subject(&root), "create n.md via web", "amended, not fresh");
        assert_eq!(commit_count(&root), after_create, "amend adds no commit");
        assert!(std::fs::read_to_string(root.join("n.md")).unwrap().contains("title: N"));

        // A subsequent edit (HEAD no longer a bare `create`) → fresh `edit` commit.
        let before_edit = commit_count(&root);
        write_concept(&app, &ident(), "n.md", "---\ntype:\ntitle: N\n---\n\nbody\n").unwrap();
        assert_eq!(head_subject(&root), "edit n.md via web");
        assert_eq!(commit_count(&root), before_edit + 1, "fresh edit commit");
    }

    #[test]
    fn write_does_not_amend_another_users_create() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        let app = AppState::new(root.clone());

        // Someone else created the file.
        let other = CommitIdentity {
            name: "Grace Hopper".into(),
            email: "grace@example.com".into(),
        };
        create_concept(&app, &other, "n.md").unwrap();
        assert_eq!(head_subject(&root), "create n.md via web");
        let before = commit_count(&root);

        // Our write must NOT amend their commit — a fresh `edit` commit lands.
        write_concept(&app, &ident(), "n.md", "mine\n").unwrap();
        assert_eq!(head_subject(&root), "edit n.md via web");
        assert_eq!(commit_count(&root), before + 1, "did not amend another's commit");
    }

    #[test]
    fn create_folder_does_not_commit_but_broadcasts() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        let app = AppState::new(root.clone());
        let before = head_subject(&root);

        let result = create_folder(&app, &ident(), "sub").unwrap();
        assert!(root.join("sub").is_dir());
        // Empty dir → nothing to commit; HEAD is unchanged.
        assert_eq!(head_subject(&root), before);
        assert_eq!(result.changes[0].kind, "created");
    }

    #[test]
    fn rename_commits_and_reports_removed_then_modified() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        // b links to a; renaming a must rewrite b and land ONE commit.
        std::fs::write(root.join("a.md"), "# A\n").unwrap();
        std::fs::write(root.join("b.md"), "see [a](/a.md)\n").unwrap();
        let app = AppState::new(root.clone());
        // Commit the starting files so the rename's diff is only the op.
        git::commit(&root, &[], "seed files", &ident()).unwrap();

        let result = rename_path(&app, &ident(), "a.md", "c.md").unwrap();
        assert!(!root.join("a.md").exists() && root.join("c.md").exists());
        assert_eq!(head_subject(&root), "rename a.md → c.md via web");
        // The inbound link was rewritten to the new path.
        assert!(std::fs::read_to_string(root.join("b.md")).unwrap().contains("/c.md"));
        // Two broadcast groups: removed(old) then modified(new).
        assert_eq!(result.changes[0].kind, "removed");
        assert_eq!(result.changes[0].paths, vec!["a.md".to_string()]);
        assert_eq!(result.changes[1].kind, "modified");
        assert_eq!(result.changes[1].paths, vec!["c.md".to_string()]);
        assert!(result.summary.is_some());
    }

    #[test]
    fn rewrite_anchors_amends_matching_edit_else_fresh() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        // src links to target's #intro anchor; target has that heading.
        std::fs::write(root.join("target.md"), "# Intro\n\nbody\n").unwrap();
        std::fs::write(root.join("src.md"), "see [x](/target.md#intro)\n").unwrap();
        let app = AppState::new(root.clone());
        git::commit(&root, &[], "seed files", &ident()).unwrap();

        // Simulate the editor's Save: writeConcept(target) → `edit target.md via web`.
        write_concept(&app, &ident(), "target.md", "# Introduction\n\nbody\n").unwrap();
        assert_eq!(head_subject(&root), "edit target.md via web");
        let commits_before = commit_count(&root);

        // rewriteAnchors renames #intro → #introduction: amends the edit commit.
        let renames = vec![anchor("intro", "introduction")];
        let result = rewrite_anchors(&app, &ident(), "target.md", &renames).unwrap();
        assert_eq!(head_subject(&root), "edit target.md via web", "amended, not fresh");
        assert_eq!(commit_count(&root), commits_before, "amend adds no commit");
        assert!(std::fs::read_to_string(root.join("src.md")).unwrap().contains("#introduction"));
        assert_eq!(result.summary.unwrap().files_changed, 1);

        // A rewriteAnchors with NO preceding matching edit → fresh `relink` commit.
        // Land an unrelated commit so HEAD no longer matches `edit target.md via web`.
        std::fs::write(root.join("other.md"), "unrelated\n").unwrap();
        git::commit(&root, &[], "unrelated head", &ident()).unwrap();
        let renames2 = vec![anchor("introduction", "overview")];
        // Need target to actually have the heading for the rename identity; the
        // rewrite operates on inbound sources regardless, so this still writes.
        let before2 = commit_count(&root);
        rewrite_anchors(&app, &ident(), "target.md", &renames2).unwrap();
        assert_eq!(head_subject(&root), "relink target.md via web");
        assert_eq!(commit_count(&root), before2 + 1, "fresh commit added");
    }

    fn commit_count(root: &Path) -> usize {
        match git::file_history(root, ".") {
            FileHistory::Ok { commits } => commits.len(),
            _ => {
                // `.` may not be a tracked pathspec on all gits; fall back to a
                // rev-list count.
                let out = Command::new("git")
                    .current_dir(root)
                    .args(["rev-list", "--count", "HEAD"])
                    .output()
                    .unwrap();
                String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
            }
        }
    }

    fn anchor(from: &str, to: &str) -> AnchorRename {
        // AnchorRename is Deserialize-only; build it via JSON to avoid depending
        // on private field visibility.
        serde_json::from_value(serde_json::json!({ "from": from, "to": to })).unwrap()
    }

    #[test]
    fn classify_write_maps_the_taxonomy() {
        assert_eq!(
            classify_write("path escapes the bundle: ../x"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            classify_write("a Concept path must end in .md: x.txt"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            classify_write("already exists: a.md"),
            StatusCode::CONFLICT
        );
        assert_eq!(
            classify_write("already in that folder: a.md"),
            StatusCode::CONFLICT
        );
        assert_eq!(
            classify_write("target folder does not exist: sub/x.md"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            classify_write("git commit failed: boom"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    // --- §5 shape gating ----------------------------------------------------

    /// A bundle that is NOT a git repo (and, under the OS temp dir, not inside
    /// one) — the plain shape's deployment: "mount markdown, don't track it".
    fn temp_plain_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sunstone-plain-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// The gate is read from the declared [`Shape`], never sniffed from the
    /// filesystem — a plain shape over a directory that happens to be a repo
    /// still does not commit.
    #[test]
    fn write_shape_comes_from_the_declared_config_shape() {
        let mut cfg = Config::plain(std::env::temp_dir());
        assert_eq!(WriteShape::for_config(&cfg), WriteShape::Plain);
        cfg.shape = Shape::GitLocal;
        assert_eq!(WriteShape::for_config(&cfg), WriteShape::Git);
        cfg.shape = Shape::GitSynced;
        assert_eq!(WriteShape::for_config(&cfg), WriteShape::Git);
    }

    /// The bundle IS a real repo, so git would happily commit — the plain shape
    /// still writes the file and nothing else. Same call in a git shape commits,
    /// which is the proof that the gate is the only difference.
    #[test]
    fn plain_shape_write_lands_the_file_and_no_commit() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        std::fs::write(root.join("a.md"), "old\n").unwrap();
        let app = AppState::new(root.clone());
        let head_before = head_subject(&root);
        let commits_before = commit_count(&root);

        let result = WriteShape::Plain
            .write_concept(&app, &ident(), "a.md", "new body\n")
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "new body\n"
        );
        assert_eq!(head_subject(&root), head_before, "HEAD untouched");
        assert_eq!(commit_count(&root), commits_before, "no commit added");
        assert_eq!(result.changes[0].kind, "modified");

        // Only the shape differs: the git shapes still commit.
        WriteShape::Git
            .write_concept(&app, &ident(), "a.md", "newer\n")
            .unwrap();
        assert_eq!(head_subject(&root), "edit a.md via web");
        assert_eq!(commit_count(&root), commits_before + 1);
    }

    /// The defect §5 fixes: `git::commit` on a non-repo bundle fails, which the
    /// classifier turns into a **500 on Save**. The plain shape must succeed.
    #[test]
    fn plain_shape_write_does_not_500_on_a_non_repo_bundle() {
        let root = temp_plain_dir();
        std::fs::write(root.join("a.md"), "old\n").unwrap();
        let app = AppState::new(root.clone());

        WriteShape::Plain
            .write_concept(&app, &ident(), "a.md", "new\n")
            .unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "new\n");
        assert!(!root.join(".git").exists(), "no repo was created");

        // Contrast (the pre-gate behaviour, still correct for a git shape): the
        // commit fails and classifies as a 500.
        if git_available() {
            let Err(err) = WriteShape::Git.write_concept(&app, &ident(), "a.md", "newer\n") else {
                panic!("a git shape cannot commit in a non-repo bundle");
            };
            assert_eq!(classify_write(&err), StatusCode::INTERNAL_SERVER_ERROR);
        }
    }

    /// Every op, not just Save: create (incl. the scaffold write that would
    /// *amend* in a git shape), folder, rename, move and delete all leave history
    /// untouched in the plain shape while really changing the files.
    #[test]
    fn plain_shape_runs_no_git_for_any_op() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        std::fs::write(root.join("a.md"), "# A\n").unwrap();
        std::fs::write(root.join("b.md"), "see [a](/a.md)\n").unwrap();
        let app = AppState::new(root.clone());
        git::commit(&root, &[], "seed files", &ident()).unwrap();
        let head_before = head_subject(&root);
        let commits_before = commit_count(&root);

        let plain = WriteShape::Plain;
        plain.create_concept(&app, &ident(), "n.md").unwrap();
        plain
            .write_concept(&app, &ident(), "n.md", "---\ntitle: N\n---\n")
            .unwrap();
        plain.create_folder(&app, &ident(), "sub").unwrap();
        plain.rename_path(&app, &ident(), "a.md", "c.md").unwrap();
        plain.move_path(&app, &ident(), "c.md", "sub").unwrap();
        plain.delete_path(&app, &ident(), "sub/c.md").unwrap();

        // The filesystem moved…
        assert!(root.join("n.md").is_file());
        assert!(root.join("sub").is_dir());
        assert!(!root.join("a.md").exists());
        assert!(!root.join("sub/c.md").exists());
        // …and git did not.
        assert_eq!(head_subject(&root), head_before);
        assert_eq!(commit_count(&root), commits_before);
    }

    /// `rewrite_anchors` writes its fixups in the plain shape but neither amends
    /// nor commits (the amend-else-fresh rule is a git concept).
    #[test]
    fn plain_shape_rewrite_anchors_writes_without_committing() {
        if !git_available() {
            return;
        }
        let root = temp_repo();
        std::fs::write(root.join("target.md"), "# Intro\n\nbody\n").unwrap();
        std::fs::write(root.join("src.md"), "see [x](/target.md#intro)\n").unwrap();
        let app = AppState::new(root.clone());
        git::commit(&root, &[], "seed files", &ident()).unwrap();
        let head_before = head_subject(&root);
        let commits_before = commit_count(&root);

        let renames = vec![anchor("intro", "introduction")];
        let result = WriteShape::Plain
            .rewrite_anchors(&app, &ident(), "target.md", &renames)
            .unwrap();

        assert!(std::fs::read_to_string(root.join("src.md"))
            .unwrap()
            .contains("#introduction"));
        assert_eq!(result.summary.unwrap().files_changed, 1);
        assert_eq!(head_subject(&root), head_before);
        assert_eq!(commit_count(&root), commits_before);
    }
}
