//! Link-rewrite algorithms shared across native and wasm (ADR 0006 §2).
//!
//! * `anchors` — the heading-anchor rewrite (live buffer + corpus-wide).
//! * `moves` — the move/rename engine (`plan_rewrites`, `build_move_map`):
//!   path-aware rewriting of markdown links, Embeds and wikilinks when
//!   Concepts move. Native `sunstone-native::rewrite` drives it around the
//!   filesystem; the wasm `planMoveRewrites` export drives it for the fake
//!   backend.
//! * `relpath` — the engine's path math (`relative_path`,
//!   `shortest_resolving_suffix`, `basename_of`).
//! * `text` — the URL / link-inner helpers both rewriters share.

pub mod anchors;
pub mod moves;
pub mod relpath;
pub mod text;

pub use anchors::{rewrite_anchors_in, AnchorRename, AnchorRewrite};
pub use moves::{build_move_map, plan_rewrites, ConceptContent, MovePlan, RewriteSummary};
