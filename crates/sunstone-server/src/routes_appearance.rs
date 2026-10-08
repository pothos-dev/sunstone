//! The user's **appearance** config over HTTP: `GET /_api/appearance` (the
//! `colors` + `fonts` JSON) and `GET /_api/appearance/font?file=<name>` (one of
//! the font files it lists).
//!
//! The config is `SUNSTONE_CONFIG` on Sunstone Web and the user's desktop
//! `config.json` under `sunstone serve` ([`crate::config::Config`]'s
//! `appearance_config`). It is read on every request, so editing it shows on
//! the next page load; no file, no variable or invalid JSON all answer `null`
//! and the frontend keeps its defaults. Both routes are unauthenticated: the
//! look of a wiki is as public as its pages.
//!
//! What a font request may read is [`appearance::font_file`]'s decision
//! (listed in the config, a font extension, inside the config's directory),
//! shared with the desktop's `sunstone-font://` scheme. [`guard_rel_path`]
//! runs first, as on every path-taking route.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{
        header::{CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS},
        StatusCode,
    },
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use sunstone_native::appearance::{self, FontError};

use crate::api_error::{guard_rel_path, ApiError};
use crate::ServerState;

/// `GET /_api/appearance` → `{ colors?, fonts? }` verbatim, or `null`.
pub(crate) async fn appearance_handler(
    State(state): State<Arc<ServerState>>,
) -> Json<Option<serde_json::Value>> {
    Json(state.cfg.appearance_config.as_deref().and_then(appearance::load))
}

#[derive(Deserialize)]
pub(crate) struct FontQuery {
    /// The file as the config lists it, relative to the config's directory.
    pub(crate) file: String,
}

/// `GET /_api/appearance/font?file=<name>` → the font's bytes.
pub(crate) async fn font_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<FontQuery>,
) -> Result<Response, ApiError> {
    guard_rel_path(&q.file)?;
    let config = state
        .cfg
        .appearance_config
        .as_deref()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "no appearance config".to_string()))?;
    let (bytes, content_type) = appearance::font_file(config, &q.file).map_err(|e| match e {
        FontError::Forbidden(msg) => ApiError(StatusCode::BAD_REQUEST, msg),
        FontError::NotFound(msg) => ApiError(StatusCode::NOT_FOUND, msg),
    })?;
    Ok(([(CONTENT_TYPE, content_type), (X_CONTENT_TYPE_OPTIONS, "nosniff")], bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::testutil::{server_state, temp_dir};
    use std::path::PathBuf;

    /// A state whose appearance config is `config.json` (holding `text`) in a
    /// fresh dir next to `Inter.woff2` and `secret.woff2`.
    fn state_with(text: Option<&str>) -> (Arc<ServerState>, PathBuf) {
        let bundle = temp_dir("appearance-bundle");
        std::fs::write(bundle.join("note.md"), "# Hi").unwrap();
        let dir = temp_dir("appearance-config");
        std::fs::write(dir.join("Inter.woff2"), b"wOF2").unwrap();
        std::fs::write(dir.join("secret.woff2"), b"unlisted").unwrap();
        let mut cfg = Config::plain(bundle);
        if let Some(text) = text {
            std::fs::write(dir.join("config.json"), text).unwrap();
            cfg.appearance_config = Some(dir.join("config.json"));
        }
        (server_state(cfg), dir)
    }

    async fn font(state: &Arc<ServerState>, file: &str) -> (StatusCode, Vec<u8>) {
        let q = Query(FontQuery { file: file.to_string() });
        let response = match font_handler(State(state.clone()), q).await {
            Ok(r) => r,
            Err(e) => e.into_response(),
        };
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, body.to_vec())
    }

    const CONFIG: &str = r#"{ "colors": { "dark": { "accent": "red" } },
        "fonts": { "ui": { "family": "Inter", "size": 15, "files": ["Inter.woff2"] } } }"#;

    #[tokio::test]
    async fn the_appearance_is_the_configs_colors_and_fonts() {
        let (state, _) = state_with(Some(CONFIG));
        let Json(a) = appearance_handler(State(state)).await;
        let a = a.unwrap();
        assert_eq!(a["colors"]["dark"]["accent"], "red");
        assert_eq!(a["fonts"]["ui"]["size"], 15);
    }

    #[tokio::test]
    async fn no_config_or_a_bad_one_is_null() {
        let (state, _) = state_with(None);
        assert!(appearance_handler(State(state)).await.0.is_none());
        let (state, _) = state_with(Some("{ nope"));
        assert!(appearance_handler(State(state)).await.0.is_none());
    }

    #[tokio::test]
    async fn the_config_is_reread_per_request() {
        let (state, dir) = state_with(Some("{}"));
        assert!(appearance_handler(State(state.clone())).await.0.is_none());
        std::fs::write(dir.join("config.json"), CONFIG).unwrap();
        assert!(appearance_handler(State(state)).await.0.is_some());
    }

    #[tokio::test]
    async fn a_listed_font_is_served() {
        let (state, _) = state_with(Some(CONFIG));
        let q = Query(FontQuery { file: "Inter.woff2".to_string() });
        let Ok(response) = font_handler(State(state), q).await else {
            panic!("the listed font must be served");
        };
        assert_eq!(response.headers()[CONTENT_TYPE], "font/woff2");
        assert_eq!(response.headers()[X_CONTENT_TYPE_OPTIONS], "nosniff");
    }

    #[tokio::test]
    async fn only_listed_fonts_inside_the_config_dir_are_served() {
        let (state, _) = state_with(Some(CONFIG));
        assert_eq!(font(&state, "secret.woff2").await.0, StatusCode::NOT_FOUND);
        assert_eq!(font(&state, "config.json").await.0, StatusCode::NOT_FOUND);
        for bad in ["../x.woff2", "/etc/x.woff2", ".hidden/x.woff2"] {
            assert_eq!(font(&state, bad).await.0, StatusCode::BAD_REQUEST, "{bad}");
        }
        let (state, _) = state_with(None);
        assert_eq!(font(&state, "Inter.woff2").await.0, StatusCode::NOT_FOUND);
    }
}
