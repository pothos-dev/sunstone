//! The open-Bundle session: the swappable seam between "no Bundle open"
//! (launcher) and "a Bundle open" (the editor).
//!
//! Historically the desktop shell built one `AppState` at startup and managed it
//! for the whole process lifetime. The launcher (open Sunstone with no path →
//! pick a known folder) needs to switch the open Bundle at RUNTIME, so the
//! command layer no longer talks to a fixed `AppState` — it goes through this
//! `Session`, which holds the *current* `AppState` (and its filesystem watcher)
//! behind locks and swaps both atomically on `open`.
//!
//! `AppState` itself stays immutable and per-Bundle (rebuilt fresh on every
//! open); only the pointer the commands read swaps. The watcher is stored here
//! too so opening a new Bundle drops the old watcher (stopping it) and starts a
//! fresh one over the new root.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sunstone_native::app_state::AppState;
use sunstone_native::config;
use sunstone_native::watcher::{self, WatcherHandle, FILE_CHANGED_EVENT};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

/// The runtime Bundle session, managed in Tauri state. Commands that need the
/// open Bundle call [`Session::current`]; the launcher calls [`Session::open`].
pub struct Session {
    /// Handle to the app, used to emit watcher events to the frontend and to
    /// restore window geometry when a Bundle is opened.
    app: AppHandle,
    /// The currently-open Bundle's state, or `None` in launcher mode.
    current: Mutex<Option<Arc<AppState>>>,
    /// The filesystem watcher over the current Bundle root. Held so opening a new
    /// Bundle drops (stops) the old one; `None` in launcher mode.
    watcher: Mutex<Option<WatcherHandle>>,
}

impl Session {
    /// A fresh session with no Bundle open (launcher mode).
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            current: Mutex::new(None),
            watcher: Mutex::new(None),
        }
    }

    /// The open Bundle's state, or an error when no Bundle is open. The common
    /// command path is `let state = session.current()?;` then the usual queries.
    pub fn current(&self) -> Result<Arc<AppState>, String> {
        self.current
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "no Bundle is open".to_string())
    }

    /// The open Bundle's root path, or `None` in launcher mode. Used by the window
    /// geometry handler to persist geometry against the *current* Bundle.
    pub fn current_root(&self) -> Option<PathBuf> {
        self.current
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.bundle_root.clone()))
    }

    /// Open `root` as the current Bundle: build its index, start a fresh watcher,
    /// swap both into place (dropping any previous watcher), record it as a known
    /// folder (stamping `last_opened`), and restore its saved window geometry.
    ///
    /// The frontend reloads the webview after this returns, so the whole app
    /// re-initializes against the newly-open Bundle.
    pub fn open(&self, root: PathBuf) -> Result<(), String> {
        // Build the index for the new Bundle up front.
        let state = Arc::new(AppState::new(root.clone()));

        // Start a watcher over the new root, emitting (non-self) changes to the
        // frontend exactly as the original startup watcher did.
        let app = self.app.clone();
        let watcher = watcher::start(root.clone(), state.clone(), move |change| {
            let _ = app.emit(FILE_CHANGED_EVENT, change);
        })?;

        // Swap current state + watcher atomically-ish (each behind its own lock).
        // Assigning the watcher drops the previous one, stopping the old watch.
        *self.current.lock().map_err(|e| e.to_string())? = Some(state);
        *self.watcher.lock().map_err(|e| e.to_string())? = Some(WatcherHandle::new(watcher));

        // Remember this folder for the launcher (creates/stamps the store entry).
        let _ = config::touch_bundle(&root);

        // Restore the saved window geometry for this Bundle (size always; position
        // only if we have one), mirroring the original startup restore.
        if let Some(win) = config::load_window_state(&root) {
            if let Some(window) = self.app.get_webview_window("main") {
                let _ = window.set_size(LogicalSize::new(win.width, win.height));
                if let (Some(x), Some(y)) = (win.x, win.y) {
                    let _ = window.set_position(LogicalPosition::new(x, y));
                }
            }
        }

        Ok(())
    }
}
