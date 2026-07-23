//! Link-rewrite algorithms shared across native and wasm (ADR 0006 §2).
//!
//! Family 10 moves the live-buffer **anchor** rewrite here (`anchors`) plus the
//! pure URL/UTF-8 helpers it needs (`paths`). The move/rename **engine** stays
//! native (`sunstone-native::rewrite::engine`); it imports these helpers.

pub mod anchors;
pub mod paths;

pub use anchors::{rewrite_anchors_in, AnchorRename};
