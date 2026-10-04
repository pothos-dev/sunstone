//! Silent self-update over `tauri-plugin-updater`.
//!
//! On launch the desktop app asks the GitHub release feed (the `latest.json`
//! endpoint in `tauri.conf.json`) whether a newer version exists. If one does,
//! the signed installer is downloaded in the background and applied so that the
//! NEXT launch runs the new version: the running session is never interrupted
//! and nothing shows in the UI. Failures (offline, rate-limited, unwritable
//! install location) go to stderr and are otherwise ignored; the next launch
//! simply tries again.
//!
//! Applying differs per platform:
//! - AppImage / macOS `.app`: the plugin swaps the file or bundle on disk, which
//!   the running process does not need, so it installs as soon as the download
//!   finishes.
//! - Windows (NSIS/MSI): the plugin starts the installer and `exit(0)`s the
//!   process, so the downloaded bytes wait for `RunEvent::Exit`
//!   ([`install_pending`]).
//!
//! Only installs the updater can replace without a password prompt are
//! checked: a `.deb`/`.rpm` (the plugin would `pkexec`) and an unbundled binary
//! (`install-local.sh`, `cargo run`) are left alone, as are debug builds and any
//! run with [`OPT_OUT_ENV`] set.

use std::sync::Mutex;

use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Set (to anything) to skip the update check for this run.
pub const OPT_OUT_ENV: &str = "SUNSTONE_NO_UPDATE";

/// A downloaded update waiting for the process to exit (Windows only).
#[derive(Default)]
struct PendingInstall(Mutex<Option<(Update, Vec<u8>)>>);

/// Whether this process should look for an update at all.
fn should_check(
    bundle: Option<BundleType>,
    exe_in_app_bundle: bool,
    debug: bool,
    opted_out: bool,
) -> bool {
    if debug || opted_out {
        return false;
    }
    match bundle {
        Some(BundleType::AppImage | BundleType::Msi | BundleType::Nsis) => true,
        // `bundle_type()` reports `App` for ANY macOS binary; only trust it when
        // the executable really sits inside a `.app`.
        Some(BundleType::App) => exe_in_app_bundle,
        _ => false,
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
    if !should_check(
        tauri::utils::platform::bundle_type(),
        exe_in_app_bundle(),
        cfg!(debug_assertions),
        std::env::var_os(OPT_OUT_ENV).is_some(),
    ) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = fetch_update(&app).await {
            eprintln!("update check failed: {e}");
        }
    });
}

async fn fetch_update(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    let updater = app
        .updater_builder()
        // The user closed Sunstone; the installer must not reopen it.
        .restart_after_install(false)
        .build()?;
    let Some(update) = updater.check().await? else {
        return Ok(());
    };
    let bytes = update.download(|_, _| {}, || {}).await?;
    if cfg!(windows) {
        *app.state::<PendingInstall>().0.lock().unwrap() = Some((update, bytes));
    } else {
        update.install(bytes)?;
        eprintln!("Sunstone {} installed; it runs from the next launch", update.version);
    }
    Ok(())
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
    fn checks_the_bundles_it_can_replace() {
        for b in [BundleType::AppImage, BundleType::Msi, BundleType::Nsis] {
            assert!(should_check(Some(b), false, false, false));
        }
        assert!(should_check(Some(BundleType::App), true, false, false));
    }

    #[test]
    fn leaves_package_managed_and_unbundled_installs_alone() {
        assert!(!should_check(Some(BundleType::Deb), false, false, false));
        assert!(!should_check(Some(BundleType::Rpm), false, false, false));
        assert!(!should_check(None, false, false, false));
        // A bare macOS binary outside any `.app`.
        assert!(!should_check(Some(BundleType::App), false, false, false));
    }

    #[test]
    fn debug_builds_and_the_opt_out_skip_the_check() {
        assert!(!should_check(Some(BundleType::AppImage), false, true, false));
        assert!(!should_check(Some(BundleType::AppImage), false, false, true));
    }
}
