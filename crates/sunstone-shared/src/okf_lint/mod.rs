//! The OKF language service's lint (ADR 0009): [`lint_frontmatter`].
//!
//! The ONE set of Frontmatter rules for the editor (over wasm,
//! `src/lib/okf/lint.ts` → `editor/yamlLanguage`) and `sunstone lint`
//! (`sunstone-native/src/lint`), so a Concept the editor marks is the Concept
//! the CLI reports (ADR 0006).
//!
//! It takes the Frontmatter YAML block (no `---` fences) and a [`LintMode`],
//! parses ONCE into a positioned tree ([`tree`]), and returns findings sorted by
//! position:
//!
//! - [`LintMode::Yaml`] — well-formedness only: syntax errors and duplicate
//!   keys. What every Bundle gets, OKF or not.
//! - [`LintMode::Okf`] — the above, plus every OKF family the Concept opted into
//!   ([`families`]). Only a Bundle whose root `index.md` declares `okf_version`
//!   gets this. OKF rules never run on a block that does not parse: they would
//!   only add noise to the error the author is already fixing.
//!
//! Scoping: a family whose `keys` are all absent from a Concept's top level is
//! skipped, so a Concept with no `sources` gets no provenance findings. The
//! core family (`keys: []`) always runs. REQUIRED fields are errors (the
//! spec's MUSTs); everything else is a warning or info.
//!
//! The editor's save gate deliberately does not call this (it asks
//! `isParseable` in `src/lib/frontmatter.ts`), so whether a Concept saves can
//! never drift with lint policy.

mod families;
pub mod tree;

use serde::{Deserialize, Serialize};
use tree::{Kind, Node, Pair, Problem, Range};

/// Which rules apply: well-formedness only, or well-formedness plus OKF.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LintMode {
    Yaml,
    Okf,
}

/// How a finding should be weighted. The spec's REQUIRED fields are `Error`.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

/// One lint result.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Start, in UTF-16 code units into the YAML block (the editor's unit).
    pub from: usize,
    /// End (exclusive), in UTF-16 code units.
    pub to: usize,
    /// 1-based line of `from` within the YAML block.
    pub line: usize,
    pub severity: Severity,
    pub message: String,
    /// Who raised it: `yaml` for well-formedness, else the family id.
    pub source: String,
}

/// Lint a Frontmatter block (the inner YAML, no fences).
pub fn lint_frontmatter(yaml: &str, mode: LintMode) -> Vec<Finding> {
    let doc = tree::parse(yaml);
    let chars: Vec<char> = yaml.chars().collect();
    let mut raw: Vec<RawFinding> = Vec::new();
    for problem in &doc.problems {
        raw.push(match problem {
            Problem::Syntax { at, message } => {
                let at = (*at).min(chars.len());
                RawFinding::new((at, line_end(&chars, at)), Severity::Error, first_line(message), "yaml")
            }
            Problem::DuplicateKey { range, key } => {
                RawFinding::new(*range, Severity::Error, format!("Duplicate key `{key}`"), "yaml")
            }
        });
    }
    if mode == LintMode::Okf && !doc.malformed() {
        raw.extend(lint_okf(yaml, &chars, doc.root.as_ref()));
    }
    raw.sort_by_key(|f| f.range);
    let pos = Positions::new(&chars);
    raw.into_iter()
        .map(|f| Finding {
            from: pos.utf16[f.range.0],
            to: pos.utf16[f.range.1.max(f.range.0)],
            line: pos.line_of(f.range.0),
            severity: f.severity,
            message: f.message,
            source: f.source.to_string(),
        })
        .collect()
}

fn lint_okf(yaml: &str, chars: &[char], root: Option<&Node>) -> Vec<RawFinding> {
    let empty = Node { kind: Kind::Map(Vec::new()), range: (0, 0) };
    let root = match root {
        Some(node) if !node.is_map() => {
            return vec![RawFinding::new(
                node.range,
                Severity::Error,
                "OKF Frontmatter must be a mapping of keys, with at least `type` (OKF §4.1)".into(),
                "okf",
            )];
        }
        Some(node) => node,
        None => &empty,
    };
    let mut out = Vec::new();
    for family in families::FAMILIES {
        if !family.keys.is_empty() && !family.keys.iter().any(|k| root.pair(k).is_some()) {
            continue;
        }
        let ctx = Ctx { yaml, chars, root, source: family.id };
        for req in family.required {
            out.extend(check_required(&ctx, req));
        }
        for rule in family.rules {
            out.extend(rule(&ctx));
        }
    }
    out
}

/// A finding before its range is converted to the caller's units.
pub(crate) struct RawFinding {
    range: Range,
    severity: Severity,
    message: String,
    source: &'static str,
}

impl RawFinding {
    fn new(range: Range, severity: Severity, message: String, source: &'static str) -> Self {
        RawFinding { range, severity, message, source }
    }
}

/// A path into the Frontmatter: map keys, `"*"` standing for every list item.
pub(crate) type Path = &'static [&'static str];

/// A key the spec marks REQUIRED inside every map at `path`.
pub(crate) struct RequiredKey {
    pub path: Path,
    pub key: &'static str,
    /// Spec section to cite, e.g. `§5.2`.
    pub spec: &'static str,
}

pub(crate) type Rule = fn(&Ctx) -> Vec<RawFinding>;

/// A Frontmatter key family plugged into the lint.
pub(crate) struct Family {
    /// Stable id; also the `source` of its findings.
    pub id: &'static str,
    /// Top-level keys whose presence opts a Concept in; `[]` is always on.
    pub keys: &'static [&'static str],
    pub required: &'static [RequiredKey],
    pub rules: &'static [Rule],
}

/// A node found by [`Ctx::nodes_at`], with where "missing X here" points.
pub(crate) struct Located<'a> {
    pub node: Option<&'a Node>,
    pub anchor: Range,
}

/// Everything a rule gets: the block, its top-level map, position helpers.
pub(crate) struct Ctx<'a> {
    pub yaml: &'a str,
    chars: &'a [char],
    pub root: &'a Node,
    source: &'static str,
}

impl<'a> Ctx<'a> {
    pub fn at(&self, range: Range, severity: Severity, message: impl Into<String>) -> RawFinding {
        RawFinding::new(range, severity, message.into(), self.source)
    }

    /// The rest of the line starting at `offset`, trailing whitespace dropped.
    pub fn line_from(&self, offset: usize) -> Range {
        let end = line_end(self.chars, offset);
        let mut trimmed = end;
        while trimmed > offset && self.chars[trimmed - 1].is_whitespace() {
            trimmed -= 1;
        }
        (offset, trimmed)
    }

    /// Every node at `path` (`"*"` expands each list item), each with an anchor.
    pub fn nodes_at(&self, path: &[&str]) -> Vec<Located<'a>> {
        let root_anchor = if self.root.range == (0, 0) && self.root.pairs().is_empty() {
            (0, 0)
        } else {
            self.line_from(self.root.range.0)
        };
        let mut located = vec![Located { node: Some(self.root), anchor: root_anchor }];
        for segment in path {
            let mut next = Vec::new();
            for l in &located {
                let Some(node) = l.node else { continue };
                if *segment == "*" {
                    for item in node.items() {
                        // The item itself, clipped to its first line.
                        let (start, end) = item.range;
                        next.push(Located { node: Some(item), anchor: (start, end.min(self.line_from(start).1)) });
                    }
                } else if let Some(p) = node.pair(segment) {
                    next.push(Located { node: Some(&p.value), anchor: p.key.range });
                }
            }
            located = next;
        }
        located
    }
}

/// The pair's key + value span, for "this entry is wrong" findings.
pub(crate) fn pair_range(p: &Pair) -> Range {
    (p.key.range.0, p.value.range.1.max(p.key.range.0))
}

/// REQUIRED fields (spec §4.1, §5.1, §5.2) are errors — ADR 0009's one hard line.
fn check_required(ctx: &Ctx, req: &RequiredKey) -> Vec<RawFinding> {
    let mut out = Vec::new();
    let cite = format!(" (OKF {})", req.spec);
    let where_ = if req.path.is_empty() { String::new() } else { format!(" in `{}`", path_label(req.path)) };
    for Located { node, anchor } in ctx.nodes_at(req.path) {
        // An empty `generated:` is an empty map for this purpose; any other
        // non-map shape is the owning family's own rule to report.
        let Some(node) = node else { continue };
        if !node.is_map() && !node.is_empty_value() {
            continue;
        }
        match node.pair(req.key) {
            None => out.push(ctx.at(
                anchor,
                Severity::Error,
                format!("Missing required key `{}`{where_}{cite}", req.key),
            )),
            Some(p) if p.value.is_empty_value() => out.push(ctx.at(
                pair_range(p),
                Severity::Error,
                format!("`{}` is required but empty{where_}{cite}", req.key),
            )),
            Some(_) => {}
        }
    }
    out
}

/// `["sources", "*"]` → `sources[]`.
fn path_label(path: &[&str]) -> String {
    path.iter().fold(String::new(), |acc, seg| match *seg {
        "*" => format!("{acc}[]"),
        s if acc.is_empty() => s.to_string(),
        s => format!("{acc}.{s}"),
    })
}

fn line_end(chars: &[char], offset: usize) -> usize {
    let mut i = offset.min(chars.len());
    while i < chars.len() && chars[i] != '\n' {
        i += 1;
    }
    i
}

fn first_line(message: &str) -> String {
    let line = message.lines().next().unwrap_or("");
    let line = line.strip_suffix(':').unwrap_or(line);
    let mut c = line.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => "Invalid YAML".into(),
    }
}

/// Character index → UTF-16 offset and line.
struct Positions {
    utf16: Vec<usize>,
    line_starts: Vec<usize>,
}

impl Positions {
    fn new(chars: &[char]) -> Self {
        let mut utf16 = Vec::with_capacity(chars.len() + 1);
        let mut line_starts = vec![0];
        let mut n = 0;
        for (i, c) in chars.iter().enumerate() {
            utf16.push(n);
            n += c.len_utf16();
            if *c == '\n' {
                line_starts.push(i + 1);
            }
        }
        utf16.push(n);
        Positions { utf16, line_starts }
    }

    fn line_of(&self, char_index: usize) -> usize {
        self.line_starts.partition_point(|&s| s <= char_index)
    }
}

#[cfg(test)]
mod tests;
