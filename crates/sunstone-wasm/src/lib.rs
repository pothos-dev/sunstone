//! Sunstone's WebAssembly entry point (ADR 0006 §2/§3).
//!
//! Depends on `sunstone-shared` **only** (plus the wasm-bindgen toolchain). It
//! is compiled to `wasm32` via `wasm-pack build --target web` for the browser
//! frontend; the exports are inert on the native host, which is fine — native
//! `cargo check` here only proves the toolchain compiles.
//!
//! Step 0 ships a **dummy** `BundleIndex` handle (ADR §3 conventions:
//! handle-oriented, `#[wasm_bindgen]`, camelCase `js_name`). It carries NO real
//! link / frontmatter / render logic — that migrates in later families.

use wasm_bindgen::prelude::*;

/// Dummy handle standing in for the real resolution engine (ADR §3). It owns no
/// concept-path set yet; family 10 replaces this body with the real
/// `BundleIndex` surface (`resolveLink`, `resolveWikilink`, `conceptPaths`, …).
#[wasm_bindgen]
pub struct BundleIndex {
    root: String,
}

#[wasm_bindgen]
impl BundleIndex {
    /// Construct a handle rooted at a bundle-relative root path.
    #[wasm_bindgen(constructor)]
    pub fn new(bundle_root: String) -> BundleIndex {
        BundleIndex { root: bundle_root }
    }

    /// Trivial placeholder method: echoes the root plus the shared-crate
    /// marker, proving the `wasm -> shared` link stands up end-to-end.
    #[wasm_bindgen(js_name = bundleRoot)]
    pub fn bundle_root(&self) -> String {
        format!("{} [{}]", self.root, sunstone_shared::PLACEHOLDER)
    }
}
