//! Self-update over `tauri-plugin-updater`.
//!
//! On launch the desktop app asks the GitHub release feed (the `latest.json`
//! endpoint in `tauri.conf.json`) whether a newer version exists. If one does,
//! the signed installer is downloaded in the background and applied so that the
//! NEXT launch runs the new version: the running session is never interrupted.
//! Once the update is in place (or, on Windows, queued for exit) the frontend
//! gets an [`UpdateNotice`] it shows as a dismissible message; the next launch
//! then shows the release notes (`release_notes.rs`). Failures (offline,
//! rate-limited, unwritable install location) go to stderr and are otherwise
//! ignored; the next launch simply tries again.
//!
//! Applying differs per platform:
//! - AppImage / macOS `.app`: the plugin swaps the file or bundle on disk, which
//!   the running process does not need, so it installs as soon as the download
//!   finishes.
//! - Windows (NSIS/MSI): the plugin starts the installer and `exit(0)`s the
//!   process, so the downloaded bytes wait for `RunEvent::Exit`
//!   ([`install_pending`]).
//! - `.deb` / `.rpm`: the plugin would need `pkexec`, so nothing is installed.
//!   The app only reports that a newer version exists, with a link to its
//!   release page.
//!
//! An unbundled binary (`install-local.sh`, `cargo run`), a debug build and any
//! run with [`OPT_OUT_ENV`] set do not check at all.

use std::sync::Mutex;

use tauri::utils::config::BundleType;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Set (to anything) to skip the update check for this run.
pub const OPT_OUT_ENV: &str = "SUNSTONE_NO_UPDATE";

/// Event carrying an [`UpdateNotice`] to the frontend.
pub const UPDATE_NOTICE_EVENT: &str = "update-notice";

/// Where a version's installers and notes are published.
const RELEASE_PAGE: &str = "https://github.com/pothos-dev/sunstone/releases/tag/v";

/// What the user is told about a newer version. Matches the TS `UpdateNotice`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotice {
    pub kind: NoticeKind,
    pub version: String,
    /// The version's GitHub release page.
    pub url: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoticeKind {
    /// Installed; the next launch runs it.
    Installed,
    /// Downloaded; it installs when Sunstone closes (Windows).
    InstallsOnExit,
    /// Not installed here (`.deb`/`.rpm`); download it from the release page.
    Available,
}

/// The notice for this run, kept for a frontend that subscribes after it fired.
#[derive(Default)]
pub struct CurrentNotice(pub Mutex<Option<UpdateNotice>>);

/// A downloaded update waiting for the process to exit (Windows only).
#[derive(Default)]
struct PendingInstall(Mutex<Option<(Update, Vec<u8>)>>);

/// What this process does about updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Download and install.
    Install,
    /// Only report a newer version.
    Notify,
}

/// How this process handles updates, or `None` to skip the check.
fn mode(
    bundle: Option<BundleType>,
    exe_in_app_bundle: bool,
    debug: bool,
    opted_out: bool,
) -> Option<Mode> {
    if debug || opted_out {
        return None;
    }
    match bundle {
        Some(BundleType::AppImage | BundleType::Msi | BundleType::Nsis) => Some(Mode::Install),
        // `bundle_type()` reports `App` for ANY macOS binary; only trust it when
        // the executable really sits inside a `.app`.
        Some(BundleType::App) if exe_in_app_bundle => Some(Mode::Install),
        Some(BundleType::Deb | BundleType::Rpm) => Some(Mode::Notify),
        _ => None,
    }
}

fn exe_in_app_bundle() -> bool {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

/// Start the background check. Call once from `setup`.
pub fn spawn_check(app: &AppHandle) {
    app.manage(PendingInstall::default());
    app.manage(CurrentNotice::default());
    let Some(mode) = mode(
        tauri::utils::platform::bundle_type(),
        exe_in_app_bundle(),
        cfg!(debug_assertions),
        std::env::var_os(OPT_OUT_ENV).is_some(),
    ) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match fetch_update(&app, mode).await {
            Ok(Some(notice)) => announce(&app, notice),
            Ok(None) => {}
            Err(e) => eprintln!("update check failed: {e}"),
        }
    });
}

async fn fetch_update(
    app: &AppHandle,
    mode: Mode,
) -> tauri_plugin_updater::Result<Option<UpdateNotice>> {
    let updater = app
        .updater_builder()
        // The user closed Sunstone; the installer must not reopen it.
        .restart_after_install(false)
        .build()?;
    let Some(update) = updater.check().await? else {
        return Ok(None);
    };
    let notice = |kind| UpdateNotice {
        kind,
        url: format!("{RELEASE_PAGE}{}", update.version),
        version: update.version.clone(),
    };
    if mode == Mode::Notify {
        return Ok(Some(notice(NoticeKind::Available)));
    }
    let bytes = update.download(|_, _| {}, || {}).await?;
    if cfg!(windows) {
        let notice = notice(NoticeKind::InstallsOnExit);
        *app.state::<PendingInstall>().0.lock().unwrap() = Some((update, bytes));
        Ok(Some(notice))
    } else {
        update.install(bytes)?;
        eprintln!("Sunstone {} installed; it runs from the next launch", update.version);
        Ok(Some(notice(NoticeKind::Installed)))
    }
}

/// Keep `notice` for a late subscriber and tell any listening frontend now.
fn announce(app: &AppHandle, notice: UpdateNotice) {
    *app.state::<CurrentNotice>().0.lock().unwrap() = Some(notice.clone());
    let _ = app.emit(UPDATE_NOTICE_EVENT, notice);
}

/// Run a downloaded-but-deferred installer. Call on `RunEvent::Exit`.
pub fn install_pending(app: &AppHandle) {
    let Some(pending) = app.try_state::<PendingInstall>() else {
        return;
    };
    let Some((update, bytes)) = pending.0.lock().unwrap().take() else {
        return;
    };
    if let Err(e) = update.install(bytes) {
        eprintln!("failed to install Sunstone {}: {e}", update.version);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_into_the_bundles_it_can_replace() {
        for b in [BundleType::AppImage, BundleType::Msi, BundleType::Nsis] {
            assert_eq!(mode(Some(b), false, false, false), Some(Mode::Install));
        }
        assert_eq!(mode(Some(BundleType::App), true, false, false), Some(Mode::Install));
    }

    #[test]
    fn package_managed_installs_are_only_notified() {
        assert_eq!(mode(Some(BundleType::Deb), false, false, false), Some(Mode::Notify));
        assert_eq!(mode(Some(BundleType::Rpm), false, false, false), Some(Mode::Notify));
    }

    #[test]
    fn unbundled_binaries_are_left_alone() {
        assert_eq!(mode(None, false, false, false), None);
        // A bare macOS binary outside any `.app`.
        assert_eq!(mode(Some(BundleType::App), false, false, false), None);
    }

    #[test]
    fn debug_builds_and_the_opt_out_skip_the_check() {
        assert_eq!(mode(Some(BundleType::AppImage), false, true, false), None);
        assert_eq!(mode(Some(BundleType::Deb), false, false, true), None);
    }

    #[test]
    fn the_notice_serialises_as_the_frontend_reads_it() {
        let notice = UpdateNotice {
            kind: NoticeKind::InstallsOnExit,
            version: "1.2.3".into(),
            url: format!("{RELEASE_PAGE}1.2.3"),
        };
        assert_eq!(
            serde_json::to_value(&notice).unwrap(),
            serde_json::json!({
                "kind": "installsOnExit",
                "version": "1.2.3",
                "url": "https://github.com/pothos-dev/sunstone/releases/tag/v1.2.3",
            })
        );
    }
}
