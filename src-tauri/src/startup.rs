//! Process startup and window-state plumbing: resolving the Bundle to open at
//! launch, the `--detached` re-spawn, and persisting window geometry keyed to
//! the open Bundle.

use std::path::PathBuf;
use std::sync::Arc;

use sunstone_native::config::{self, WindowState};
use tauri::{Manager, WindowEvent};

use crate::session::Session;

/// Capture the current window geometry into a `WindowState`. Uses logical
/// (DPI-independent) units so a restore on a differently-scaled display is sane.
fn capture_window_state(window: &tauri::WebviewWindow) -> Option<WindowState> {
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    let pos = window
        .outer_position()
        .ok()
        .map(|p| p.to_logical::<f64>(scale));
    Some(WindowState {
        width: size.width.round() as u32,
        height: size.height.round() as u32,
        x: pos.map(|p| p.x.round() as i32),
        y: pos.map(|p| p.y.round() as i32),
    })
}

/// Save window geometry on resize / move / close, keyed to whichever Bundle is
/// currently open (via the Session, so a runtime Bundle switch persists geometry
/// against the NEW root, not the old one). No-op in launcher mode (no current
/// Bundle to key against). We persist the window slice independently of the
/// frontend's session state so the two never clobber each other.
pub(crate) fn wire_window_persistence(app: &tauri::App, sess: Arc<Session>) {
    if let Some(window) = app.get_webview_window("main") {
        let window_for_events = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                WindowEvent::Resized(_)
                    | WindowEvent::Moved(_)
                    | WindowEvent::CloseRequested { .. }
            ) {
                if let Some(root) = sess.current_root() {
                    if let Some(ws) = capture_window_state(&window_for_events) {
                        let _ = config::save_window_state(&root, ws);
                    }
                }
            }
        });
    }
}

/// Resolve the Bundle to open at startup, or `None` to show the launcher.
///
/// A Bundle is opened up front ONLY when one was explicitly named:
///   1. the `SUNSTONE_BUNDLE` env var, if set and non-empty, else
///   2. the positional CLI path (already parsed by `cli::parse_args`).
///
/// With neither (`sunstone` with no arguments) we return `None`: the frontend
/// shows the launcher (pick a known folder or open a new one), which then calls
/// `open_bundle` to open one in-process. The result is canonicalized so it keys
/// the config store stably.
pub(crate) fn resolve_startup_bundle(cli_path: Option<String>) -> Option<PathBuf> {
    let explicit = std::env::var("SUNSTONE_BUNDLE")
        .ok()
        .filter(|s| !s.is_empty())
        .or(cli_path)?;
    let path = PathBuf::from(explicit);
    Some(path.canonicalize().unwrap_or(path))
}

/// Env marker set on the re-spawned child of a `--detached` launch, so the child
/// runs the UI normally instead of detaching again (which would loop forever).
pub(crate) const DETACHED_CHILD_ENV: &str = "SUNSTONE_DETACHED_CHILD";

/// Re-spawn this executable as a console-independent child and let the parent
/// return immediately, freeing the terminal (`--detached` / `-d`). The child is
/// given its own process group (so terminal job-control signals — Ctrl+C, and
/// SIGHUP on terminal close — don't reach it) with stdio detached to null; on
/// Windows it gets `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`. The Bundle
/// path is forwarded; `SUNSTONE_BUNDLE` and the rest of the environment are
/// inherited. The `DETACHED_CHILD_ENV` marker stops the child from detaching
/// again.
pub(crate) fn spawn_detached(bundle: &Option<String>) -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    if let Some(path) = bundle {
        cmd.arg(path);
    }
    cmd.env(DETACHED_CHILD_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New process group, detached from the terminal's job control.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(|_| ())
}
