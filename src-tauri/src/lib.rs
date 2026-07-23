mod cli;
mod session;

use std::path::PathBuf;
use std::sync::Arc;

use sunstone_native::bundle::{self, TreeNode};
use sunstone_native::config::{self, BundleState, KnownBundle, WindowState};
use sunstone_native::git::{self, FileAtRev, FileHistory};
use sunstone_native::index::TagCount;
use sunstone_native::render::{self, RenderPayload};
use sunstone_native::rewrite::{self, AnchorRename, RewriteSummary};
use sunstone_native::search::{self, SearchHit};
use session::Session;
use tauri::{Manager, State, WindowEvent};

/// Absolute path of the currently-open Bundle root. Errors in launcher mode (no
/// Bundle open); the frontend uses `current_bundle` when it may be either.
#[tauri::command]
fn bundle_root(session: State<'_, Arc<Session>>) -> Result<String, String> {
    let state = session.current()?;
    Ok(state.bundle_root.to_string_lossy().into_owned())
}

/// The currently-open Bundle root, or `None` when Sunstone launched with no path
/// and is showing the launcher. The frontend decides launcher-vs-editor from this.
#[tauri::command]
fn current_bundle(session: State<'_, Arc<Session>>) -> Option<String> {
    session
        .current_root()
        .map(|p| p.to_string_lossy().into_owned())
}

/// The launcher's known-folder list (previously-opened Bundles), most-recent
/// first. Purely config-derived — no open Bundle required.
#[tauri::command]
fn list_known_bundles() -> Vec<KnownBundle> {
    config::list_known_bundles()
}

/// Forget a known folder: drop its persisted per-Bundle config so the launcher
/// list (and the on-disk store) does not grow forever. `path` is the entry's
/// `path` (its store key).
#[tauri::command]
fn forget_bundle(path: String) -> Result<(), String> {
    config::forget_bundle(&path)
}

/// Open `path` as the current Bundle (from the launcher): canonicalize it, verify
/// it is a directory, then swap it in (build index, start watcher, record it,
/// restore geometry). The frontend reloads the webview afterwards so the whole
/// app re-initializes against the newly-open Bundle.
#[tauri::command]
fn open_bundle(session: State<'_, Arc<Session>>, path: String) -> Result<(), String> {
    let root = PathBuf::from(&path);
    let root = root.canonicalize().unwrap_or(root);
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.to_string_lossy()));
    }
    session.open(root)
}

/// Native "open folder" chooser for the launcher's "Open folder…" button. Returns
/// the chosen absolute path, or `None` if the user cancelled.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let chosen = app.dialog().file().blocking_pick_folder();
    Ok(chosen.and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Recursive directory tree of the Bundle.
#[tauri::command]
fn list_tree(session: State<'_, Arc<Session>>) -> Result<TreeNode, String> {
    let state = session.current()?;
    bundle::list_tree(&state.bundle_root)
}

/// Raw markdown of a single Concept, by bundle-relative path.
#[tauri::command]
fn read_concept(session: State<'_, Arc<Session>>, path: String) -> Result<String, String> {
    let state = session.current()?;
    bundle::read_concept(&state.bundle_root, &path)
}

/// Write a Concept's raw markdown back to disk (autosave). Records the write in
/// the self-write tracker so the filesystem watcher suppresses its own echo.
#[tauri::command]
fn write_concept(session: State<'_, Arc<Session>>, path: String, content: String) -> Result<(), String> {
    let state = session.current()?;
    let resolved = bundle::write_concept(&state.bundle_root, &path, &content)?;
    state.note_self_write(resolved);
    Ok(())
}

/// Create a new, empty Concept (`.md`) at `path` (bundle-relative). The minimal
/// stub is an empty file; the rich frontmatter scaffold is a later slice. NOT
/// recorded as a self-write: a structural create SHOULD refresh the tree.
#[tauri::command]
fn create_concept(session: State<'_, Arc<Session>>, path: String) -> Result<(), String> {
    let state = session.current()?;
    bundle::create_concept(&state.bundle_root, &path)?;
    Ok(())
}

/// Create a new folder (and any missing parents) at `path` (bundle-relative).
#[tauri::command]
fn create_folder(session: State<'_, Arc<Session>>, path: String) -> Result<(), String> {
    let state = session.current()?;
    bundle::create_folder(&state.bundle_root, &path)?;
    Ok(())
}

/// Rename/move `from` to `to` (both bundle-relative). Performs the filesystem
/// rename AND automatically rewrites every link affected by the move (inbound
/// links from other Concepts, plus the moved Concept's own relative outbound
/// links — folder moves apply this to every contained Concept). Works for both
/// Concepts and folders. Returns a summary of how many links across how many
/// files were rewritten.
#[tauri::command]
fn rename_path(
    session: State<'_, Arc<Session>>,
    from: String,
    to: String,
) -> Result<RewriteSummary, String> {
    let state = session.current()?;
    rewrite::rename_and_rewrite(&state, &from, &to)
}

/// Move `from` into the folder `toDir` (bundle-relative; '' for the root),
/// keeping the original name, then auto-rewrite affected links. Convenience over
/// `rename_path`; returns the same rewrite summary.
#[tauri::command]
fn move_path(
    session: State<'_, Arc<Session>>,
    from: String,
    to_dir: String,
) -> Result<RewriteSummary, String> {
    let state = session.current()?;
    rewrite::move_into(&state, &from, &to_dir)
}

/// Delete `path` (a Concept or a folder, recursively). The frontend confirms
/// before calling this.
#[tauri::command]
fn delete_path(session: State<'_, Arc<Session>>, path: String) -> Result<(), String> {
    let state = session.current()?;
    bundle::delete_path(&state.bundle_root, &path)
}

/// Rewrite inbound link anchors after a heading in `target` was renamed in the
/// editor (slice: slug-anchor-rewrite). `renames` maps each changed heading's old
/// slug to its new slug; every concept linking to `target` has its matching
/// `#anchor`s rewritten. Returns a summary of how many anchors across how many
/// files changed. The target's own same-file anchors are handled in the buffer.
#[tauri::command]
fn rewrite_anchors(
    session: State<'_, Arc<Session>>,
    target: String,
    renames: Vec<AnchorRename>,
) -> Result<RewriteSummary, String> {
    let state = session.current()?;
    rewrite::rewrite_anchors(&state, &target, &renames)
}

/// Every Concept path in the Bundle index. The frontend seeds its synchronous
/// broken-link existence cache from this (one query instead of per-link calls).
#[tauri::command]
fn list_concept_paths(session: State<'_, Arc<Session>>) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.concept_paths())
}

/// Whether a Concept exists at `path` (bundle-relative). Convenience companion
/// to `list_concept_paths`; the broken-link decoration uses the cached set.
#[tauri::command]
fn concept_exists(session: State<'_, Arc<Session>>, path: String) -> Result<bool, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.concept_exists(&path))
}

/// Sources linking TO `path` (backlinks). Used by the backlinks panel (slice 7).
#[tauri::command]
fn backlinks(session: State<'_, Arc<Session>>, path: String) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.backlinks(&path))
}

/// All tags across the Bundle with per-tag counts. Used by the tags view (slice 8).
#[tauri::command]
fn all_tags(session: State<'_, Arc<Session>>) -> Result<Vec<TagCount>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.all_tags())
}

/// Concept paths carrying `tag`. Used by the tag browser (slice 8) to reveal
/// the Concepts under a selected tag.
#[tauri::command]
fn concepts_by_tag(session: State<'_, Arc<Session>>, tag: String) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.concepts_by_tag(&tag))
}

/// All distinct frontmatter `type` values. Used by new-concept autocomplete (slice 12).
#[tauri::command]
fn all_types(session: State<'_, Arc<Session>>) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.all_types())
}

/// All distinct top-level frontmatter keys across the Bundle. Used by the
/// Properties panel's key-name autocomplete (key-and-tag autocomplete slice);
/// the OKF recommended keys are merged in client-side.
#[tauri::command]
fn all_keys(session: State<'_, Arc<Session>>) -> Result<Vec<String>, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    Ok(index.all_keys())
}

/// Full-text (body content) search across the Bundle, on demand. Scans every
/// `.md` Concept body with the ripgrep libraries (no external binary) and
/// returns matches (path + 1-based line + matching line snippet), ordered by
/// path then line and capped server-side. Case-insensitive literal search.
#[tauri::command]
fn search(session: State<'_, Arc<Session>>, query: String) -> Result<Vec<SearchHit>, String> {
    let state = session.current()?;
    search::search(&state.bundle_root, &query)
}

/// Commit history (newest first) of the commits touching the bundle-relative
/// `path`, via `git log --follow`. The backend does NO diffing. Every edge
/// (not-a-repo / untracked / no-history / git-missing) comes back as a
/// distinguishable `FileHistory` variant so the review-diff toggle can disable
/// itself; only a path-escape is a hard error. Paths are bundle-relative,
/// '/'-separated.
#[tauri::command]
fn file_history(session: State<'_, Arc<Session>>, path: String) -> Result<FileHistory, String> {
    let state = session.current()?;
    // Reject `..`/absolute escapes the same way the other path commands do; the
    // target need not exist on disk (history can outlive the working tree).
    bundle::resolve_new(&state.bundle_root, &path)?;
    Ok(git::file_history(&state.bundle_root, &path))
}

/// Full text of the bundle-relative `path` at revision `rev`, via
/// `git show <rev>:<path>`. The working-tree side is the ordinary
/// `read_concept`; the frontend diffs the two. Edge cases surface as
/// `FileAtRev` variants (not-a-repo / not-found / git-missing) rather than
/// errors; only a path-escape is a hard error.
#[tauri::command]
fn file_at_rev(
    session: State<'_, Arc<Session>>,
    path: String,
    rev: String,
) -> Result<FileAtRev, String> {
    let state = session.current()?;
    bundle::resolve_new(&state.bundle_root, &path)?;
    Ok(git::file_at_rev(&state.bundle_root, &path, &rev))
}

/// Render the Concept at `path` (bundle-relative) to server-quality HTML: the
/// body rendered with CriticMarkup annotations and resolved wikilinks, plus the
/// parsed frontmatter and heading outline. Same core render the web viewer uses
/// (`sunstone_native::render`); feeds the desktop "Export as PDF" print path. Links
/// resolve against the in-memory index; the read lock is held only for the call.
#[tauri::command]
fn render_concept(session: State<'_, Arc<Session>>, path: String) -> Result<RenderPayload, String> {
    let state = session.current()?;
    let index = state.read_index()?;
    render::render_concept(&state.bundle_root, &index, &path)
}

/// Percent-encode a string for use in a URL query value (RFC 3986 unreserved
/// set passes through; everything else is `%XX`). Small local helper so the
/// print-window URL below needs no extra dependency.
fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Open a chrome-free print/PDF preview of the Concept at `path` in a SEPARATE
/// native window (WebKitGTK has no rich PDF chrome of its own, so the preview
/// carries its own reader controls). The window loads the same SPA shell with
/// `?print=<path>&toolbar=1`, which the root route resolves to `PrintView`.
/// If a print window is already open it is reused (navigated + focused).
#[tauri::command]
fn open_print_window(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let query = format!("?print={}&toolbar=1", encode_query(&path));
    if let Some(existing) = app.get_webview_window("print") {
        existing
            .eval(&format!("window.location.replace('index.html{query}')"))
            .map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "print",
        tauri::WebviewUrl::App(format!("index.html{query}").into()),
    )
    .title("Print — Sunstone")
    .inner_size(900.0, 1100.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Export the print window's current rendering straight to a PDF FILE, skipping
/// the OS print dialog. Prompts for a destination with a native save-file
/// chooser (default name `default_name`), then writes the PDF. Returns the saved
/// path, or `None` if the chooser was cancelled. Direct export is implemented
/// via WebKitGTK on Linux; other platforms return an error so the frontend can
/// fall back to the print dialog (`window.print()`).
#[tauri::command]
async fn save_pdf(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let chosen = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(&default_name)
        .blocking_save_file();
    let Some(chosen) = chosen else {
        return Ok(None); // user cancelled the save dialog
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    export_webview_pdf(&window, &path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// WebKitGTK-backed PDF export: drive the webview's `WebKitPrintOperation` with
/// GTK print settings pointed at a "Print to File" PDF output, so `print()`
/// writes the file WITHOUT showing a dialog. Runs on the GTK main thread via
/// `with_webview`.
#[cfg(target_os = "linux")]
fn export_webview_pdf(
    window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    let uri = format!("file://{}", path.to_string_lossy());
    window
        .with_webview(move |platform| {
            let webview = platform.inner();
            let settings = gtk::PrintSettings::new();
            settings.set("output-uri", Some(uri.as_str()));
            settings.set("output-file-format", Some("pdf"));
            let op = PrintOperation::new(&webview);
            op.set_print_settings(&settings);
            // `print()` is asynchronous; keep the operation alive until it emits
            // `finished` (otherwise dropping the wrapper here cancels the export).
            // A self-reference held in the `finished` handler is released once the
            // file is written, letting the operation drop.
            let hold = std::rc::Rc::new(std::cell::RefCell::new(None));
            let hold_in = hold.clone();
            op.connect_finished(move |_| {
                hold_in.borrow_mut().take();
            });
            *hold.borrow_mut() = Some(op.clone());
            op.print();
        })
        .map_err(|e| e.to_string())
}

/// macOS PDF export via `WKWebView.createPDFWithConfiguration:completionHandler:`
/// (macOS 11+). The completion block writes the returned `NSData` to `path`.
/// Best-effort: implemented to the documented API but not runtime-verified.
#[cfg(target_os = "macos")]
fn export_webview_pdf(
    window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::WKWebView;

    let out = path.to_owned();
    window
        .with_webview(move |platform| {
            let ptr = platform.inner() as *const WKWebView;
            let Some(webview) = (unsafe { ptr.as_ref() }) else {
                return;
            };
            let out = out.clone();
            // WKWebView copies the completion block, so it outlives this scope.
            let handler = RcBlock::new(move |data: *mut NSData, _err: *mut NSError| {
                if let Some(data) = unsafe { data.as_ref() } {
                    let _ = std::fs::write(&out, data.to_vec());
                }
            });
            unsafe {
                webview.createPDFWithConfiguration_completionHandler(None, &handler);
            }
        })
        .map_err(|e| e.to_string())
}

/// Windows PDF export via WebView2 `ICoreWebView2_7::PrintToPdf`, which writes
/// the PDF straight to a file path (no dialog). Best-effort: implemented to the
/// documented API but not runtime-verified.
#[cfg(windows)]
fn export_webview_pdf(
    window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PrintSettings, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    let file = HSTRING::from(path.to_string_lossy().as_ref());
    window
        .with_webview(move |platform| {
            let run = || -> windows::core::Result<()> {
                let core = unsafe { platform.controller().CoreWebView2()? };
                let wv7: ICoreWebView2_7 = core.cast()?;
                let handler = PrintToPdfCompletedHandler::create(Box::new(|_hr, _ok| Ok(())));
                let no_settings: Option<&ICoreWebView2PrintSettings> = None;
                unsafe { wv7.PrintToPdf(&file, no_settings, &handler)? };
                Ok(())
            };
            if let Err(e) = run() {
                eprintln!("WebView2 PrintToPdf failed: {e}");
            }
        })
        .map_err(|e| e.to_string())
}

/// Platforms without a wired-up webview PDF exporter: report unsupported so the
/// frontend falls back to the print dialog (`window.print()`).
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn export_webview_pdf(
    _window: &tauri::WebviewWindow,
    _path: &std::path::Path,
) -> Result<(), String> {
    Err("direct PDF export is not supported on this platform".into())
}

/// Load the persisted per-Bundle session state (last-open Concept, expanded
/// folders, window geometry) for the open Bundle. Robust to a missing/corrupt
/// store: returns defaults. See `config.rs` — never written into the Bundle.
#[tauri::command]
fn load_bundle_state(session: State<'_, Arc<Session>>) -> Result<BundleState, String> {
    let state = session.current()?;
    Ok(config::load_bundle_state(&state.bundle_root))
}

/// Persist the per-Bundle session state for the open Bundle. Merges into the
/// global store (other Bundles' entries + app config are preserved). The
/// frontend calls this (debounced) when the open Concept or expanded folders
/// change. Window geometry is owned by Rust and merged separately, so the
/// frontend's saved value here carries the window through untouched.
#[tauri::command]
fn save_bundle_state(session: State<'_, Arc<Session>>, bundle_state: BundleState) -> Result<(), String> {
    let state = session.current()?;
    config::save_bundle_state(&state.bundle_root, bundle_state)
}

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
fn resolve_startup_bundle(cli_path: Option<String>) -> Option<PathBuf> {
    let explicit = std::env::var("SUNSTONE_BUNDLE")
        .ok()
        .filter(|s| !s.is_empty())
        .or(cli_path)?;
    let path = PathBuf::from(explicit);
    Some(path.canonicalize().unwrap_or(path))
}

/// Env marker set on the re-spawned child of a `--detached` launch, so the child
/// runs the UI normally instead of detaching again (which would loop forever).
const DETACHED_CHILD_ENV: &str = "SUNSTONE_DETACHED_CHILD";

/// Re-spawn this executable as a console-independent child and let the parent
/// return immediately, freeing the terminal (`--detached` / `-d`). The child is
/// given its own process group (so terminal job-control signals — Ctrl+C, and
/// SIGHUP on terminal close — don't reach it) with stdio detached to null; on
/// Windows it gets `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`. The Bundle
/// path is forwarded; `SUNSTONE_BUNDLE` and the rest of the environment are
/// inherited. The `DETACHED_CHILD_ENV` marker stops the child from detaching
/// again.
fn spawn_detached(bundle: &Option<String>) -> std::io::Result<()> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse the command line BEFORE starting Tauri so `--version`/`--help` print
    // to the terminal and exit without ever opening a window, and unknown options
    // are rejected instead of being treated as a Bundle path.
    let opts = match cli::parse_args(std::env::args().skip(1)) {
        cli::CliAction::Run(opts) => opts,
        cli::CliAction::Version => {
            println!("{}", cli::version_string());
            return;
        }
        cli::CliAction::Help => {
            print!("{}", cli::help_string());
            return;
        }
        cli::CliAction::Error(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };

    // `--detached`: re-spawn ourselves as a console-independent process and let
    // this (parent) process exit, returning the shell prompt. Skip when we ARE
    // the re-spawned child (marker set), so the child runs the UI normally.
    if opts.detached && std::env::var_os(DETACHED_CHILD_ENV).is_none() {
        match spawn_detached(&opts.bundle) {
            Ok(()) => return,
            Err(e) => {
                eprintln!("error: failed to launch detached: {e}");
                std::process::exit(1);
            }
        }
    }

    let cli_path = opts.bundle;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // The Session is the swappable seam between launcher mode (no Bundle)
            // and an open Bundle. It owns the current `AppState` + watcher and is
            // managed in Tauri state; every Bundle command reads through it.
            let sess = Arc::new(Session::new(app.handle().clone()));
            app.manage(sess.clone());

            // Save window geometry on resize / move / close, keyed to whichever
            // Bundle is currently open (via the Session, so a runtime Bundle
            // switch persists geometry against the NEW root, not the old one).
            // No-op in launcher mode (no current Bundle to key against). We persist
            // the window slice independently of the frontend's session state so the
            // two never clobber each other.
            if let Some(window) = app.get_webview_window("main") {
                let session_for_events = sess.clone();
                let window_for_events = window.clone();
                window.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::Resized(_)
                            | WindowEvent::Moved(_)
                            | WindowEvent::CloseRequested { .. }
                    ) {
                        if let Some(root) = session_for_events.current_root() {
                            if let Some(ws) = capture_window_state(&window_for_events) {
                                let _ = config::save_window_state(&root, ws);
                            }
                        }
                    }
                });
            }

            // Open the startup Bundle if one was named (env/CLI); otherwise leave
            // the Session empty so the frontend shows the launcher. `open` builds
            // the index, starts the watcher, records the folder, and restores the
            // saved window geometry — the same work a launcher pick triggers.
            if let Some(root) = resolve_startup_bundle(cli_path) {
                if let Err(e) = sess.open(root) {
                    eprintln!("failed to open startup Bundle: {e}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bundle_root,
            current_bundle,
            list_known_bundles,
            forget_bundle,
            open_bundle,
            pick_folder,
            list_tree,
            read_concept,
            write_concept,
            create_concept,
            create_folder,
            rename_path,
            move_path,
            delete_path,
            rewrite_anchors,
            list_concept_paths,
            concept_exists,
            backlinks,
            all_tags,
            concepts_by_tag,
            all_types,
            all_keys,
            search,
            file_history,
            file_at_rev,
            render_concept,
            open_print_window,
            save_pdf,
            load_bundle_state,
            save_bundle_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
