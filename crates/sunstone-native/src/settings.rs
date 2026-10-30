//! The settings page's access to the user's `config.json`: read the whole
//! file, and write back ONLY the leaves the user changed.
//!
//! The file is the user's: they may have written keys Sunstone does not know,
//! a `$comment`, or font `files` next to a `family` the page edits. So a save
//! is a list of [`ConfigEdit`]s applied to the file as it is on disk right now
//! — every other key, value and the key order survive (serde_json's
//! `preserve_order` feature keeps object order). The frontend mirrors the
//! apply in `src/lib/settings/configEdits.ts` (preview and the `fake`
//! backend); both pin the same cases in their tests.
//!
//! Safety rails:
//! - only the settings keys ([`SETTINGS_KEYS`]) may be edited, and a batch
//!   with any bad path is refused whole;
//! - a file that exists but is not a JSON object is never overwritten;
//! - the write is atomic (temp file in the same directory, then rename).

use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value};

/// The top-level keys the settings page may write. Mirrors `SETTINGS_KEYS` in
/// `src/lib/settings/configEdits.ts`.
pub const SETTINGS_KEYS: &[&str] = &["theme", "colorTheme", "colors", "fonts", "defaults", "keybindings"];

/// One change: set the value at `path`, or remove it when `value` is absent.
/// `"value": null` is a value (an unbound keybinding), not a removal.
#[derive(Debug, Clone, Deserialize)]
pub struct ConfigEdit {
    pub path: Vec<String>,
    #[serde(default, deserialize_with = "present")]
    pub value: Option<Value>,
}

/// A present `value` (including `null`) is `Some`; only an absent one is `None`.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// The whole `config.json` at `path` as a JSON object, or `None` when it is
/// missing, unreadable, or not a JSON object.
pub fn load_config(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&text) {
        Ok(v @ Value::Object(_)) => Some(v),
        _ => {
            eprintln!("sunstone: ignoring {}: not a JSON object", path.display());
            None
        }
    }
}

/// Apply `edits` to the `config.json` at `path` and write it back. A missing
/// file starts from `{}`.
pub fn save_config_edits(path: &Path, edits: &[ConfigEdit]) -> Result<(), String> {
    let current = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let next = apply_to_text(current.as_deref(), edits)?;
    write_atomic(path, &next)
}

/// The new file text: `current` (`None` = no file yet) with `edits` applied,
/// pretty-printed with two-space indent and a trailing newline.
pub fn apply_to_text(current: Option<&str>, edits: &[ConfigEdit]) -> Result<String, String> {
    validate(edits)?;
    let mut root = match current {
        None => Map::new(),
        Some(text) if text.trim().is_empty() => Map::new(),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            Ok(_) => return Err("config.json is not a JSON object; fix it by hand first".into()),
            Err(e) => return Err(format!("config.json is not valid JSON ({e}); fix it by hand first")),
        },
    };
    apply_edits(&mut root, edits);
    let mut out = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Refuse the batch when any path is empty, has an empty segment, or starts
/// outside [`SETTINGS_KEYS`].
fn validate(edits: &[ConfigEdit]) -> Result<(), String> {
    for edit in edits {
        let ok = matches!(edit.path.first(), Some(k) if SETTINGS_KEYS.contains(&k.as_str()))
            && edit.path.iter().all(|s| !s.is_empty());
        if !ok {
            return Err(format!("not a settings path: {:?}", edit.path));
        }
    }
    Ok(())
}

/// Apply `edits` in order. A set creates missing parents (replacing a
/// non-object in the way); a removal deletes the leaf and then every parent
/// object the removal left empty.
pub fn apply_edits(root: &mut Map<String, Value>, edits: &[ConfigEdit]) {
    for edit in edits {
        let Some((last, parents)) = edit.path.split_last() else { continue };
        match &edit.value {
            Some(value) => {
                let mut cur = &mut *root;
                for key in parents {
                    let slot = cur.entry(key.clone()).or_insert_with(|| Value::Object(Map::new()));
                    if !slot.is_object() {
                        *slot = Value::Object(Map::new());
                    }
                    cur = slot.as_object_mut().expect("just made an object");
                }
                cur.insert(last.clone(), value.clone());
            }
            None => {
                remove(root, parents, last);
            }
        }
    }
}

/// Remove `parents/last`; returns whether `map` is now empty because of it, so
/// the caller prunes it. Only objects the removal emptied are pruned.
fn remove(map: &mut Map<String, Value>, parents: &[String], last: &str) -> bool {
    match parents.split_first() {
        None => map.shift_remove(last).is_some() && map.is_empty(),
        Some((head, rest)) => {
            let Some(Value::Object(child)) = map.get_mut(head) else { return false };
            if remove(child, rest, last) {
                map.shift_remove(head);
                return map.is_empty();
            }
            false
        }
    }
}

/// Replace the file at `path` with `text` via a temp file and a rename, so a
/// crash never leaves half a config. A symlinked config.json (dotfile managers
/// link it) is written through: the rename targets the link's real file, so
/// the link survives. The file keeps its permissions.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let target = match std::fs::canonicalize(path) {
        Ok(real) => real,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => path.to_path_buf(),
        Err(e) => return Err(format!("could not resolve {}: {e}", path.display())),
    };
    let dir = target.parent().ok_or("config path has no directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".config.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace {}: {e}", target.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn set(path: &[&str], value: Value) -> ConfigEdit {
        ConfigEdit { path: path.iter().map(|s| s.to_string()).collect(), value: Some(value) }
    }
    fn unset(path: &[&str]) -> ConfigEdit {
        ConfigEdit { path: path.iter().map(|s| s.to_string()).collect(), value: None }
    }

    const HAND_WRITTEN: &str = r##"{
  "$comment": "mine",
  "fonts": { "code": { "family": "JetBrains Mono", "files": ["JBM.woff2"] } },
  "colors": { "dark": { "accent": "#5aa2f0" } },
  "x-tool": { "z": 1, "a": 2 }
}"##;

    fn keys(v: &Value) -> Vec<String> {
        v.as_object().unwrap().keys().cloned().collect()
    }

    #[test]
    fn unrelated_keys_and_their_order_survive() {
        let out = apply_to_text(Some(HAND_WRITTEN), &[set(&["theme"], json!("dark"))]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(keys(&v), ["$comment", "fonts", "colors", "x-tool", "theme"]);
        assert_eq!(keys(&v["x-tool"]), ["z", "a"]);
        assert_eq!(v["$comment"], "mine");
        assert!(out.ends_with("}\n"));
        assert!(out.contains("\n  \"theme\": \"dark\""), "two-space indent: {out}");
    }

    #[test]
    fn editing_a_family_keeps_its_font_files() {
        let out = apply_to_text(Some(HAND_WRITTEN), &[set(&["fonts", "code", "family"], json!("Fira Code"))]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["fonts"]["code"], json!({ "family": "Fira Code", "files": ["JBM.woff2"] }));
    }

    #[test]
    fn a_removal_prunes_only_the_objects_it_emptied() {
        let out = apply_to_text(Some(HAND_WRITTEN), &[unset(&["colors", "dark", "accent"])]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("colors").is_none());
        // Removing family leaves the files, so `fonts.code` stays.
        let out = apply_to_text(Some(HAND_WRITTEN), &[unset(&["fonts", "code", "family"])]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["fonts"]["code"], json!({ "files": ["JBM.woff2"] }));
        // An object that was already empty is not the removal's to prune.
        let mut root = json!({ "defaults": {}, "keybindings": { "bold": "Mod-b" } }).as_object().unwrap().clone();
        apply_edits(&mut root, &[unset(&["keybindings", "bold"]), unset(&["defaults", "tags"])]);
        assert_eq!(Value::Object(root), json!({ "defaults": {} }));
    }

    #[test]
    fn a_set_creates_parents_and_replaces_a_non_object() {
        let out = apply_to_text(Some(r#"{ "fonts": 3 }"#), &[set(&["fonts", "ui", "size"], json!(15))]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v, json!({ "fonts": { "ui": { "size": 15 } } }));
    }

    #[test]
    fn null_is_a_value_not_a_removal() {
        let out = apply_to_text(None, &[set(&["keybindings", "paragraph"], Value::Null)]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v, json!({ "keybindings": { "paragraph": null } }));
    }

    #[test]
    fn removing_something_absent_is_a_no_op() {
        let out = apply_to_text(Some(HAND_WRITTEN), &[unset(&["defaults", "tags"]), unset(&["theme"])]).unwrap();
        let before: Value = serde_json::from_str(HAND_WRITTEN).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), before);
    }

    #[test]
    fn an_invalid_or_non_object_file_is_refused() {
        assert!(apply_to_text(Some("{ \"fonts\": "), &[set(&["theme"], json!("dark"))]).is_err());
        assert!(apply_to_text(Some("[1, 2]"), &[set(&["theme"], json!("dark"))]).is_err());
        assert!(apply_to_text(Some("  \n"), &[set(&["theme"], json!("dark"))]).is_ok());
    }

    #[test]
    fn bad_paths_refuse_the_whole_batch() {
        for bad in [
            unset(&[]),
            set(&["x-tool", "z"], json!(0)),
            set(&["fonts", "", "size"], json!(1)),
            set(&["$comment"], json!("gone")),
        ] {
            let err = apply_to_text(Some(HAND_WRITTEN), &[set(&["theme"], json!("dark")), bad]);
            assert!(err.is_err());
        }
    }

    #[test]
    fn edits_deserialise_with_value_optional() {
        let edits: Vec<ConfigEdit> =
            serde_json::from_str(r#"[{ "path": ["theme"], "value": "dark" }, { "path": ["colorTheme"] },
                                      { "path": ["keybindings", "bold"], "value": null }]"#).unwrap();
        assert_eq!(edits[0].value, Some(json!("dark")));
        assert_eq!(edits[1].value, None);
        assert_eq!(edits[2].value, Some(Value::Null));
    }

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("sunstone-settings-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_creates_a_missing_file_and_updates_an_existing_one() {
        let dir = temp_dir();
        let path = dir.join("sub").join("config.json");
        save_config_edits(&path, &[set(&["theme"], json!("light"))]).unwrap();
        assert_eq!(load_config(&path), Some(json!({ "theme": "light" })));
        save_config_edits(&path, &[set(&["colorTheme"], json!("nord")), unset(&["theme"])]).unwrap();
        assert_eq!(load_config(&path), Some(json!({ "colorTheme": "nord" })));
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1, "no temp file left behind");
    }

    #[test]
    fn save_never_overwrites_an_invalid_file() {
        let dir = temp_dir();
        let path = dir.join("config.json");
        std::fs::write(&path, "{ broken").unwrap();
        assert!(save_config_edits(&path, &[set(&["theme"], json!("dark"))]).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
        assert_eq!(load_config(&path), None);
    }

    #[test]
    fn load_is_none_for_missing_or_non_object() {
        let dir = temp_dir();
        assert_eq!(load_config(&dir.join("nope.json")), None);
        let path = dir.join("config.json");
        std::fs::write(&path, "[]").unwrap();
        assert_eq!(load_config(&path), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_config_is_written_through_and_keeps_its_mode() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("sunstone-settings-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("dotfiles")).unwrap();
        let real = dir.join("dotfiles/config.json");
        std::fs::write(&real, "{ \"x\": 1 }").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("config.json");
        symlink(&real, &link).unwrap();

        save_config_edits(&link, &[set(&["theme"], json!("dark"))]).unwrap();

        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&real).unwrap()).unwrap();
        assert_eq!(written, json!({ "x": 1, "theme": "dark" }));
        assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
