//! `sunstone serve`: the desktop editor served to a browser on localhost, with
//! no window. The server half is `sunstone_server::serve_local`; this module
//! only resolves the Bundle and hands over the SPA build Tauri embedded, so the
//! browser runs exactly the frontend the window would.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sunstone_server::{AppShellAssets, LocalServeOptions};
use tauri::utils::assets::AssetKey;

use crate::cli::ServeOptions;
use crate::startup;

/// Serve until interrupted. Exits non-zero on a bind or serve error.
pub(crate) fn run(opts: ServeOptions, context: tauri::Context<tauri::Wry>) {
    // Same precedence as the app (`SUNSTONE_BUNDLE`, then the argument), but
    // with no launcher to fall back to, an unnamed Bundle is the current dir.
    let bundle_root =
        startup::resolve_startup_bundle(opts.bundle).unwrap_or_else(|| PathBuf::from("."));
    let served = sunstone_server::serve_local(LocalServeOptions {
        bundle_root,
        port: opts.port,
        assets: app_shell_assets(context),
    });
    if let Err(e) = tauri::async_runtime::block_on(served) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// The SPA build Tauri embedded into this binary. A dev build (`cargo run`,
/// `tauri dev`) embeds nothing — its window loads the Vite dev server — so it
/// falls back to the static build on disk (`bun run build` → `build/`).
fn app_shell_assets(context: tauri::Context<tauri::Wry>) -> AppShellAssets {
    let embedded = context.assets;
    if embedded.get(&AssetKey::from("index.html")).is_some() {
        return Arc::new(move |rel: &str| embedded.get(&AssetKey::from(rel)).map(Cow::into_owned));
    }
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../build");
    eprintln!("dev build: serving the app shell from {}", dir.display());
    Arc::new(move |rel: &str| std::fs::read(dir.join(rel)).ok())
}
