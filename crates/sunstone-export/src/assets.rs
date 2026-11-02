//! The export's output folder and its shared `_sunstone/` assets: one
//! stylesheet (the app's design tokens, the rendered-body styles, the export
//! chrome and the Jost font), one optional script, and the font files.

use std::path::{Path, PathBuf};

/// The folder of shared assets, beside the pages.
const ASSET_DIR: &str = "_sunstone";
/// Marks a folder as an export, so a later export may replace it.
const MARKER: &str = "_sunstone/.sunstone-export";

const APP_CSS: &str = include_str!("../../../src/app.css");
const RENDERED_CSS: &str = include_str!("../../../src/lib/rendered.css");
const EXPORT_CSS: &str = include_str!("../assets/export.css");
const EXPORT_JS: &str = include_str!("../assets/export.js");

const FONTS: &[(&str, &[u8])] = &[
    ("jost-latin-wght-normal.woff2", include_bytes!("../assets/fonts/jost-latin-wght-normal.woff2")),
    ("jost-latin-wght-italic.woff2", include_bytes!("../assets/fonts/jost-latin-wght-italic.woff2")),
    ("jost-latin-ext-wght-normal.woff2", include_bytes!("../assets/fonts/jost-latin-ext-wght-normal.woff2")),
    ("jost-latin-ext-wght-italic.woff2", include_bytes!("../assets/fonts/jost-latin-ext-wght-italic.woff2")),
    ("OFL.txt", include_bytes!("../assets/fonts/OFL.txt")),
];

/// Make `out` ready to receive an export of the Bundle at `root` (canonical)
/// and return it canonicalized. A missing folder is created, an earlier export
/// is emptied; anything else non-empty is refused, as is a folder overlapping
/// the Bundle (the export would land in the Bundle, or the Bundle be wiped).
pub fn prepare_out(root: &Path, out: &Path) -> Result<PathBuf, String> {
    if out.exists() && !out.is_dir() {
        return Err(format!("not a folder: {}", out.display()));
    }
    let existed = out.exists();
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let canonical = out.canonicalize().map_err(|e| format!("{}: {e}", out.display()))?;
    if canonical.starts_with(root) || root.starts_with(&canonical) {
        if !existed {
            let _ = std::fs::remove_dir(&canonical);
        }
        return Err(format!(
            "the output folder {} overlaps the Bundle {}; export somewhere outside it",
            out.display(),
            root.display()
        ));
    }
    let mut entries = std::fs::read_dir(&canonical).map_err(|e| format!("{}: {e}", out.display()))?.peekable();
    if entries.peek().is_some() {
        if !canonical.join(MARKER).is_file() {
            return Err(format!(
                "{} is not empty and holds no earlier export; pick an empty or new folder",
                out.display()
            ));
        }
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            let removed = if path.is_dir() && !path.is_symlink() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            removed.map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    Ok(canonical)
}

/// Write `_sunstone/` into `out`.
pub fn write_assets(out: &Path) -> Result<(), String> {
    let dir = out.join(ASSET_DIR);
    let fonts = dir.join("fonts");
    std::fs::create_dir_all(&fonts).map_err(|e| format!("{}: {e}", fonts.display()))?;
    let css = [EXPORT_CSS_HEADER, APP_CSS, RENDERED_CSS, EXPORT_CSS].join("\n");
    let files: [(PathBuf, &[u8]); 3] = [
        (dir.join("sunstone.css"), css.as_bytes()),
        (dir.join("sunstone.js"), EXPORT_JS.as_bytes()),
        (out.join(MARKER), concat!("sunstone-export ", env!("CARGO_PKG_VERSION"), "\n").as_bytes()),
    ];
    for (path, bytes) in files {
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    for (name, bytes) in FONTS {
        let path = fonts.join(name);
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

/// The `@font-face` rules for the vendored Jost (`@fontsource-variable/jost`,
/// SIL OFL 1.1), latin and latin-ext; other scripts fall back to the system font.
const EXPORT_CSS_HEADER: &str = "\
/* Sunstone export stylesheet: the app's design tokens (src/app.css), the
   rendered-body styles (src/lib/rendered.css) and the export chrome. */
@font-face {
  font-family: 'Jost Variable';
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url(fonts/jost-latin-ext-wght-normal.woff2) format('woff2-variations');
  unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
}
@font-face {
  font-family: 'Jost Variable';
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url(fonts/jost-latin-wght-normal.woff2) format('woff2-variations');
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
@font-face {
  font-family: 'Jost Variable';
  font-style: italic;
  font-display: swap;
  font-weight: 100 900;
  src: url(fonts/jost-latin-ext-wght-italic.woff2) format('woff2-variations');
  unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
}
@font-face {
  font-family: 'Jost Variable';
  font-style: italic;
  font-display: swap;
  font-weight: 100 900;
  src: url(fonts/jost-latin-wght-italic.woff2) format('woff2-variations');
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
";
