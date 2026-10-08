//! The user's **appearance** config: the `colors` and `fonts` values of a
//! hand-written `config.json`, plus the font files it names.
//!
//! One file format, two places it lives: the desktop reads
//! `~/.config/sunstone/config.json` ([`crate::config::user_config_file`]),
//! Sunstone Web reads the file `SUNSTONE_CONFIG` points at. Both hand the
//! frontend the same opaque JSON; `src/lib/state/appearance.ts` owns the key
//! list and validates every value, so Rust never interprets a colour or a
//! family name.
//!
//! ## Font files
//!
//! A font role may list files next to the config (`"files": ["Inter.woff2"]` or
//! `[{ "src": "fonts/Inter-Bold.woff2", "weight": "700" }]`). [`font_file`]
//! serves one, and it is deliberately narrow — the config dir also holds
//! `state.json`, and on the web it is a mounted volume:
//!
//! - the name must be **listed** under some `fonts.<role>.files` of the config
//!   as it is right now,
//! - its extension must be a font one (`woff2`, `woff`, `ttf`, `otf`),
//! - and it must resolve **inside** the config's directory ([`bundle::resolve`],
//!   the confinement primitive every Attachment read uses — `..`, absolute
//!   paths and symlink escapes are refused).

use std::path::Path;

use serde_json::{Map, Value};

use crate::bundle;

/// The `colors` and `fonts` values of the config at `path`, verbatim, as
/// `{ "colors"?: …, "fonts"?: … }` — or `None` when the file is missing, sets
/// neither, or is not valid JSON (a warning is logged; the file is left alone).
pub fn load(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let appearance = from_config(&text);
    if appearance.is_err() {
        eprintln!("sunstone: ignoring {}: not valid JSON", path.display());
    }
    appearance.ok().flatten()
}

/// The appearance part of a `config.json` document; `Err` when it does not
/// parse, `Ok(None)` when it sets no (non-null) `colors` or `fonts`.
fn from_config(text: &str) -> Result<Option<Value>, serde_json::Error> {
    let mut config: Value = serde_json::from_str(text)?;
    let mut out = Map::new();
    for key in ["colors", "fonts"] {
        if let Some(value) = config.get_mut(key).map(Value::take).filter(|v| !v.is_null()) {
            out.insert(key.to_string(), value);
        }
    }
    Ok((!out.is_empty()).then_some(Value::Object(out)))
}

/// The `Content-Type` of a font file, by extension; `None` for anything that is
/// not a font (which [`font_file`] then refuses to serve).
pub fn font_content_type(file: &str) -> Option<&'static str> {
    let ext = file
        .rsplit_once('.')
        .filter(|(_, ext)| !ext.contains('/'))
        .map(|(_, ext)| ext.to_ascii_lowercase())?;
    match ext.as_str() {
        "woff2" => Some("font/woff2"),
        "woff" => Some("font/woff"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        _ => None,
    }
}

/// Why [`font_file`] refused a request.
#[derive(Debug, PartialEq, Eq)]
pub enum FontError {
    /// The name escapes the config directory.
    Forbidden(String),
    /// Not listed in the config, not a font, or not readable.
    NotFound(String),
}

/// The bytes and `Content-Type` of the font file `file`, named relative to the
/// directory of the config at `config_path`. See the module docs for the three
/// conditions it must meet.
pub fn font_file(config_path: &Path, file: &str) -> Result<(Vec<u8>, &'static str), FontError> {
    let not_found = || FontError::NotFound(format!("{file}: not a configured font file"));
    let content_type = font_content_type(file).ok_or_else(not_found)?;
    let listed = load(config_path)
        .and_then(|a| a.get("fonts").cloned())
        .is_some_and(|fonts| listed_files(&fonts).any(|f| f == file));
    if !listed {
        return Err(not_found());
    }
    let dir = config_path
        .parent()
        .and_then(|d| d.canonicalize().ok())
        .ok_or_else(not_found)?;
    let resolved = bundle::resolve(&dir, file).map_err(|msg| {
        if msg.contains("escapes the bundle") || msg.contains("must be bundle-relative") {
            FontError::Forbidden(msg)
        } else {
            FontError::NotFound(msg)
        }
    })?;
    let bytes = std::fs::read(&resolved).map_err(|e| FontError::NotFound(format!("{file}: {e}")))?;
    Ok((bytes, content_type))
}

/// Every file name under any `fonts.<role>.files` — a string, or an object's
/// `src`. Malformed entries are skipped, as the frontend skips them.
fn listed_files(fonts: &Value) -> impl Iterator<Item = &str> {
    fonts
        .as_object()
        .into_iter()
        .flat_map(|roles| roles.values())
        .filter_map(|role| role.get("files")?.as_array())
        .flatten()
        .filter_map(|entry| entry.as_str().or_else(|| entry.get("src")?.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A throwaway config dir holding `config.json` (with `text`) and two fonts.
    fn temp_config(text: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sunstone-appearance-{}-{n}", std::process::id()));
        std::fs::create_dir_all(dir.join("fonts")).unwrap();
        std::fs::write(dir.join("Inter.woff2"), b"wOF2-inter").unwrap();
        std::fs::write(dir.join("fonts/Mono.ttf"), b"ttf-mono").unwrap();
        std::fs::write(dir.join("state.json"), b"{}").unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, text).unwrap();
        path
    }

    const FONTS: &str = r#"{ "fonts": {
        "ui": { "family": "Inter", "files": ["Inter.woff2"] },
        "code": { "files": [{ "src": "fonts/Mono.ttf", "weight": "400" }, 3, { "weight": "7" }] }
    } }"#;

    #[test]
    fn colors_and_fonts_come_verbatim_from_the_config() {
        let text = r##"{ "colors": { "light": { "accent": "#123456", "typo": 1 } },
                         "fonts": { "ui": { "size": 15 } }, "other": true }"##;
        let a = from_config(text).unwrap().unwrap();
        assert_eq!(a["colors"]["light"]["accent"], "#123456");
        assert_eq!(a["colors"]["light"]["typo"], 1);
        assert_eq!(a["fonts"]["ui"]["size"], 15);
        assert!(a.get("other").is_none());
    }

    #[test]
    fn a_config_without_appearance_is_none_and_bad_json_an_error() {
        assert!(from_config("{}").unwrap().is_none());
        assert!(from_config(r#"{ "colors": null, "fonts": null }"#).unwrap().is_none());
        assert!(from_config("{ \"colors\": ").is_err());
        let only_fonts = from_config(r#"{ "fonts": {} }"#).unwrap().unwrap();
        assert!(only_fonts.get("colors").is_none());
    }

    #[test]
    fn a_missing_config_loads_as_none() {
        assert!(load(Path::new("/nonexistent/sunstone/config.json")).is_none());
    }

    #[test]
    fn font_content_types_by_extension() {
        assert_eq!(font_content_type("a.woff2"), Some("font/woff2"));
        assert_eq!(font_content_type("A.WOFF"), Some("font/woff"));
        assert_eq!(font_content_type("x/a.ttf"), Some("font/ttf"));
        assert_eq!(font_content_type("a.otf"), Some("font/otf"));
        assert_eq!(font_content_type("state.json"), None);
        assert_eq!(font_content_type("fonts.d/woff2"), None);
        assert_eq!(font_content_type("noext"), None);
    }

    #[test]
    fn a_listed_font_is_served_with_its_content_type() {
        let config = temp_config(FONTS);
        assert_eq!(font_file(&config, "Inter.woff2"), Ok((b"wOF2-inter".to_vec(), "font/woff2")));
        assert_eq!(font_file(&config, "fonts/Mono.ttf"), Ok((b"ttf-mono".to_vec(), "font/ttf")));
    }

    #[test]
    fn an_unlisted_or_non_font_file_is_not_found() {
        let config = temp_config(FONTS);
        std::fs::write(config.with_file_name("Other.woff2"), b"x").unwrap();
        assert!(matches!(font_file(&config, "Other.woff2"), Err(FontError::NotFound(_))));
        assert!(matches!(font_file(&config, "state.json"), Err(FontError::NotFound(_))));
        assert!(matches!(font_file(&config, "config.json"), Err(FontError::NotFound(_))));
    }

    #[test]
    fn a_listed_but_missing_file_is_not_found() {
        let config = temp_config(r#"{ "fonts": { "ui": { "files": ["Gone.woff2"] } } }"#);
        assert!(matches!(font_file(&config, "Gone.woff2"), Err(FontError::NotFound(_))));
    }

    #[test]
    fn a_listed_file_outside_the_config_dir_is_forbidden() {
        // Listing it is not enough: the file must also live under the config dir.
        let config = temp_config(
            r#"{ "fonts": { "ui": { "files": ["../escape.woff2", "/etc/x.ttf"] } } }"#,
        );
        let outside = config.parent().unwrap().parent().unwrap().join("escape.woff2");
        std::fs::write(&outside, b"outside").unwrap();
        assert!(matches!(font_file(&config, "../escape.woff2"), Err(FontError::Forbidden(_))));
        assert!(matches!(font_file(&config, "/etc/x.ttf"), Err(FontError::Forbidden(_))));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_escaping_the_config_dir_is_forbidden() {
        let config = temp_config(r#"{ "fonts": { "ui": { "files": ["link/secret.woff2"] } } }"#);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let outside = std::env::temp_dir().join(format!("sunstone-appearance-out-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.woff2"), b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, config.with_file_name("link")).unwrap();
        assert!(matches!(font_file(&config, "link/secret.woff2"), Err(FontError::Forbidden(_))));
    }
}
