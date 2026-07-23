//! Sunstone's reusable domain logic: bundle tree/IO, the in-memory index,
//! link-rewrite orchestration, full-text search, the filesystem watcher, and
//! per-Bundle config/session state. Host-agnostic — the Tauri desktop shell
//! (`src-tauri`) and a future web server both depend on this crate.
//!
//! Nothing here depends on `tauri`: the watcher drains change events through a
//! caller-supplied sink (see `watcher::start`) rather than emitting directly.

pub mod app_state;
pub mod bundle;
pub mod config;
pub mod git;
pub mod index;
pub mod paths;
pub mod render;
pub mod rewrite;
pub mod search;
pub mod slug;
pub mod watcher;
pub mod wikilink;
