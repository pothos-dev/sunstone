//! The **content API**: a Concept's own page URL answers JSON or Markdown when
//! the caller asks for it in `Accept`, so remote callers (agents, a GraphQL
//! layer) read the Bundle without HTML and without a reserved path prefix that
//! a Bundle folder could collide with.
//!
//! | URL                    | `Accept`           | Answer                                  |
//! | ---------------------- | ------------------ | --------------------------------------- |
//! | `/okf/bundle` (or `.md`) | `text/markdown`  | the raw file, frontmatter included      |
//! | `/okf/bundle` (or `.md`) | `application/json` | [`ConceptDoc`]                        |
//! | `/okf?list[&type=][&tag=]` | `application/json` | `[ConceptSummary]` under `okf/`     |
//! | `/okf?q=term`          | `application/json` | `[ContentHit]` under `okf/`             |
//!
//! A page URL resolves like the web viewer's ([`url_to_concept`]: a folder
//! `index.md` wins over a same-named leaf; a `.md` path is taken literally).
//! The folder views take a query parameter, not a trailing slash, because
//! `/okf` already names `okf/index.md` and SvelteKit redirects `/okf/` to it.
//!
//! [`negotiate`] decides HTML vs. this API; `apiProxy.ts` (`wantsContentApi`)
//! mirrors it for Sunstone Web, whose hook forwards to [`content_handler`] at
//! `/_api/content/…`. `sunstone serve` calls [`content`] from its app-shell
//! fallback (`local.rs`). Every answer carries `Vary: Accept`, since the same
//! URL is also a page.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{
        header::{ACCEPT, CONTENT_TYPE, VARY},
        HeaderMap, StatusCode,
    },
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use sunstone_native::bundle;
use sunstone_native::index::{ConceptSummary, Index};
use sunstone_native::search;
use sunstone_shared::frontmatter::{parse_mapping, split};
use sunstone_shared::url::url_to_concept;

use crate::api_error::{check_rel_path, classify};
use crate::routes_read::read_index;
use crate::ServerState;

/// What a request asks for, by its `Accept` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Wants {
    Html,
    Json,
    Markdown,
}

/// Pick HTML or the content API from an `Accept` header.
///
/// The API answers only when `application/json` or `text/markdown` is named
/// **explicitly** with a higher q-value than `text/html` /
/// `application/xhtml+xml`. Wildcards never select it, so a browser navigation
/// (`text/html,…,*/*;q=0.8`), a bare `curl` (`*/*`) and a missing header all
/// get the page. JSON wins a tie with Markdown. Keep in step with
/// `wantsContentApi` in `src/lib/server/apiProxy.ts`.
pub(crate) fn negotiate(accept: Option<&str>) -> Wants {
    let (mut html, mut json, mut md) = (0.0_f32, 0.0_f32, 0.0_f32);
    for range in accept.unwrap_or("").split(',') {
        let mut parts = range.split(';');
        let media = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let q = parts
            .filter_map(|p| p.trim().strip_prefix("q="))
            .find_map(|q| q.trim().parse::<f32>().ok())
            .unwrap_or(1.0);
        let slot = match media.as_str() {
            "text/html" | "application/xhtml+xml" => &mut html,
            "application/json" => &mut json,
            "text/markdown" => &mut md,
            _ => continue,
        };
        *slot = slot.max(q);
    }
    if json > 0.0 && json > html && json >= md {
        Wants::Json
    } else if md > 0.0 && md > html {
        Wants::Markdown
    } else {
        Wants::Html
    }
}

/// The query parameters the content API reads. Anything else is ignored.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ContentQuery {
    /// Full-text search under the URL's folder.
    q: Option<String>,
    /// Present (any value) ⇒ list the Concepts under the URL's folder.
    list: Option<String>,
    /// List filter: frontmatter `type`, exact.
    #[serde(rename = "type")]
    concept_type: Option<String>,
    /// List filter: one frontmatter tag, exact.
    tag: Option<String>,
}

/// One Concept, as JSON: its parsed frontmatter, the Markdown body after it,
/// and its resolved links both ways.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConceptDoc {
    path: String,
    /// Every top-level frontmatter key; `{}` without a (valid) block.
    frontmatter: BTreeMap<String, Value>,
    body: String,
    /// The Concepts this one links to (Markdown links and Wikilinks).
    links: Vec<String>,
    backlinks: Vec<String>,
}

/// One search match, with its Concept's title.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContentHit {
    path: String,
    title: Option<String>,
    line: u64,
    snippet: String,
}

/// `GET /_api/content` — the content API for the root URL `/`.
pub(crate) async fn content_root_handler(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<ContentQuery>,
    headers: HeaderMap,
) -> Response {
    content(&state, "", &q, api_wants(&headers))
}

/// `GET /_api/content/{*path}` — the content API for the page URL `/{path}`.
/// Sunstone Web's hook forwards here; called directly, a request without an
/// explicit `Accept` gets JSON (this route never answers HTML).
pub(crate) async fn content_handler(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
    Query(q): Query<ContentQuery>,
    headers: HeaderMap,
) -> Response {
    content(&state, &path, &q, api_wants(&headers))
}

fn api_wants(headers: &HeaderMap) -> Wants {
    match negotiate(headers.get(ACCEPT).and_then(|v| v.to_str().ok())) {
        Wants::Html => Wants::Json,
        wants => wants,
    }
}

/// Answer the content API for the (percent-decoded) page URL path `url_path`.
/// `wants` must not be [`Wants::Html`] (that is the page's job).
pub(crate) fn content(
    state: &ServerState,
    url_path: &str,
    query: &ContentQuery,
    wants: Wants,
) -> Response {
    let url_path = url_path.trim_matches('/');
    if let Err(msg) = check_rel_path(url_path) {
        return error(StatusCode::BAD_REQUEST, msg);
    }
    let folder_view = query.q.is_some() || query.list.is_some();
    if folder_view && wants == Wants::Markdown {
        return error(
            StatusCode::NOT_ACCEPTABLE,
            "lists and search results are JSON only".into(),
        );
    }
    match (&query.q, &query.list) {
        (Some(_), Some(_)) => error(
            StatusCode::BAD_REQUEST,
            "use either `q` or `list`, not both".into(),
        ),
        (Some(q), None) => search_folder(state, url_path, q),
        (None, Some(_)) => list_folder(state, url_path, query),
        (None, None) => read(state, url_path, wants),
    }
}

/// A page URL path → the Concept it names, as the web viewer resolves it.
fn resolve_concept(index: &Index, url_path: &str) -> Option<String> {
    let is_md = url_path.len() > 3
        && url_path.is_char_boundary(url_path.len() - 3)
        && url_path[url_path.len() - 3..].eq_ignore_ascii_case(".md");
    if is_md {
        index.concept_exists(url_path).then(|| url_path.to_string())
    } else {
        url_to_concept(url_path, &index.concept_paths())
    }
}

fn read(state: &ServerState, url_path: &str, wants: Wants) -> Response {
    let (path, links, backlinks) = {
        let index = match read_index(state) {
            Ok(index) => index,
            Err(e) => return error(e.0, e.1),
        };
        let Some(path) = resolve_concept(&index, url_path) else {
            return error(StatusCode::NOT_FOUND, format!("no Concept at /{url_path}"));
        };
        let (links, backlinks) = (index.outbound_links(&path), index.backlinks(&path));
        (path, links, backlinks)
    };
    let content = match bundle::read_concept(&state.app.bundle_root, &path) {
        Ok(content) => content,
        Err(msg) => return error(classify(&msg), msg),
    };
    if wants == Wants::Markdown {
        return (
            [
                (CONTENT_TYPE, "text/markdown; charset=utf-8"),
                (VARY, "Accept"),
            ],
            content,
        )
            .into_response();
    }
    ok(&ConceptDoc {
        frontmatter: frontmatter_json(&content),
        body: split(&content).body.to_string(),
        path,
        links,
        backlinks,
    })
}

/// The frontmatter block as a JSON object. A key that is not a string is
/// stringified; a value JSON cannot hold (a map with non-string keys) is `null`.
fn frontmatter_json(content: &str) -> BTreeMap<String, Value> {
    let Some(map) = parse_mapping(content) else {
        return BTreeMap::new();
    };
    map.iter()
        .map(|(k, v)| {
            let key = match k.as_str() {
                Some(s) => s.to_string(),
                None => serde_yaml::to_string(k).unwrap_or_default().trim().to_string(),
            };
            (key, serde_json::to_value(v).unwrap_or(Value::Null))
        })
        .collect()
}

/// `Err` (a 404) when `dir` is neither the root nor a folder in the Bundle.
fn check_folder(state: &ServerState, dir: &str) -> Result<(), Response> {
    if dir.is_empty() || state.app.bundle_root.join(dir).is_dir() {
        Ok(())
    } else {
        Err(error(StatusCode::NOT_FOUND, format!("no folder at /{dir}")))
    }
}

fn list_folder(state: &ServerState, dir: &str, query: &ContentQuery) -> Response {
    if let Err(res) = check_folder(state, dir) {
        return res;
    }
    let index = match read_index(state) {
        Ok(index) => index,
        Err(e) => return error(e.0, e.1),
    };
    let list: Vec<ConceptSummary> = index
        .summaries(dir)
        .into_iter()
        .filter(|s| {
            query
                .concept_type
                .as_ref()
                .is_none_or(|t| s.concept_type.as_ref() == Some(t))
        })
        .filter(|s| query.tag.as_ref().is_none_or(|t| s.tags.contains(t)))
        .collect();
    ok(&list)
}

fn search_folder(state: &ServerState, dir: &str, q: &str) -> Response {
    if let Err(res) = check_folder(state, dir) {
        return res;
    }
    let hits = match search::search_in(&state.app.bundle_root, dir, q) {
        Ok(hits) => hits,
        Err(msg) => return error(StatusCode::BAD_REQUEST, msg),
    };
    let index = match read_index(state) {
        Ok(index) => index,
        Err(e) => return error(e.0, e.1),
    };
    let hits: Vec<ContentHit> = hits
        .into_iter()
        .map(|h| ContentHit {
            title: index.summary(&h.path).and_then(|s| s.title),
            path: h.path,
            line: h.line,
            snippet: h.snippet,
        })
        .collect();
    ok(&hits)
}

fn ok<T: Serialize>(body: &T) -> Response {
    ([(VARY, "Accept")], Json(body)).into_response()
}

fn error(status: StatusCode, msg: String) -> Response {
    (status, [(VARY, "Accept")], Json(json!({ "error": msg }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::testutil::{put, server_state, temp_dir};

    #[test]
    fn negotiation_needs_an_explicit_api_type_over_html() {
        use Wants::*;
        for (accept, wants) in [
            (None, Html),
            (Some(""), Html),
            (Some("*/*"), Html),
            (
                Some("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
                Html,
            ),
            (Some("application/json"), Json),
            (Some("application/json, text/plain, */*"), Json),
            (Some("Application/JSON; charset=utf-8"), Json),
            (Some("text/markdown"), Markdown),
            (Some("text/markdown, application/json"), Json),
            (Some("text/markdown, application/json;q=0.5"), Markdown),
            (Some("text/html, application/json"), Html),
            (Some("text/html;q=0.5, application/json"), Json),
            (Some("application/json;q=0"), Html),
            (Some("text/*"), Html),
        ] {
            assert_eq!(negotiate(accept), wants, "{accept:?}");
        }
    }

    fn state() -> Arc<ServerState> {
        let root = temp_dir("content");
        put(&root, "index.md", b"---\ntitle: Home\n---\nSee [guide](guide/index.md).\n");
        put(
            &root,
            "guide/index.md",
            b"---\ntype: Guide\ntitle: Guide\ndescription: How to.\ntags: [docs]\n---\n# Guide\n\nquick start\n",
        );
        put(&root, "guide/setup.md", b"---\ntype: Step\n---\nquick setup, see [up](index.md)\n");
        put(&root, "notes.md", b"no frontmatter, quick\n");
        server_state(Config::local(root, 0))
    }

    async fn body(res: Response) -> (StatusCode, HeaderMap, String) {
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn query(pairs: &str) -> ContentQuery {
        let uri: axum::http::Uri = format!("/?{pairs}").parse().unwrap();
        Query::<ContentQuery>::try_from_uri(&uri).unwrap().0
    }

    #[tokio::test]
    async fn a_concept_reads_as_markdown_by_pretty_url_or_path() {
        let state = state();
        for url in ["guide/setup", "guide/setup.md", "/guide/setup/"] {
            let (status, headers, text) =
                body(content(&state, url, &query(""), Wants::Markdown)).await;
            assert_eq!(status, StatusCode::OK, "{url}");
            assert_eq!(headers[CONTENT_TYPE], "text/markdown; charset=utf-8");
            assert_eq!(headers[VARY], "Accept");
            assert_eq!(text, "---\ntype: Step\n---\nquick setup, see [up](index.md)\n");
        }
    }

    #[tokio::test]
    async fn a_concept_reads_as_json_with_frontmatter_and_links() {
        let state = state();
        let (status, _, text) = body(content(&state, "guide", &query(""), Wants::Json)).await;
        assert_eq!(status, StatusCode::OK);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["path"], "guide/index.md");
        assert_eq!(v["frontmatter"]["title"], "Guide");
        assert_eq!(v["frontmatter"]["tags"], json!(["docs"]));
        assert_eq!(v["body"], "# Guide\n\nquick start\n");
        assert_eq!(v["backlinks"], json!(["guide/setup.md", "index.md"]));

        let (_, _, text) = body(content(&state, "", &query(""), Wants::Json)).await;
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["path"], "index.md");
        assert_eq!(v["links"], json!(["guide/index.md"]));

        let (_, _, text) = body(content(&state, "notes", &query(""), Wants::Json)).await;
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["frontmatter"], json!({}));
    }

    #[tokio::test]
    async fn missing_and_refused_paths_are_json_errors() {
        let state = state();
        for (url, status) in [
            ("nope", StatusCode::NOT_FOUND),
            ("guide/nope.md", StatusCode::NOT_FOUND),
            (".git/config", StatusCode::BAD_REQUEST),
            ("guide/../../etc/passwd", StatusCode::BAD_REQUEST),
        ] {
            let (got, headers, text) = body(content(&state, url, &query(""), Wants::Json)).await;
            assert_eq!(got, status, "{url}");
            assert_eq!(headers[VARY], "Accept");
            let v: Value = serde_json::from_str(&text).unwrap();
            assert!(v["error"].is_string(), "{url}");
        }
    }

    #[tokio::test]
    async fn list_covers_a_folder_with_filters() {
        let state = state();
        let paths = |text: &str| -> Vec<String> {
            let v: Vec<Value> = serde_json::from_str(text).unwrap();
            v.iter().map(|s| s["path"].as_str().unwrap().to_string()).collect()
        };
        let (_, _, text) = body(content(&state, "", &query("list"), Wants::Json)).await;
        assert_eq!(paths(&text), ["guide/index.md", "guide/setup.md", "index.md", "notes.md"]);

        let (_, _, text) = body(content(&state, "guide", &query("list"), Wants::Json)).await;
        assert_eq!(paths(&text), ["guide/index.md", "guide/setup.md"]);
        let v: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert_eq!(v[0]["title"], "Guide");
        assert_eq!(v[0]["description"], "How to.");
        assert_eq!(v[0]["type"], "Guide");

        let (_, _, text) = body(content(&state, "", &query("list&type=Step"), Wants::Json)).await;
        assert_eq!(paths(&text), ["guide/setup.md"]);
        let (_, _, text) = body(content(&state, "", &query("list=1&tag=docs"), Wants::Json)).await;
        assert_eq!(paths(&text), ["guide/index.md"]);

        let (status, _, _) = body(content(&state, "missing", &query("list"), Wants::Json)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn search_covers_a_folder_and_carries_titles() {
        let state = state();
        let (status, _, text) = body(content(&state, "guide", &query("q=QUICK"), Wants::Json)).await;
        assert_eq!(status, StatusCode::OK);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            v,
            json!([
                { "path": "guide/index.md", "title": "Guide", "line": 9, "snippet": "quick start" },
                { "path": "guide/setup.md", "title": null, "line": 4, "snippet": "quick setup, see [up](index.md)" },
            ])
        );
        let (_, _, text) = body(content(&state, "", &query("q=quick"), Wants::Json)).await;
        assert_eq!(serde_json::from_str::<Vec<Value>>(&text).unwrap().len(), 3);
    }

    #[tokio::test]
    async fn folder_views_are_json_only_and_exclusive() {
        let state = state();
        let (status, _, _) = body(content(&state, "", &query("list"), Wants::Markdown)).await;
        assert_eq!(status, StatusCode::NOT_ACCEPTABLE);
        let (status, _, _) = body(content(&state, "", &query("q=x&list"), Wants::Json)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
