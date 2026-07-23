//! Pure leaf crate of Sunstone's frontend-shared algorithms (ADR 0006 §2).
//!
//! This crate compiles for **both** the native host and `wasm32`. Its
//! dependencies are limited to `serde` / `serde_yaml` so nothing native-only
//! (`ignore`, `notify`, `grep-*`, `dirs`) can leak into the wasm build.
//!
//! Step 0 keeps it essentially empty — the real wikilink / slug / rewrite /
//! index-frontmatter / index-links / paths logic migrates in later families
//! (10 / 11 / 13). It exists now only so the pure leaf triad and the build
//! pipeline can stand up end-to-end.

/// Placeholder marker so the crate has an inspectable, testable surface until
/// the real algorithms land. Replaced/removed by the family-10 migration.
pub const PLACEHOLDER: &str = "sunstone-shared: pipeline stand-up (ADR 0006 Step 0)";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_is_present() {
        assert!(PLACEHOLDER.contains("sunstone-shared"));
    }
}
