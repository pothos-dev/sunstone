//! `sunstone lint`: a health check over a whole Bundle.
//!
//! Walks the Bundle the way the index does ([`crate::paths::md_files`]) and
//! reports, per file and line:
//!
//! - **Frontmatter**: the editor's own lint (`sunstone_shared::okf_lint`,
//!   ADR 0009), so the CLI and the Frontmatter editor never disagree.
//! - **Links**: Markdown links, Wikilinks and Embeds that resolve to nothing,
//!   and `#anchors` naming no heading — resolved by the same shared code the
//!   editor's broken-link decoration uses (`resolve_link`, `resolve_wikilink`,
//!   `resolve_embed_*`), against the same Bundle root ([`find_bundle_root`]).
//! - **Footnotes**: a `[^label]` with no definition and no matching
//!   `sources[].id`.
//!
//! OKF checks are gated exactly like the editor's (ADR 0009): only when the
//! Bundle root's `index.md` declares `okf_version`, and only for files inside
//! that root. They add: a Concept with no Frontmatter block (§11), a `log.md`
//! carrying one (§9; an `index.md` may, ADR 0018), path-valued fields pointing at nothing (§6.2), a
//! Concept missing from its directory's `index.md` (§8), a `stale_after` in
//! the past (§5.5) and a v0.1 `# Citations` list (§13.1) — the last two info
//! only: staleness is advisory, and v0.1 forms still read.
//!
//! [`Exclude`] patterns (gitignore syntax, `--exclude`) take files out of the
//! check: nothing is reported in them, and an index is not asked to list them.
//! They stay in the Bundle, so a link INTO an excluded folder still resolves.
//!
//! The checks are pure over a [`Snapshot`] of the Bundle; [`lint_bundle`] is
//! the thin filesystem half.

pub mod cli;
mod report;

pub use report::{render_json, render_text};

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::Serialize;
use sunstone_shared::embed::{self, EmbedKind};
use sunstone_shared::frontmatter::{self, parse_frontmatter};
use sunstone_shared::okf_lint::{self, LintMode, Severity};
use sunstone_shared::outline::scan_headings;
use sunstone_shared::paths::is_external;
use sunstone_shared::scan::markdown_link_hrefs;
use sunstone_shared::sources::{sources, ResourceKind};
use sunstone_shared::{computation, footnotes, trust, wikilink};
use sunstone_shared::{find_bundle_root, resolve_link, BundleRoot, OkfMarker, ResolvedLink};

use crate::paths::md_files;

/// One problem, at a file and line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// Bundle-relative path of the file.
    pub path: String,
    /// 1-based line in the file.
    pub line: usize,
    pub severity: Severity,
    /// Stable kebab-case id of the check, e.g. `broken-link`.
    pub code: String,
    pub message: String,
}

/// The result of linting a Bundle.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// How many `.md` files were checked.
    pub files: usize,
    /// How many `.md` files the exclude patterns skipped.
    pub excluded: usize,
    /// The `okf_version` the Bundle root declares; `None` means no OKF checks ran.
    pub okf_version: Option<String>,
    /// The Bundle root within the opened folder (`""` = the folder itself).
    pub bundle_root: String,
    /// Sorted by path, then line.
    pub diagnostics: Vec<Diagnostic>,
}

impl Report {
    pub fn count(&self, severity: Severity) -> usize {
        self.diagnostics.iter().filter(|d| d.severity == severity).count()
    }
}

/// Files kept out of the lint: gitignore-style patterns, relative to the
/// opened folder (`tickets/`, `/drafts`, `adr/*.md`, `**/scratch`).
#[derive(Default)]
pub struct Exclude(Option<ignore::gitignore::Gitignore>);

impl Exclude {
    /// Compile `patterns`; an invalid one is an error naming it.
    pub fn new(patterns: &[String]) -> Result<Exclude, String> {
        if patterns.is_empty() {
            return Ok(Exclude(None));
        }
        let mut b = ignore::gitignore::GitignoreBuilder::new("");
        for p in patterns {
            b.add_line(None, p).map_err(|e| format!("invalid --exclude pattern '{p}': {e}"))?;
        }
        b.build().map(|g| Exclude(Some(g))).map_err(|e| e.to_string())
    }

    /// Whether the bundle-relative file `path`, or a folder above it, is excluded.
    pub fn matches(&self, path: &str) -> bool {
        self.0.as_ref().is_some_and(|g| g.matched_path_or_any_parents(path, false).is_ignore())
    }
}

/// Everything the checks read: the Bundle's files, as of one walk.
pub struct Snapshot {
    /// Every `.md` file: bundle-relative path → content.
    pub concepts: BTreeMap<String, String>,
    /// Every Attachment path (the Embed name-resolution corpus).
    pub attachments: Vec<String>,
    /// Whether a non-`.md` bundle-relative path (file or folder) exists.
    pub exists: Box<dyn Fn(&str) -> bool>,
    /// The opened folder's path within its git repository (the root ladder's
    /// git rung), `None` outside one.
    pub git_prefix: Option<String>,
    /// Now, as Unix seconds (for `stale_after`).
    pub now: i64,
    /// Files not to check (they still count as link targets).
    pub exclude: Exclude,
}

/// Lint the Bundle at `root`.
pub fn lint_bundle(root: &Path, exclude: Exclude) -> Report {
    let concepts = md_files(root)
        .map(|(path, rel)| (rel, std::fs::read_to_string(path).unwrap_or_default()))
        .collect();
    let base = root.to_path_buf();
    let snapshot = Snapshot {
        concepts,
        attachments: crate::index::attachment_files(root).collect(),
        exists: Box::new(move |rel: &str| !rel.is_empty() && base.join(rel).exists()),
        git_prefix: crate::git::repo_prefix(root),
        now: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64),
        exclude,
    };
    lint_snapshot(&snapshot)
}

/// Lint a [`Snapshot`]: the pure half of [`lint_bundle`].
pub fn lint_snapshot(s: &Snapshot) -> Report {
    let paths: Vec<String> = s.concepts.keys().cloned().collect();
    let markers: Vec<OkfMarker> = s
        .concepts
        .iter()
        .filter(|(p, _)| wikilink::basename(p) == "index.md")
        .filter_map(|(p, c)| {
            frontmatter::okf_version_of(c).map(|v| OkfMarker { index_path: p.clone(), okf_version: v })
        })
        .collect();
    let root = find_bundle_root(&paths, &markers, s.git_prefix.as_deref(), None);
    let ctx = Ctx { s, paths: &paths, root: &root };

    let mut out = Vec::new();
    let mut excluded = 0;
    for (path, content) in &s.concepts {
        if s.exclude.matches(path) {
            excluded += 1;
            continue;
        }
        ctx.check_file(path, content, &mut out);
    }
    if root.okf_version.is_some() {
        ctx.check_indexes(&mut out);
    }
    out.sort_by(|a, b| (&a.path, a.line, &a.code).cmp(&(&b.path, b.line, &b.code)));
    Report {
        files: s.concepts.len() - excluded,
        excluded,
        okf_version: root.okf_version.clone(),
        bundle_root: root.dir.clone(),
        diagnostics: out,
    }
}

/// Whether `path` is a reserved file (`index.md` / `log.md`, OKF §3.1).
fn is_reserved(path: &str) -> bool {
    let name = wikilink::basename(path).to_ascii_lowercase();
    name == "index.md" || name == "log.md"
}

struct Ctx<'a> {
    s: &'a Snapshot,
    paths: &'a [String],
    root: &'a BundleRoot,
}

/// A file being checked: where its body starts, for line numbers.
struct File<'a> {
    path: &'a str,
    content: &'a str,
    /// Byte offset of the body in `content`.
    body_at: usize,
    /// The body with code (fences, inline spans) blanked, same length: an
    /// example link in backticks is not a link.
    masked: String,
}

impl File<'_> {
    fn body(&self) -> &str {
        &self.content[self.body_at..]
    }
    /// 1-based file line of a byte offset into the body.
    fn line_of(&self, body_offset: usize) -> usize {
        let at = (self.body_at + body_offset).min(self.content.len());
        self.content[..at].matches('\n').count() + 1
    }
    /// 1-based file line of the first occurrence of `needle` in the body at or
    /// after `*cursor`, advancing the cursor past it (links are reported in
    /// document order, so repeats land on their own lines).
    fn find_line(&self, needle: &str, cursor: &mut usize) -> usize {
        let body = &self.masked;
        match body.get(*cursor..).and_then(|rest| rest.find(needle)) {
            Some(i) => {
                *cursor += i + needle.len();
                self.line_of(*cursor - needle.len())
            }
            None => self.line_of(*cursor),
        }
    }
}

fn diag(path: &str, line: usize, severity: Severity, code: &str, message: String) -> Diagnostic {
    Diagnostic { path: path.to_string(), line, severity, code: code.to_string(), message }
}

impl Ctx<'_> {
    /// Whether OKF checks apply to `path` (ADR 0009's gate, `src/lib/okf/mode.ts`).
    fn okf_scope(&self, path: &str) -> bool {
        self.root.okf_version.is_some() && (self.root.dir.is_empty() || path.starts_with(&format!("{}/", self.root.dir)))
    }

    fn concept_exists(&self, path: &str) -> bool {
        self.s.concepts.contains_key(path)
    }

    fn check_file(&self, path: &str, content: &str, out: &mut Vec<Diagnostic>) {
        let split = frontmatter::split(content);
        let body_at = content.len() - split.body.len();
        let file = File { path, content, body_at, masked: embed::mask_code(split.body) };
        let okf = self.okf_scope(path);
        let reserved = is_reserved(path);

        self.check_frontmatter(&file, &split, okf && !reserved, out);
        // An `index.md` is its folder's lead Concept and may carry Frontmatter,
        // a deliberate deviation from OKF §8 (ADR 0018); a `log.md` may not (§9).
        if okf && reserved && split.has_frontmatter && wikilink::basename(path).eq_ignore_ascii_case("log.md") {
            out.push(diag(path, 1, Severity::Error, "reserved-frontmatter", "A `log.md` carries no Frontmatter (OKF §9)".into()));
        }
        self.check_links(&file, out);
        self.check_wikilinks(&file, out);
        self.check_embeds(&file, out);
        self.check_footnotes(&file, split.yaml, out);
        if okf && !reserved {
            self.check_resources(&file, split.yaml, out);
            self.check_stale(&file, out);
            self.check_citations_heading(&file, out);
        }
    }

    fn check_frontmatter(&self, f: &File, split: &frontmatter::Split, okf: bool, out: &mut Vec<Diagnostic>) {
        if !split.has_frontmatter {
            if okf {
                out.push(diag(
                    f.path,
                    1,
                    Severity::Error,
                    "frontmatter-missing",
                    "No Frontmatter block: an OKF Concept starts with `---` YAML carrying at least `type` (OKF §4)".into(),
                ));
            }
            return;
        }
        let mode = if okf { LintMode::Okf } else { LintMode::Yaml };
        // The YAML starts on the line after the opening `---`.
        let first = split.open.matches('\n').count() + 1;
        for finding in okf_lint::lint_frontmatter(split.yaml, mode) {
            let code = if finding.source == "yaml" { "yaml" } else { "frontmatter" };
            out.push(diag(f.path, first + finding.line - 1, finding.severity, code, finding.message));
        }
    }

    fn check_links(&self, f: &File, out: &mut Vec<Diagnostic>) {
        let mut cursor = 0;
        for href in markdown_link_hrefs(&f.masked) {
            let line = f.find_line(&href, &mut cursor);
            let raw = href.trim();
            if let Some(anchor) = raw.strip_prefix('#') {
                if !anchor.is_empty() && !has_anchor(f.content, anchor) {
                    out.push(diag(f.path, line, Severity::Error, "broken-anchor", format!("No heading `#{anchor}` in this file")));
                }
                continue;
            }
            match resolve_link(f.path, raw, self.root, |p| self.concept_exists(p)) {
                ResolvedLink::Internal { path, anchor, exists } => {
                    if exists {
                        if let Some(anchor) = anchor {
                            if !has_anchor(&self.s.concepts[&path], &anchor) {
                                out.push(diag(
                                    f.path,
                                    line,
                                    Severity::Error,
                                    "broken-anchor",
                                    format!("No heading `#{anchor}` in `{path}`"),
                                ));
                            }
                        }
                    } else if !(self.s.exists)(&path) && !escaping_path(f.path, raw).is_some_and(|p| (self.s.exists)(&p)) {
                        out.push(diag(f.path, line, Severity::Error, "broken-link", format!("Link target does not exist: `{raw}`")));
                    }
                }
                ResolvedLink::External { .. } | ResolvedLink::None => {}
            }
        }
    }

    fn check_wikilinks(&self, f: &File, out: &mut Vec<Diagnostic>) {
        let mut cursor = 0;
        for raw in wikilink::wikilink_raws(f.body()) {
            let line = f.find_line(&format!("[[{raw}]]"), &mut cursor);
            if wikilink::resolve_wikilink(self.paths, f.path, &raw).is_none() {
                out.push(diag(f.path, line, Severity::Error, "broken-wikilink", format!("Wikilink matches no Concept: `[[{raw}]]`")));
            }
        }
    }

    fn check_embeds(&self, f: &File, out: &mut Vec<Diagnostic>) {
        for e in embed::scan_embeds(f.body()) {
            let found = match e.kind {
                EmbedKind::Name => embed::resolve_embed_name(&self.s.attachments, &e.target).is_some(),
                EmbedKind::Path => match embed::resolve_embed_path(f.path, &e.target) {
                    Some(p) => self.concept_exists(&p) || (self.s.exists)(&p),
                    None => true, // a URL or data: embed is not ours to check
                },
            };
            if !found {
                out.push(diag(
                    f.path,
                    f.line_of(e.from),
                    Severity::Error,
                    "broken-embed",
                    format!("Embedded file does not exist: `{}`", e.target),
                ));
            }
        }
    }

    fn check_footnotes(&self, f: &File, yaml: &str, out: &mut Vec<Diagnostic>) {
        let ids = footnotes::source_ids(yaml);
        let body = f.body();
        let mut seen = HashSet::new();
        for n in footnotes::scan_footnotes(body, &ids) {
            if n.def || n.defined || !seen.insert(n.label.to_lowercase()) {
                continue;
            }
            out.push(diag(
                f.path,
                f.line_of(utf16_to_byte(body, n.from)),
                Severity::Warning,
                "footnote-undefined",
                format!("Footnote `[^{}]` has no definition and matches no `sources[].id`", n.label),
            ));
        }
    }

    /// Path-valued Frontmatter fields (§6.2) that point at nothing.
    fn check_resources(&self, f: &File, yaml: &str, out: &mut Vec<Diagnostic>) {
        let mut fields: Vec<(String, String)> = Vec::new();
        for (i, src) in sources(yaml).iter().enumerate() {
            if src.kind == ResourceKind::Path {
                fields.push((format!("sources[{i}].resource"), src.resource.clone()));
            }
        }
        if let Some(c) = computation::contract(yaml) {
            for (label, field) in c.path_fields() {
                if field.kind == computation::PathKind::Path {
                    fields.push((label.to_string(), field.value.clone()));
                }
            }
        }
        for (label, value) in fields {
            if is_external(&value) || self.resource_exists(f.path, &value) {
                continue;
            }
            out.push(diag(
                f.path,
                key_line(f.content, label.split(['.', '[']).next().unwrap_or("")),
                Severity::Warning,
                "missing-resource",
                format!("`{label}` points at nothing in the Bundle: `{value}`"),
            ));
        }
    }

    /// A §6.2 path resolves against the Concept, or failing that the Bundle
    /// root or the repository it lives in.
    fn resource_exists(&self, from: &str, value: &str) -> bool {
        let found = |p: &str| self.concept_exists(p) || (self.s.exists)(p);
        let as_link = match resolve_link(from, value, self.root, |p| self.concept_exists(p)) {
            ResolvedLink::Internal { path, .. } => found(&path),
            _ => false,
        };
        as_link || {
            let bare = value.trim().trim_start_matches("./").trim_start_matches('/');
            let rooted = if self.root.dir.is_empty() { bare.to_string() } else { format!("{}/{bare}", self.root.dir) };
            // The repository toplevel, as seen from the opened folder.
            let repo = self.s.git_prefix.as_deref().map(|prefix| {
                format!("{}{bare}", "../".repeat(prefix.split('/').filter(|s| !s.is_empty()).count()))
            });
            found(&rooted) || escaping_path(from, value).is_some_and(|p| found(&p)) || repo.is_some_and(|p| found(&p))
        }
    }

    fn check_stale(&self, f: &File, out: &mut Vec<Diagnostic>) {
        let Some(stale) = parse_frontmatter(f.content).stale_after else { return };
        let Some(at) = trust::epoch_seconds(&stale) else { return };
        if at <= self.s.now {
            out.push(diag(
                f.path,
                key_line(f.content, "stale_after"),
                Severity::Info,
                "stale",
                format!("Stale since {stale}: re-check the content and move `stale_after` forward (OKF §5.5)"),
            ));
        }
    }

    /// A v0.1 `# Citations` body list: a `Citations` heading whose section
    /// holds `[n] …` rows (outside code). A section merely ABOUT citations, with
    /// no rows, is not one.
    fn check_citations_heading(&self, f: &File, out: &mut Vec<Diagnostic>) {
        let masked = embed::mask_code(f.content);
        let lines: Vec<&str> = masked.lines().collect();
        let headings = scan_headings(f.content);
        for (i, h) in headings.iter().enumerate() {
            if !h.text.eq_ignore_ascii_case("citations") {
                continue;
            }
            let end = headings[i + 1..].iter().find(|n| n.level <= h.level).map_or(lines.len(), |n| n.line - 1);
            let section = lines.get(h.line..end.max(h.line)).unwrap_or(&[]);
            if section.iter().any(|l| is_citation_row(l)) {
                out.push(diag(
                    f.path,
                    h.line,
                    Severity::Info,
                    "legacy-citations",
                    "A `# Citations` list is superseded by `sources` and `[^id]` footnotes in OKF v0.2 (OKF §13.1)".into(),
                ));
            }
        }
    }

    /// Every Concept should be listed in its directory's `index.md` (OKF §8).
    fn check_indexes(&self, out: &mut Vec<Diagnostic>) {
        for (index, content) in &self.s.concepts {
            if wikilink::basename(index) != "index.md" || !self.okf_scope(index) || self.s.exclude.matches(index) {
                continue;
            }
            let dir = &index[..index.len() - "index.md".len()];
            let body = frontmatter::split(content).body;
            let mut listed: HashSet<String> = HashSet::new();
            for href in markdown_link_hrefs(body) {
                if let ResolvedLink::Internal { path, .. } = resolve_link(index, &href, self.root, |p| self.concept_exists(p)) {
                    listed.insert(path);
                }
            }
            for raw in wikilink::wikilink_raws(body) {
                listed.extend(wikilink::resolve_wikilink(self.paths, index, &raw));
            }
            for path in self.s.concepts.keys() {
                let Some(name) = path.strip_prefix(dir) else { continue };
                if name.contains('/') || is_reserved(path) || listed.contains(path) || self.s.exclude.matches(path) {
                    continue;
                }
                out.push(diag(index, 1, Severity::Warning, "index-unlisted", format!("`{name}` is not listed in this index (OKF §8)")));
            }
        }
    }
}

/// A relative `href` from `from` that climbs OUT of the opened folder
/// (`../../docker/README.md` from `docs/a.md`), as an opened-folder-relative
/// path with its leading `../`s, or `None` when it stays inside (or is
/// bundle-absolute). Such a link points at the repository around the Bundle,
/// which the filesystem can still answer for.
fn escaping_path(from: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.starts_with('/') || is_external(href) {
        return None;
    }
    let path = href.split(['#', '?']).next().unwrap_or("");
    let mut segs: Vec<&str> = from.split('/').collect();
    segs.pop(); // the file name
    let mut up = 0;
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if segs.pop().is_none() {
                    up += 1;
                }
            }
            s => segs.push(s),
        }
    }
    (up > 0).then(|| format!("{}{}", "../".repeat(up), segs.join("/")))
}

/// A v0.1 citation row: `[n]` at the start of a line, then text.
fn is_citation_row(line: &str) -> bool {
    let rest = line.trim_start();
    let Some(rest) = rest.strip_prefix('[') else { return false };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && rest[digits..].starts_with(']')
}

/// Whether `content` has a heading whose slug is `anchor`.
fn has_anchor(content: &str, anchor: &str) -> bool {
    let anchor = anchor.to_lowercase();
    scan_headings(content).iter().any(|h| h.slug == anchor)
}

/// 1-based line of a top-level Frontmatter key, or 1.
fn key_line(content: &str, key: &str) -> usize {
    let prefix = format!("{key}:");
    content.lines().position(|l| l.starts_with(&prefix)).map_or(1, |i| i + 1)
}

/// A UTF-16 offset into `text` as a byte offset.
fn utf16_to_byte(text: &str, utf16: usize) -> usize {
    let mut n = 0;
    for (i, c) in text.char_indices() {
        if n >= utf16 {
            return i;
        }
        n += c.len_utf16();
    }
    text.len()
}

#[cfg(test)]
mod tests;
