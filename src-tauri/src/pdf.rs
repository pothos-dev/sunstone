//! The desktop print/PDF path: the chrome-free print window plus the direct
//! (dialog-free) PDF export, with one `export_webview_pdf` implementation per
//! platform webview API.

use sunstone_shared::url::query_encode;
use tauri::Manager;

/// Open a chrome-free print/PDF preview of the Concept at `path` in a SEPARATE
/// native window (WebKitGTK has no rich PDF chrome of its own, so the preview
/// carries its own reader controls). The window loads the same SPA shell with
/// `?print=<path>&toolbar=1`, which the root route resolves to `PrintView`.
/// If a print window is already open it is reused (navigated + focused).
#[tauri::command]
pub(crate) fn open_print_window(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let query = format!("?print={}&toolbar=1", query_encode(&path));
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
pub(crate) async fn save_pdf(
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
