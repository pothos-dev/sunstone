mod cli;
mod commands;
mod pdf;
mod session;
mod startup;

use std::sync::Arc;

use session::Session;
use tauri::Manager;

/// Parse the command line and act on the terminal-only modes (`--version`,
/// `--help`, errors, `--detached` re-spawn). Returns the options the UI run
/// should use, or `None` when this process is done (printed/re-spawned).
fn handle_cli() -> Option<cli::RunOptions> {
    // Parse the command line BEFORE starting Tauri so `--version`/`--help` print
    // to the terminal and exit without ever opening a window, and unknown options
    // are rejected instead of being treated as a Bundle path.
    let opts = match cli::parse_args(std::env::args().skip(1)) {
        cli::CliAction::Run(opts) => opts,
        cli::CliAction::Version => {
            println!("{}", cli::version_string());
            return None;
        }
        cli::CliAction::Help => {
            print!("{}", cli::help_string());
            return None;
        }
        cli::CliAction::Error(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };

    // `--detached`: re-spawn ourselves as a console-independent process and let
    // this (parent) process exit, returning the shell prompt. Skip when we ARE
    // the re-spawned child (marker set), so the child runs the UI normally.
    if opts.detached && std::env::var_os(startup::DETACHED_CHILD_ENV).is_none() {
        match startup::spawn_detached(&opts.bundle) {
            Ok(()) => return None,
            Err(e) => {
                eprintln!("error: failed to launch detached: {e}");
                std::process::exit(1);
            }
        }
    }

    Some(opts)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let Some(opts) = handle_cli() else {
        return;
    };
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

            startup::wire_window_persistence(app, sess.clone());

            // Open the startup Bundle if one was named (env/CLI); otherwise leave
            // the Session empty so the frontend shows the launcher. `open` builds
            // the index, starts the watcher, records the folder, and restores the
            // saved window geometry — the same work a launcher pick triggers.
            if let Some(root) = startup::resolve_startup_bundle(cli_path) {
                if let Err(e) = sess.open(root) {
                    eprintln!("failed to open startup Bundle: {e}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bundle_root,
            commands::current_bundle,
            commands::list_known_bundles,
            commands::forget_bundle,
            commands::open_bundle,
            commands::pick_folder,
            commands::list_tree,
            commands::read_concept,
            commands::write_concept,
            commands::create_concept,
            commands::create_folder,
            commands::rename_path,
            commands::move_path,
            commands::delete_path,
            commands::rewrite_anchors,
            commands::list_concept_paths,
            commands::backlinks,
            commands::all_tags,
            commands::concepts_by_tag,
            commands::all_types,
            commands::all_keys,
            commands::search,
            commands::file_history,
            commands::file_at_rev,
            commands::render_concept,
            pdf::open_print_window,
            pdf::save_pdf,
            commands::load_bundle_state,
            commands::save_bundle_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
