//! Sunstone's WebAssembly entry point (ADR 0006 §2/§3).
//!
//! Depends on `sunstone-shared` **only** (plus the wasm-bindgen toolchain). It
//! is compiled to `wasm32` via `wasm-pack build --target web` for the browser
//! frontend; the exports are inert on the native host, which is fine — native
//! `cargo check` here only proves the toolchain compiles.
//!
//! Family 10 gives the `BundleIndex` handle its real surface: it OWNS the
//! saved concept-path set (`new(conceptPaths)`) and resolves links / wikilinks
//! and rewrites live-buffer anchors against it — synchronously, in-process, so
//! CodeMirror decorations resolve against the unsaved buffer with the SAME
//! algorithm that runs natively (the single-source goal of ADR 0006).

use std::collections::HashSet;

use wasm_bindgen::prelude::*;

use sunstone_shared::wikilink::resolve_wikilink;
use sunstone_shared::{
    find_bundle_root, resolve_link, rewrite_anchors_in, AnchorRename, ResolvedLink, RewriteBody,
    WikilinkTarget,
};

/// The in-wasm Bundle index handle (ADR 0006 §3/§4). It OWNS the saved concept
/// path set (never the unsaved buffer — `currentPath` is passed per call) plus
/// the derived membership set and OKF bundle root. `indexStore` holds exactly
/// one, rebuilt wholesale (`.free()` the old) on mount / `file-changed` / CRUD.
#[wasm_bindgen]
pub struct BundleIndex {
    /// Every concept `.md` path (bundle-relative), the wikilink candidate set.
    concept_paths: Vec<String>,
    /// Membership set over `concept_paths` for O(1) `exists` / broken-link.
    set: HashSet<String>,
    /// Best-effort OKF bundle root within the opened tree (`''` = opened root).
    root: String,
}

#[wasm_bindgen]
impl BundleIndex {
    /// Construct a handle owning the saved concept-path set. Computes and holds
    /// the OKF bundle root once (retiring the TS `#rootCache` memo).
    #[wasm_bindgen(constructor)]
    pub fn new(concept_paths: Vec<String>) -> BundleIndex {
        let set: HashSet<String> = concept_paths.iter().cloned().collect();
        let root = find_bundle_root(&concept_paths);
        BundleIndex {
            concept_paths,
            set,
            root,
        }
    }

    /// Resolve a clicked markdown link `href` inside the Concept at
    /// `current_path`. The `internal` variant carries `exists` (§3).
    #[wasm_bindgen(js_name = resolveLink)]
    pub fn resolve_link(&self, current_path: String, href: String) -> ResolvedLink {
        resolve_link(&current_path, &href, &self.root, |p| self.set.contains(p))
    }

    /// Resolve a raw `[[target]]` inner text to `{ path }`, or `null` (broken).
    /// The candidate set stays in-wasm (name-based, ADR-0004).
    #[wasm_bindgen(js_name = resolveWikilink)]
    pub fn resolve_wikilink(
        &self,
        current_path: String,
        raw_target: String,
    ) -> Option<WikilinkTarget> {
        resolve_wikilink(&self.concept_paths, &current_path, &raw_target)
            .map(|path| WikilinkTarget { path })
    }

    /// The best-effort OKF bundle root (replaces the TS `#rootCache`).
    #[wasm_bindgen(js_name = bundleRoot)]
    pub fn bundle_root(&self) -> String {
        self.root.clone()
    }

    /// Whether a Concept exists at `path` (concept-set membership).
    pub fn exists(&self, path: String) -> bool {
        self.set.contains(&path)
    }

    /// The full concept-path set — the single source of the membership list
    /// (fed to `fuzzy.ts` for quick-nav, retiring `listConceptPaths` copies).
    #[wasm_bindgen(js_name = conceptPaths)]
    pub fn concept_paths(&self) -> Vec<String> {
        self.concept_paths.clone()
    }

    /// Rewrite same-file anchors in the live editor `body` after a heading-slug
    /// rename (body-in / body-out; the change count stays Rust-internal). The
    /// saved concept is both the resolution source and the rename target.
    #[wasm_bindgen(js_name = rewriteAnchorsIn)]
    pub fn rewrite_anchors_in(
        &self,
        source_path: String,
        body: String,
        renames: Vec<AnchorRename>,
    ) -> RewriteBody {
        let (content, _count) = rewrite_anchors_in(
            &source_path,
            &body,
            &source_path,
            &renames,
            &self.concept_paths,
        );
        RewriteBody { content }
    }
}
