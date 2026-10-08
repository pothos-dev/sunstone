//! Bundle filesystem operations: tree walking, Concept reading, path resolution.
//!
//! Pure module logic — the host command/route wrappers (Tauri commands, server routes) stay thin.
//! Paths crossing the seam are bundle-relative, '/'-separated, '' for root.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::paths::bundle_walker;
use sunstone_shared::frontmatter::parse_frontmatter;
use sunstone_shared::paths::to_rel_string;

/// A node in the Bundle's directory tree. Matches the TS `TreeNode`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    /// bundle-relative, '/'-separated, '' for root
    pub path: String,
    pub is_dir: bool,
    /// A Concept's frontmatter `title` (trimmed, non-empty), shown in the
    /// Explorer instead of the filename. Omitted for dirs, non-`.md` files and
    /// Concepts without one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// dirs only; `None` for files so the JSON omits an empty array
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

/// Walk the Bundle and build a recursive tree, respecting ignore files
/// (`.gitignore`, etc.) via the `ignore` crate. Hidden files are excluded.
pub fn list_tree(root: &Path) -> Result<TreeNode, String> {
    // Collect every entry's bundle-relative segments, then assemble a tree.
    // We use an intermediate node map keyed by relative path for O(n) assembly.
    struct Node {
        name: String,
        path: String,
        is_dir: bool,
        title: Option<String>,
        children: Vec<String>, // child relative paths, dirs+files
    }

    let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
    nodes.insert(
        String::new(),
        Node {
            name: root
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "bundle".to_string()),
            path: String::new(),
            is_dir: true,
            title: None,
            children: Vec::new(),
        },
    );

    let walker = bundle_walker(root).build();

    for result in walker {
        let entry = result.map_err(|e| e.to_string())?;
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rel.as_os_str().is_empty() {
            continue; // the root itself
        }

        let rel_path = to_rel_string(rel);
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false);
        let name = entry.file_name().to_string_lossy().into_owned();
        // An unreadable Concept just keeps its filename label.
        let title = if !is_dir && name.ends_with(".md") {
            std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|content| parse_frontmatter(&content).title)
        } else {
            None
        };

        let parent = rel
            .parent()
            .map(to_rel_string)
            .unwrap_or_default();

        nodes.entry(parent.clone()).and_modify(|n| {
            n.children.push(rel_path.clone());
        });

        nodes.insert(
            rel_path.clone(),
            Node {
                name,
                path: rel_path,
                is_dir,
                title,
                children: Vec::new(),
            },
        );
    }

    fn build(key: &str, nodes: &BTreeMap<String, Node>) -> TreeNode {
        let node = &nodes[key];
        if node.is_dir {
            let mut children: Vec<TreeNode> = node
                .children
                .iter()
                .map(|child_key| build(child_key, nodes))
                .collect();
            // dirs first, then files, alphabetical
            children.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });
            TreeNode {
                name: node.name.clone(),
                path: node.path.clone(),
                is_dir: true,
                title: None,
                children: Some(children),
            }
        } else {
            TreeNode {
                name: node.name.clone(),
                path: node.path.clone(),
                is_dir: false,
                title: node.title.clone(),
                children: None,
            }
        }
    }

    Ok(build("", &nodes))
}

/// Read a single Concept's raw markdown by bundle-relative path, after
/// validating the path stays within the Bundle root.
pub fn read_concept(root: &Path, rel_path: &str) -> Result<String, String> {
    let resolved = resolve(root, rel_path)?;
    std::fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

/// Write a Concept's raw markdown back to disk by bundle-relative path, after
/// validating the path stays within the Bundle root. Returns the resolved
/// absolute path so the caller can record it as a self-write (watcher echo
/// suppression). The file is expected to already exist (we only edit open
/// Concepts); resolution rejects escapes the same way `read_concept` does.
pub fn write_concept(root: &Path, rel_path: &str, content: &str) -> Result<PathBuf, String> {
    let resolved = resolve(root, rel_path)?;
    std::fs::write(&resolved, content).map_err(|e| e.to_string())?;
    Ok(resolved)
}

/// Create a new, empty Concept (`.md`) at `rel_path`. The minimal stub here is
/// an empty file — the rich frontmatter scaffold is a later slice. Rejects a
/// non-`.md` path, an escaping path, or an existing target. Parent folders must
/// already exist (use `create_folder` first). Returns the resolved absolute path
/// (not recorded as a self-write: a structural create SHOULD refresh the tree).
pub fn create_concept(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if !rel_path.ends_with(".md") {
        return Err(format!("a Concept path must end in .md: {rel_path}"));
    }
    let resolved = resolve_new(root, rel_path)?;
    if resolved.exists() {
        return Err(format!("already exists: {rel_path}"));
    }
    std::fs::write(&resolved, "").map_err(|e| e.to_string())?;
    Ok(resolved)
}

/// Declare `root` an OKF Bundle (ov-8): make its root `index.md` carry
/// `okf_version` ([`sunstone_shared::okf_marker::declare_okf_version`]) —
/// creating it when absent, adding the key when missing, and leaving a file that
/// already declares a version (any version) untouched. Only the root
/// `index.md` is ever written. Returns whether the file was written.
pub fn declare_okf_bundle(root: &Path) -> Result<bool, String> {
    let index = root.join("index.md");
    let existing = match std::fs::read_to_string(&index) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let title = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Bundle".to_string());
    match sunstone_shared::okf_marker::declare_okf_version(existing.as_deref(), &title) {
        Some(content) => {
            std::fs::write(&index, content).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Create a new folder at `rel_path` (and any missing parents). Rejects an
/// escaping path or an existing target. Returns the resolved absolute path.
pub fn create_folder(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let resolved = resolve_new(root, rel_path)?;
    if resolved.exists() {
        return Err(format!("already exists: {rel_path}"));
    }
    std::fs::create_dir_all(&resolved).map_err(|e| e.to_string())?;
    Ok(resolved)
}

/// Rename (or move, when the target is in a different folder) `from` to `to`.
/// Both are bundle-relative; `from` must exist, `to` must not. This is a PLAIN
/// filesystem rename — inbound link rewriting is layered on top by the
/// `rewrite::rename_and_rewrite`, not by this function. Works for both
/// Concepts and folders. A symlink `from` is renamed as the link itself; its
/// target stays put. Returns the resolved `to` absolute path.
pub fn rename_path(root: &Path, from: &str, to: &str) -> Result<PathBuf, String> {
    let src = resolve_entry(root, from)?;
    let dst = resolve_new(root, to)?;
    if dst.exists() {
        return Err(format!("already exists: {to}"));
    }
    if let Some(parent) = dst.parent() {
        if !parent.exists() {
            return Err(format!("target folder does not exist: {to}"));
        }
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst)
}

/// Delete `rel_path` (a Concept or a folder, recursively). The path must exist
/// and stay within the Bundle. A symlink is removed as a link (its target is
/// never followed or deleted), even when it points at a folder. The frontend
/// confirms before calling this.
pub fn delete_path(root: &Path, rel_path: &str) -> Result<(), String> {
    let resolved = resolve_entry(root, rel_path)?;
    let meta = resolved.symlink_metadata().map_err(|e| e.to_string())?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&resolved).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&resolved).map_err(|e| e.to_string())
    }
}

/// Reject any path component other than a normal segment or `.` (i.e. `..`
/// and root/prefix components), which would let a rel path escape the Bundle.
fn reject_escaping_components(rel: &Path, rel_path: &str) -> Result<(), String> {
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("path escapes the bundle: {rel_path}")),
        }
    }
    Ok(())
}

/// Resolve a bundle-relative path against the root, rejecting escapes
/// (`..`, absolute paths, or anything outside the Bundle). Follows symlinks
/// (the result is the canonical target), so it suits reading/writing content;
/// an entry being deleted or renamed goes through `resolve_entry` instead.
pub fn resolve(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return Err(format!("path must be bundle-relative: {rel_path}"));
    }
    reject_escaping_components(rel, rel_path)?;
    let joined = root.join(rel);
    // Defence in depth: canonicalize and confirm containment.
    let canonical = joined
        .canonicalize()
        .map_err(|e| format!("{rel_path}: {e}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("path escapes the bundle: {rel_path}"));
    }
    Ok(canonical)
}

/// Resolve an existing entry *inside* the Bundle that is about to be acted ON
/// (the source of a delete or rename/move). Unlike [`resolve`] it does NOT
/// follow the final component: the parent folder is canonicalized and checked
/// for containment, and the entry is returned as `canonical_parent/<name>`. So
/// an in-Bundle symlink resolves to the link itself — deleting or renaming it
/// touches only the link, never its target (which may be elsewhere in the
/// Bundle or outside it). Refuses a path that names the root itself (`""`,
/// `.`), so a delete or rename can never act on the whole Bundle, and a path
/// that does not exist (checked with `symlink_metadata`, so a dangling link
/// still counts as existing).
fn resolve_entry(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return Err(format!("path must be bundle-relative: {rel_path}"));
    }
    reject_escaping_components(rel, rel_path)?;
    // Only `Normal` segments remain meaningful (`.` is dropped); none left
    // means the path names the root.
    let normal: PathBuf = rel
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .collect();
    let (Some(name), Some(parent_rel)) = (normal.file_name(), normal.parent()) else {
        return Err(format!("path names the bundle root: {rel_path:?}"));
    };
    let canonical_parent = root
        .join(parent_rel)
        .canonicalize()
        .map_err(|e| format!("{rel_path}: {e}"))?;
    if !canonical_parent.starts_with(root) {
        return Err(format!("path escapes the bundle: {rel_path}"));
    }
    let entry = canonical_parent.join(name);
    entry
        .symlink_metadata()
        .map_err(|e| format!("{rel_path}: {e}"))?;
    Ok(entry)
}

/// Resolve a bundle-relative path for a target that may NOT yet exist (create,
/// rename/move destination). `resolve` canonicalizes the full path and so fails
/// for a non-existent target; here we validate the components for escapes and
/// canonicalize the nearest existing ancestor to confirm containment, then
/// re-append the remaining segments. Rejects absolute paths and `..` escapes.
pub fn resolve_new(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return Err(format!("path must be bundle-relative: {rel_path}"));
    }
    if rel.as_os_str().is_empty() {
        return Err("path must not be empty".to_string());
    }
    reject_escaping_components(rel, rel_path)?;
    let joined = root.join(rel);

    // Walk up to the nearest existing ancestor, canonicalize it, and confirm it
    // is within the (canonical) root. This catches symlink escapes for the
    // existing portion while tolerating the not-yet-created tail.
    let mut existing = joined.as_path();
    while let Some(parent) = existing.parent() {
        if existing.exists() {
            break;
        }
        existing = parent;
    }
    // The nearest existing ancestor MUST canonicalize and stay within the root.
    // A canonicalize failure is treated as an escape (rejected) rather than
    // silently passed through — the root itself always exists and canonicalizes,
    // so a failure here means something is wrong with the path; defence in depth.
    let canonical_ancestor = existing
        .canonicalize()
        .map_err(|e| format!("{rel_path}: {e}"))?;
    if !canonical_ancestor.starts_with(root) {
        return Err(format!("path escapes the bundle: {rel_path}"));
    }
    Ok(joined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A throwaway canonicalized bundle root under the OS temp dir.
    fn temp_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "sunstone-tree-crud-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn declare_okf_bundle_creates_a_root_index_that_roots_the_bundle() {
        let root = temp_root();
        // Structurally, `docs/` would be the root: no top-level `.md`.
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/index.md"), "# Docs\n").unwrap();
        assert!(declare_okf_bundle(&root).unwrap());
        let written = std::fs::read_to_string(root.join("index.md")).unwrap();
        assert!(written.starts_with("---\nokf_version: \"0.2\"\n---\n"));
        assert_eq!(std::fs::read_to_string(root.join("docs/index.md")).unwrap(), "# Docs\n");

        let idx = crate::index::Index::build(&root);
        let found = sunstone_shared::find_bundle_root(&idx.concept_paths(), &idx.okf_markers());
        assert_eq!(found.dir, "");
        assert_eq!(found.okf_version.as_deref(), Some("0.2"));
    }

    #[test]
    fn declare_okf_bundle_adds_to_an_existing_index_and_then_leaves_it() {
        let root = temp_root();
        std::fs::write(root.join("index.md"), "---\ntitle: Kunden\n---\n# Kunden\n").unwrap();
        assert!(declare_okf_bundle(&root).unwrap());
        let once = std::fs::read_to_string(root.join("index.md")).unwrap();
        assert_eq!(once, "---\nokf_version: \"0.2\"\ntitle: Kunden\n---\n# Kunden\n");
        assert!(!declare_okf_bundle(&root).unwrap());

        std::fs::write(root.join("index.md"), "---\nokf_version: \"0.1\"\n---\n").unwrap();
        assert!(!declare_okf_bundle(&root).unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join("index.md")).unwrap(),
            "---\nokf_version: \"0.1\"\n---\n"
        );
    }

    #[test]
    fn create_concept_writes_empty_md() {
        let root = temp_root();
        create_concept(&root, "note.md").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("note.md")).unwrap(), "");
    }

    #[test]
    fn create_concept_rejects_non_md_and_existing() {
        let root = temp_root();
        assert!(create_concept(&root, "note.txt").is_err());
        create_concept(&root, "note.md").unwrap();
        assert!(create_concept(&root, "note.md").is_err());
    }

    #[test]
    fn create_folder_and_nested_create() {
        let root = temp_root();
        create_folder(&root, "sub/deep").unwrap();
        assert!(root.join("sub/deep").is_dir());
        create_concept(&root, "sub/deep/a.md").unwrap();
        assert!(root.join("sub/deep/a.md").is_file());
    }

    #[test]
    fn rename_moves_and_rejects_existing_target() {
        let root = temp_root();
        create_concept(&root, "a.md").unwrap();
        rename_path(&root, "a.md", "b.md").unwrap();
        assert!(!root.join("a.md").exists());
        assert!(root.join("b.md").exists());

        create_concept(&root, "c.md").unwrap();
        assert!(rename_path(&root, "b.md", "c.md").is_err());
    }

    #[test]
    fn delete_file_and_folder() {
        let root = temp_root();
        create_concept(&root, "a.md").unwrap();
        delete_path(&root, "a.md").unwrap();
        assert!(!root.join("a.md").exists());

        create_folder(&root, "folder").unwrap();
        create_concept(&root, "folder/b.md").unwrap();
        delete_path(&root, "folder").unwrap();
        assert!(!root.join("folder").exists());
    }

    #[test]
    fn delete_and_rename_refuse_the_bundle_root() {
        let root = temp_root();
        create_concept(&root, "keep.md").unwrap();
        for rel in ["", ".", "./", "a/.."] {
            assert!(delete_path(&root, rel).is_err(), "delete {rel:?}");
            assert!(rename_path(&root, rel, "moved").is_err(), "rename {rel:?}");
        }
        assert!(root.join("keep.md").exists());
    }

    #[test]
    fn rejects_escapes() {
        let root = temp_root();
        assert!(create_concept(&root, "../escape.md").is_err());
        assert!(create_folder(&root, "../escape").is_err());
        assert!(resolve_new(&root, "/abs/path.md").is_err());
        assert!(resolve_new(&root, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_new_rejects_a_symlinked_escape() {
        // A symlink inside the Bundle pointing OUTSIDE it must not let a new
        // target be created through it: the nearest existing ancestor (the
        // symlink) canonicalizes outside the root, so resolve_new rejects it.
        let root = temp_root();
        let outside = std::env::temp_dir().join(format!(
            "sunstone-outside-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape_link")).unwrap();

        assert!(resolve_new(&root, "escape_link/newfile.md").is_err());
        // A normal in-bundle new target still resolves fine.
        assert!(resolve_new(&root, "sub/newfile.md").is_ok());
    }

    #[test]
    fn resolve_rejects_escapes_and_resolves_in_bundle_paths() {
        let root = temp_root();
        create_concept(&root, "a.md").unwrap();
        // `..` escape and absolute paths are rejected.
        assert!(resolve(&root, "../a.md").is_err());
        assert!(resolve(&root, "/abs/a.md").is_err());
        // A non-existent file fails to canonicalize (resolve is for existing
        // targets — resolve_new covers create/destination paths).
        assert!(resolve(&root, "missing.md").is_err());
        // An existing in-bundle path resolves to a path under the root.
        let resolved = resolve(&root, "a.md").unwrap();
        assert!(resolved.starts_with(&root));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_a_symlinked_escape() {
        // Reading through an in-bundle symlink that points outside the Bundle
        // must be rejected: the canonical target falls outside the root.
        let root = temp_root();
        let outside = std::env::temp_dir().join(format!(
            "sunstone-outside-resolve-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape_link")).unwrap();

        assert!(resolve(&root, "escape_link/secret.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn delete_a_symlink_to_a_folder_removes_only_the_link() {
        let root = temp_root();
        create_folder(&root, "sub").unwrap();
        create_concept(&root, "sub/a.md").unwrap();
        std::os::unix::fs::symlink(root.join("sub"), root.join("shortcut")).unwrap();

        delete_path(&root, "shortcut").unwrap();
        assert!(root.join("shortcut").symlink_metadata().is_err());
        assert!(root.join("sub/a.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn delete_a_symlink_to_a_file_removes_only_the_link() {
        let root = temp_root();
        create_folder(&root, "sub").unwrap();
        create_concept(&root, "sub/a.md").unwrap();
        std::os::unix::fs::symlink(root.join("sub/a.md"), root.join("alias.md")).unwrap();

        delete_path(&root, "alias.md").unwrap();
        assert!(root.join("alias.md").symlink_metadata().is_err());
        assert!(root.join("sub/a.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rename_a_symlink_renames_the_link_not_its_target() {
        let root = temp_root();
        create_folder(&root, "sub").unwrap();
        create_concept(&root, "sub/a.md").unwrap();
        std::os::unix::fs::symlink(root.join("sub"), root.join("shortcut")).unwrap();

        let dst = rename_path(&root, "shortcut", "renamed").unwrap();
        assert_eq!(dst, root.join("renamed"));
        assert!(root.join("shortcut").symlink_metadata().is_err());
        assert!(root.join("renamed").symlink_metadata().unwrap().file_type().is_symlink());
        assert!(root.join("sub/a.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn delete_a_symlink_pointing_outside_removes_the_link_and_nothing_outside() {
        // The link itself lives in the Bundle, so deleting it is allowed; what
        // it points at is outside and must never be touched.
        let root = temp_root();
        let outside = std::env::temp_dir().join(format!(
            "sunstone-outside-delete-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape_link")).unwrap();

        // Nothing THROUGH the link may be deleted or moved.
        assert!(delete_path(&root, "escape_link/secret.md").is_err());
        assert!(rename_path(&root, "escape_link/secret.md", "stolen.md").is_err());
        assert!(outside.join("secret.md").exists());

        delete_path(&root, "escape_link").unwrap();
        assert!(root.join("escape_link").symlink_metadata().is_err());
        assert!(outside.join("secret.md").exists());
    }

    #[test]
    fn delete_and_rename_reject_a_missing_entry() {
        let root = temp_root();
        assert!(delete_path(&root, "missing.md").is_err());
        assert!(rename_path(&root, "missing.md", "b.md").is_err());
        assert!(delete_path(&root, "no/such/dir.md").is_err());
    }

    #[test]
    fn list_tree_sorts_dirs_first_then_case_insensitive_alpha() {
        let root = temp_root();
        create_concept(&root, "Banana.md").unwrap();
        create_concept(&root, "apple.md").unwrap();
        create_folder(&root, "zeta").unwrap();
        create_concept(&root, "zeta/inner.md").unwrap();

        let tree = list_tree(&root).unwrap();
        assert!(tree.is_dir);
        assert_eq!(tree.path, "");
        let children = tree.children.unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        // Dirs first ("zeta"), then files case-insensitively ("apple", "Banana").
        assert_eq!(names, vec!["zeta", "apple.md", "Banana.md"]);

        let zeta = children.iter().find(|c| c.name == "zeta").unwrap();
        assert!(zeta.is_dir);
        assert_eq!(zeta.path, "zeta");
        let inner = zeta.children.as_ref().unwrap();
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0].path, "zeta/inner.md");
        assert!(!inner[0].is_dir);
    }

    #[test]
    fn list_tree_carries_a_concepts_frontmatter_title() {
        let root = temp_root();
        std::fs::write(root.join("titled.md"), "---\ntype: x\ntitle: A Title\n---\nbody\n").unwrap();
        std::fs::write(root.join("plain.md"), "---\ntype: x\n---\nbody\n").unwrap();
        std::fs::write(root.join("notes.txt"), "---\ntitle: Not a Concept\n---\n").unwrap();

        let tree = list_tree(&root).unwrap();
        let children = tree.children.unwrap();
        let title = |name: &str| {
            children.iter().find(|c| c.name == name).unwrap().title.clone()
        };
        assert_eq!(title("titled.md").as_deref(), Some("A Title"));
        assert_eq!(title("plain.md"), None);
        assert_eq!(title("notes.txt"), None);
    }
}
