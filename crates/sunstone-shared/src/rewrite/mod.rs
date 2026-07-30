//! Link-rewrite algorithms shared across native and wasm (ADR 0006 §2).
//!
//! Family 10 moves the live-buffer **anchor** rewrite here (`anchors`) plus the
//! pure URL/UTF-8 helpers it needs (`text`). The move/rename **engine** stays
//! native (`sunstone-native::rewrite::engine`); it imports these helpers.
//!
//! Named `text`, not `paths`, so it doesn't shadow the native engine's own
//! `rewrite::paths` (path-math for the move/rename engine) when both are
//! imported side by side.

pub mod anchors;
pub mod text;

pub use anchors::{rewrite_anchors_in, AnchorRename, AnchorRewrite};
