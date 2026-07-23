//! Pure leaf crate of Sunstone's frontend-shared algorithms (ADR 0006 §2).
//!
//! This crate compiles for **both** the native host and `wasm32`. Its
//! dependencies are limited to `serde` / `serde_yaml` (plus the optional
//! `tsify` / `wasm-bindgen` derives, gated behind the `wasm` feature so the
//! native build never pulls them in) — nothing native-only (`ignore`,
//! `notify`, `grep-*`, `dirs`) can leak into the wasm build.
//!
//! It is the ONE source of truth for the link family (family 10): wikilink /
//! slug / link resolution / anchor rewrite / pure paths. `sunstone-native`
//! depends on it and re-points its call sites here; `sunstone-wasm` wraps it
//! for the browser frontend.

pub mod frontmatter;
pub mod links;
pub mod paths;
pub mod rewrite;
pub mod slug;
pub mod wikilink;

pub use links::{find_bundle_root, resolve_link, ResolvedLink, RewriteBody, WikilinkTarget};
pub use rewrite::{rewrite_anchors_in, AnchorRename};
