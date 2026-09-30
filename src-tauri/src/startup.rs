//! Process startup and window-state plumbing: resolving the Bundle to open at
//! launch, the `--detached` re-spawn, and persisting window geometry keyed to
//! the open Bundle.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

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

/// The Document named on the command line (`sunstone ./docs guide/setup.md#x`),
/// resolved to a bundle-relative path plus an optional heading anchor.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct StartupDocument {
    pub path: String,
    pub anchor: Option<String>,
}

/// Managed state holding the startup Document until the frontend takes it
/// (`take_startup_document`), so a webview reload does not re-open it.
#[derive(Default)]
pub(crate) struct PendingStartupDocument(pub Mutex<Option<StartupDocument>>);

/// Resolve the DOCUMENT argument against the open Bundle `root`, or `None` when
/// it cannot name a file inside the Bundle.
///
/// A trailing `#heading` is split off as the anchor. The rest is tried as a
/// bundle-relative path first (a leading `/` is allowed, like a bundle-absolute
/// link), then relative to `cwd` — so a shell-completed `docs/guide/setup.md`
/// works when the Bundle is `docs`. A path that exists nowhere is still accepted
/// as bundle-relative (the editor then shows it as missing), unless it escapes
/// the Bundle via `..` or an absolute path outside `root`.
pub(crate) fn resolve_startup_document(
    root: &Path,
    arg: &str,
    cwd: &Path,
) -> Option<StartupDocument> {
    let (raw, anchor) = match arg.rsplit_once('#') {
        Some((p, a)) => (p, Some(a).filter(|a| !a.is_empty()).map(str::to_string)),
        None => (arg, None),
    };
    let bundle_rel = raw.trim_start_matches('/');
    if bundle_rel.is_empty() {
        return None;
    }
    let rel = if root.join(bundle_rel).is_file() {
        Some(PathBuf::from(bundle_rel))
    } else {
        let from_cwd = cwd.join(raw);
        from_cwd
            .canonicalize()
            .ok()
            .and_then(|abs| abs.strip_prefix(root).ok().map(Path::to_path_buf))
            .or_else(|| (!Path::new(raw).is_absolute()).then(|| PathBuf::from(bundle_rel)))
    }?;
    let segments: Vec<String> = rel
        .components()
        .map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            Component::CurDir => Some(String::new()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() {
        return None;
    }
    Some(StartupDocument {
        path: segments.join("/"),
        anchor,
    })
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
pub(crate) fn spawn_detached(
    bundle: &Option<String>,
    document: &Option<String>,
) -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    // The child inherits our working directory, so a cwd-relative DOCUMENT
    // still resolves the same way there.
    for arg in [bundle, document].into_iter().flatten() {
        cmd.arg(arg);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A canonical temp Bundle with `guide/setup.md` and `index.md`.
    fn bundle(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sunstone-startup-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("guide")).unwrap();
        std::fs::write(dir.join("guide/setup.md"), "# Setup\n").unwrap();
        std::fs::write(dir.join("index.md"), "# Index\n").unwrap();
        dir.canonicalize().unwrap()
    }

    fn doc(path: &str, anchor: Option<&str>) -> Option<StartupDocument> {
        Some(StartupDocument {
            path: path.into(),
            anchor: anchor.map(str::to_string),
        })
    }

    #[test]
    fn bundle_relative_path_with_and_without_anchor() {
        let root = bundle("rel");
        let cwd = Path::new("/");
        assert_eq!(resolve_startup_document(&root, "guide/setup.md", cwd), doc("guide/setup.md", None));
        assert_eq!(
            resolve_startup_document(&root, "guide/setup.md#install", cwd),
            doc("guide/setup.md", Some("install"))
        );
        assert_eq!(resolve_startup_document(&root, "/index.md#", cwd), doc("index.md", None));
    }

    #[test]
    fn cwd_relative_path_inside_the_bundle() {
        let root = bundle("cwd");
        let parent = root.parent().unwrap();
        let name = root.file_name().unwrap().to_string_lossy();
        let arg = format!("{name}/guide/setup.md#install");
        assert_eq!(
            resolve_startup_document(&root, &arg, parent),
            doc("guide/setup.md", Some("install"))
        );
        let abs = root.join("index.md");
        assert_eq!(resolve_startup_document(&root, abs.to_str().unwrap(), Path::new("/")), doc("index.md", None));
    }

    #[test]
    fn missing_file_stays_bundle_relative() {
        let root = bundle("missing");
        assert_eq!(resolve_startup_document(&root, "./new/page.md", Path::new("/")), doc("new/page.md", None));
    }

    #[test]
    fn paths_outside_the_bundle_are_refused() {
        let root = bundle("outside");
        let cwd = Path::new("/");
        assert_eq!(resolve_startup_document(&root, "../elsewhere.md", cwd), None);
        assert_eq!(resolve_startup_document(&root, "/etc/hostname", cwd), None);
        assert_eq!(resolve_startup_document(&root, "", cwd), None);
        assert_eq!(resolve_startup_document(&root, "#only-anchor", cwd), None);
    }
}
