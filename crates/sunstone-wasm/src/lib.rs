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

use sunstone_shared::citations::{self, CitationRef};
use sunstone_shared::critic::{self, Annotation, CriticMark};
use sunstone_shared::frontmatter::{
    self, FrontmatterField, IndexFrontmatter, SplitConcept,
};
use sunstone_shared::outline::{self, OutlineHeading};
use sunstone_shared::url;
use sunstone_shared::wikilink::{self, resolve_wikilink, WikilinkParts};
use sunstone_shared::{
    find_bundle_root, resolve_link, rewrite_anchors_in, AnchorRename, AnchorRewrite, ResolvedLink,
    RewriteBody, WikilinkTarget,
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

    /// Resolve a pretty URL path (already percent-decoded) to the matching
    /// Concept bundle path, or `null` (ADR 0006 §3 family 13 — resolves against
    /// the concept set the handle owns, retiring the TS `collectFilePaths`).
    #[wasm_bindgen(js_name = urlToConcept)]
    pub fn url_to_concept(&self, url_path: String) -> Option<String> {
        url::url_to_concept(&url_path, &self.concept_paths)
    }
}

// --- Free frontmatter exports (ADR 0006 §3, family 11) ----------------------
//
// Handle-less, per-call kernels (content-in / struct-out). `splitFrontmatter`
// slices a Concept into verbatim open/yaml/close/body so byte-preservation
// holds; the parse exports surface the index aggregates the fake backend twins
// natively. All delegate to the single source in `sunstone_shared::frontmatter`.

/// Split raw Concept markdown into its leading frontmatter block + body
/// (verbatim slices, so an unchanged document recombines byte-for-byte).
#[wasm_bindgen(js_name = splitFrontmatter)]
pub fn split_frontmatter(content: String) -> SplitConcept {
    frontmatter::split_concept(&content)
}

/// Number of leading lines the frontmatter block occupies (0 when none) — the
/// full-document ↔ body-relative line offset the editor applies.
#[wasm_bindgen(js_name = frontmatterLineCount)]
pub fn frontmatter_line_count(content: String) -> usize {
    frontmatter::frontmatter_line_count(&content)
}

/// The `type` scalar + `tags` flat list from a Concept's frontmatter.
#[wasm_bindgen(js_name = parseFrontmatter)]
pub fn parse_frontmatter(content: String) -> IndexFrontmatter {
    let p = frontmatter::parse_frontmatter(&content);
    IndexFrontmatter {
        concept_type: p.concept_type,
        tags: p.tags,
    }
}

/// The distinct top-level frontmatter keys of a Concept.
#[wasm_bindgen(js_name = parseFrontmatterKeys)]
pub fn parse_frontmatter_keys(content: String) -> Vec<String> {
    frontmatter::parse_frontmatter(&content).keys
}

/// Every top-level frontmatter entry as `key` + value(s), in document order.
#[wasm_bindgen(js_name = parseFrontmatterFields)]
pub fn parse_frontmatter_fields(content: String) -> Vec<FrontmatterField> {
    frontmatter::frontmatter_fields(&content)
}

// --- Free render-derived exports (ADR 0006 §3, family 13) -------------------
//
// The pure kernels behind the editor's Outline, CriticMarkup decorations and
// citation superscripts. All return offset-span structs (the CM-decoration
// seam) or the outline enumeration; the TS view/authoring layers stay thin over
// them. Native `render.rs` consumes the SAME `sunstone_shared` functions for its
// SSR render, so there is one algorithm everywhere.

/// Scan raw Concept markdown for its body headings (ATX only), in document
/// order — the editor Outline + `scrollToOutlineLine` source.
#[wasm_bindgen(js_name = scanHeadings)]
pub fn scan_headings(content: String) -> Vec<OutlineHeading> {
    outline::scan_headings(&content)
}

/// The full-document line of the first heading whose GitHub slug matches
/// `anchor`, or `null` (scrolls a `[[target#anchor]]` wikilink to its heading).
#[wasm_bindgen(js_name = findHeadingLine)]
pub fn find_heading_line(content: String, anchor: String) -> Option<usize> {
    outline::find_heading_line(&content, &anchor)
}

/// Every CriticMarkup mark in the doc, in document order (offset-span structs).
#[wasm_bindgen(js_name = parseCriticMarks)]
pub fn parse_critic_marks(doc: String) -> Vec<CriticMark> {
    critic::parse_critic_marks(&doc)
}

/// Group CriticMarkup marks into highlight+comment annotations.
#[wasm_bindgen(js_name = pairAnnotations)]
pub fn pair_annotations(marks: Vec<CriticMark>) -> Vec<Annotation> {
    critic::pair_annotations(&marks)
}

/// The annotation whose overall span contains `pos` (caret between chars), or
/// `null`.
#[wasm_bindgen(js_name = annotationAt)]
pub fn annotation_at(annotations: Vec<Annotation>, pos: usize) -> Option<Annotation> {
    critic::annotation_at(&annotations, pos)
}

/// Every inline citation reference (a `[n]` following a word) in `text`.
#[wasm_bindgen(js_name = findCitationRefs)]
pub fn find_citation_refs(text: String) -> Vec<CitationRef> {
    citations::find_citation_refs(&text)
}

/// The offset of citation `num`'s definition row (line-start `[num]`), or `null`.
#[wasm_bindgen(js_name = citationDefPos)]
pub fn citation_def_pos(text: String, num: String) -> Option<usize> {
    citations::citation_def_pos(&text, &num)
}

/// A Concept's bundle path → its pretty viewer URL pathname (drops `.md` and a
/// trailing `/index`; root `index.md` → `/`). Twin of native `render.rs`'s
/// resolved-link href, now single-sourced in `sunstone_shared`.
#[wasm_bindgen(js_name = conceptToUrl)]
pub fn concept_to_url(path: String) -> String {
    url::concept_url(&path)
}

/// GitHub-style slug for a single anchor/heading string (no de-duplication).
/// Surfaced so the fake backend's corpus-wide anchor rewriter matches anchors
/// against renames with the SAME slug rule the editor/native side uses — the
/// single source `sunstone_shared::slug::slugify` (family 13 retires `slug.ts`).
#[wasm_bindgen(js_name = slugify)]
pub fn slugify(text: String) -> String {
    sunstone_shared::slug::slugify(&text)
}

// --- Free link-family exports for the fake backend (ADR 0006 family 12) -----
//
// The fake backend's Layer-2 rename/move orchestration (twin of the NATIVE
// rename command) walks ARBITRARY corpus path-sets (old/new) with
// `target != source` — a shape the live `BundleIndex` handle (bound to its own
// set, source == target) does not expose. These handle-less exports run the
// SAME `sunstone_shared` kernels parameterized by an explicit path-set, so the
// fake consumes the single source instead of a forked TS re-impl.

/// Resolve a markdown link `href` from `current_path` against an explicit
/// concept path-set (the fake's corpus). The bundle root + membership are
/// derived from `paths`, so this is the real [`resolve_link`] — for a corpus
/// with a top-level `.md` the root is `''`, matching the former fake fork.
#[wasm_bindgen(js_name = resolveLinkIn)]
pub fn resolve_link_in(current_path: String, href: String, paths: Vec<String>) -> ResolvedLink {
    let set: HashSet<String> = paths.iter().cloned().collect();
    let root = find_bundle_root(&paths);
    resolve_link(&current_path, &href, &root, |p| set.contains(p))
}

/// Resolve a raw `[[target]]` inner text against an explicit concept path-set
/// (the fake's old/new corpus), or `null` (broken) — the handle-less twin of the
/// handle's `resolveWikilink`, over a set the handle does not own.
#[wasm_bindgen(js_name = resolveWikilinkIn)]
pub fn resolve_wikilink_in(
    paths: Vec<String>,
    source_path: String,
    raw_target: String,
) -> Option<WikilinkTarget> {
    resolve_wikilink(&paths, &source_path, &raw_target).map(|path| WikilinkTarget { path })
}

/// Split a raw `[[ ... ]]` inner text into `{ name, alias, anchor }` — the fake
/// move-rewrite's twin of the former TS `splitWikilinkTarget`, single-sourced on
/// `wikilink::parse_target`.
#[wasm_bindgen(js_name = splitWikilinkTarget)]
pub fn split_wikilink_target(raw: String) -> WikilinkParts {
    wikilink::parse_target_parts(&raw)
}

/// Corpus-wide anchor rewrite (`target != source`): rewrite every inbound link's
/// `#anchor` in `body` that resolves to `target` and whose slug matches a rename,
/// returning `{ content, count }`. The single source for the fake backend's
/// `rewriteAnchors` command (which the live handle's source == target op cannot
/// serve).
#[wasm_bindgen(js_name = rewriteAnchors)]
pub fn rewrite_anchors(
    source: String,
    body: String,
    target: String,
    renames: Vec<AnchorRename>,
    paths: Vec<String>,
) -> AnchorRewrite {
    let (content, count) = rewrite_anchors_in(&source, &body, &target, &renames, &paths);
    AnchorRewrite { content, count }
}
