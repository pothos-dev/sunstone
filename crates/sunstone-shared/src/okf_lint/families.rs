//! The registered OKF key families: the lint's ONLY list of them.
//!
//! To extend a family, add to its `required` keys or `rules`; to add one, write
//! a `Family` and append it to [`FAMILIES`]. The engine (`super`) never changes.
//! Completion stays in TypeScript (`src/lib/okf/families/`): it works on a
//! half-typed block by indentation, not a parse.

use super::tree::{Node, Value};
use super::{pair_range, Ctx, Family, RawFinding, RequiredKey, Rule, Severity};
use crate::computation::is_attested_computation;
use crate::trust::{epoch_seconds, is_iso_datetime};

pub(super) const FAMILIES: &[Family] = &[CORE, PROVENANCE, TRUST, LIFECYCLE, COMPUTATION];

use Severity::{Error, Info, Warning};

fn is_string(node: &Node) -> bool {
    node.str().is_some()
}

fn is_null(node: &Node) -> bool {
    node.scalar() == Some(&Value::Null)
}

// ── core (§4.1): always on ──────────────────────────────────────────────────

const CORE: Family = Family {
    id: "okf",
    keys: &[],
    required: &[RequiredKey { path: &[], key: "type", spec: "§4.1" }],
    rules: &[core_string_keys, core_tags, core_legacy_timestamp],
};

/// `type`, `title`, `description`, `resource` should be text.
fn core_string_keys(ctx: &Ctx) -> Vec<RawFinding> {
    let mut out = Vec::new();
    for key in ["type", "title", "description", "resource"] {
        let Some(p) = ctx.root.pair(key) else { continue };
        // Absent or empty is the REQUIRED check's business (for `type`) or fine.
        if is_null(&p.value) || is_string(&p.value) {
            continue;
        }
        let hint = if p.value.is_scalar() { " (quote it to keep it text)" } else { "" };
        out.push(ctx.at(pair_range(p), Warning, format!("`{key}` should be a string{hint} (OKF §4.1)")));
    }
    out
}

fn core_tags(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("tags") else { return vec![] };
    if is_null(&p.value) || (p.value.is_seq() && p.value.items().iter().all(is_string)) {
        return vec![];
    }
    vec![ctx.at(pair_range(p), Warning, "`tags` should be a list of strings, e.g. `[a, b]` (OKF §4.1)")]
}

/// A v0.1 `timestamp` still reads (as `generated.at`), but v0.2 retired it.
fn core_legacy_timestamp(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("timestamp") else { return vec![] };
    let hint = if ctx.root.pair("generated").is_some() { "drop it" } else { "write `generated: { by, at }` instead" };
    vec![ctx.at(p.key.range, Info, format!("`timestamp` is superseded by `generated.at` in OKF v0.2: {hint} (OKF §13.1)"))]
}

// ── provenance (§5.1): `sources`, `usage_window` ────────────────────────────
//
// REQUIRED: `resource` in every `sources` entry. Everything else is a warning
// or info, and absence is never one. No credibility score is computed: the
// signals are checked for shape only.

const PROVENANCE: Family = Family {
    id: "okf-provenance",
    keys: &["sources", "usage_window"],
    required: &[RequiredKey { path: &["sources", "*"], key: "resource", spec: "§5.1" }],
    rules: &[
        sources_shape,
        sources_entry_text,
        sources_unique_ids,
        sources_usage_count,
        sources_usage_windows,
        sources_last_modified,
        sources_unframed_counts,
    ],
};

const DATETIME_HINT: &str = "an ISO 8601 datetime with a UTC offset, e.g. `2026-06-30T14:00:00Z` (OKF §5)";

/// The entries of `sources` that are maps, when `sources` is a list.
fn source_entries<'a>(ctx: &Ctx<'a>) -> Vec<&'a Node> {
    ctx.root.pair("sources").map_or(vec![], |p| p.value.items().iter().filter(|n| n.is_map()).collect())
}

fn sources_shape(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("sources") else { return vec![] };
    if p.value.is_empty_value() {
        return vec![];
    }
    if !p.value.is_seq() {
        return vec![ctx.at(
            pair_range(p),
            Warning,
            "`sources` should be a list of entries, each with a `resource` (OKF §5.1)",
        )];
    }
    p.value
        .items()
        .iter()
        .filter(|item| !item.is_map() && !item.is_empty_value())
        .map(|item| {
            ctx.at(
                item.range,
                Warning,
                "A `sources` entry should be a map with a `resource`, e.g. `- resource: https://…` (OKF §5.1)",
            )
        })
        .collect()
}

fn sources_entry_text(ctx: &Ctx) -> Vec<RawFinding> {
    let mut out = Vec::new();
    for entry in source_entries(ctx) {
        for key in ["resource", "id", "title", "author"] {
            let Some(p) = entry.pair(key) else { continue };
            if p.value.is_empty_value() || p.value.is_scalar() {
                continue;
            }
            out.push(ctx.at(pair_range(p), Warning, format!("`{key}` in a `sources` entry should be text (OKF §5.1)")));
        }
    }
    out
}

/// A scalar's text as written (numbers and booleans as their source).
fn scalar_text(ctx: &Ctx, node: &Node) -> String {
    match node.scalar() {
        Some(Value::Str(s)) => s.clone(),
        _ => ctx.yaml.chars().skip(node.range.0).take(node.range.1 - node.range.0).collect(),
    }
}

fn sources_unique_ids(ctx: &Ctx) -> Vec<RawFinding> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in source_entries(ctx) {
        let Some(p) = entry.pair("id") else { continue };
        if !p.value.is_scalar() || p.value.is_empty_value() {
            continue;
        }
        let id = scalar_text(ctx, &p.value).to_lowercase();
        if seen.contains(&id) {
            out.push(ctx.at(
                p.value.range,
                Warning,
                format!("Duplicate source id `{id}`: a citation `[^{id}]` resolves to the first entry with it (OKF §5.1)"),
            ));
        }
        seen.insert(id);
    }
    out
}

fn sources_usage_count(ctx: &Ctx) -> Vec<RawFinding> {
    let mut out = Vec::new();
    for entry in source_entries(ctx) {
        let Some(p) = entry.pair("usage_count") else { continue };
        if p.value.is_empty_value() {
            continue;
        }
        if matches!(p.value.scalar(), Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 0.0) {
            continue;
        }
        out.push(ctx.at(
            pair_range(p),
            Warning,
            "`usage_count` should be a whole number of exercises, e.g. `5000` (OKF §5.1)",
        ));
    }
    out
}

/// A datetime-valued scalar that is not ISO 8601 with an offset.
fn datetime(ctx: &Ctx, node: &Node, key: &str) -> Vec<RawFinding> {
    if node.is_empty_value() || node.str().is_some_and(|s| is_iso_datetime(s.trim())) {
        return vec![];
    }
    vec![ctx.at(node.range, Warning, format!("`{key}` should be {DATETIME_HINT}"))]
}

/// One `usage_window` value: a `{ from, to }` map, in order.
fn window_findings(ctx: &Ctx, node: &Node) -> Vec<RawFinding> {
    if node.is_empty_value() {
        return vec![];
    }
    if !node.is_map() {
        return vec![ctx.at(node.range, Warning, "`usage_window` should be a `{ from, to }` datetime range (OKF §5.1)")];
    }
    let from = node.pair("from");
    let to = node.pair("to");
    let mut out = Vec::new();
    if let Some(p) = from {
        out.extend(datetime(ctx, &p.value, "usage_window.from"));
    }
    if let Some(p) = to {
        out.extend(datetime(ctx, &p.value, "usage_window.to"));
    }
    if out.is_empty() {
        let epoch = |p: Option<&super::Pair>| p.and_then(|p| p.value.str()).and_then(epoch_seconds);
        if let (Some(a), Some(b)) = (epoch(from), epoch(to)) {
            if a > b {
                out.push(ctx.at(node.range, Warning, "`usage_window.from` is after `usage_window.to`"));
            }
        }
    }
    out
}

fn sources_usage_windows(ctx: &Ctx) -> Vec<RawFinding> {
    let mut out = Vec::new();
    if let Some(top) = ctx.root.pair("usage_window") {
        out.extend(window_findings(ctx, &top.value));
    }
    for entry in source_entries(ctx) {
        if let Some(p) = entry.pair("usage_window") {
            out.extend(window_findings(ctx, &p.value));
        }
    }
    out
}

fn sources_last_modified(ctx: &Ctx) -> Vec<RawFinding> {
    source_entries(ctx)
        .into_iter()
        .filter_map(|entry| entry.pair("last_modified"))
        .flat_map(|p| datetime(ctx, &p.value, "last_modified"))
        .collect()
}

fn sources_unframed_counts(ctx: &Ctx) -> Vec<RawFinding> {
    if ctx.root.pair("usage_window").is_some_and(|p| !p.value.is_empty_value()) {
        return vec![];
    }
    let mut out = Vec::new();
    for entry in source_entries(ctx) {
        let Some(count) = entry.pair("usage_count") else { continue };
        let framed = entry.pair("usage_window").is_some_and(|p| !p.value.is_empty_value());
        if count.value.is_empty_value() || framed {
            continue;
        }
        out.push(ctx.at(
            count.key.range,
            Info,
            "`usage_count` has no `usage_window` to frame it: add `usage_window: { from, to }` beside `sources` or on this entry (OKF §5.1)",
        ));
    }
    out
}

// ── trust (§5.2): `generated`, `verified` ───────────────────────────────────

const TRUST: Family = Family {
    id: "okf-trust",
    keys: &["generated", "verified"],
    required: &[RequiredKey { path: &["generated"], key: "by", spec: "§5.2" }],
    rules: &[trust_generated_shape, trust_verified_shape, trust_iso_at],
};

const ISO_HINT: &str = "an ISO 8601 datetime with a UTC offset, e.g. `2026-06-30T14:00:00Z` (OKF §5.2)";

/// Each `{ by, at }` map of the trust keys, with the range to blame.
fn stamps<'a>(ctx: &Ctx<'a>) -> Vec<(&'a Node, super::tree::Range)> {
    let mut out = Vec::new();
    // A bare `verified` mapping is a one-element list (§5.2).
    for path in [&["generated"][..], &["verified"], &["verified", "*"]] {
        for l in ctx.nodes_at(path) {
            if let Some(node) = l.node.filter(|n| n.is_map()) {
                out.push((node, l.anchor));
            }
        }
    }
    out
}

/// An `at` that is not ISO 8601 with an offset: shown as written, but warned.
fn trust_iso_at(ctx: &Ctx) -> Vec<RawFinding> {
    let mut out = Vec::new();
    for (map, _) in stamps(ctx) {
        let Some(p) = map.pair("at") else { continue };
        if p.value.is_empty_value() || p.value.str().is_some_and(is_iso_datetime) {
            continue;
        }
        out.push(ctx.at(pair_range(p), Warning, format!("`at` should be {ISO_HINT}")));
    }
    out
}

fn trust_generated_shape(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("generated") else { return vec![] };
    // Empty is the REQUIRED `by` check's business.
    if p.value.is_empty_value() || p.value.is_map() {
        return vec![];
    }
    vec![ctx.at(pair_range(p), Warning, "`generated` should be a mapping `{ by, at }` (OKF §5.2)")]
}

fn trust_verified_shape(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("verified") else { return vec![] };
    if p.value.is_empty_value() {
        return vec![];
    }
    if !p.value.is_map() && !p.value.is_seq() {
        return vec![ctx.at(pair_range(p), Warning, "`verified` should be a list of `{ by, at }` events (OKF §5.2)")];
    }
    let mut out = Vec::new();
    for l in ctx.nodes_at(&["verified", "*"]) {
        if !l.node.is_some_and(Node::is_map) {
            out.push(ctx.at(l.anchor, Warning, "A verification event should be a mapping `{ by, at }` (OKF §5.2)"));
        }
    }
    let events: Vec<_> = if p.value.is_map() {
        ctx.nodes_at(&["verified"])
    } else {
        ctx.nodes_at(&["verified", "*"]).into_iter().filter(|l| l.node.is_some_and(Node::is_map)).collect()
    };
    for l in events {
        let Some(map) = l.node else { continue };
        for (key, what) in [("by", "who confirmed it"), ("at", "when")] {
            let kp = map.pair(key);
            if kp.is_none_or(|kp| kp.value.is_empty_value()) {
                out.push(ctx.at(
                    kp.map_or(l.anchor, pair_range),
                    Warning,
                    format!("A verification event should say {what}: `{key}` (OKF §5.2)"),
                ));
            }
        }
    }
    out
}

// ── lifecycle (§5.4, §5.5): `status`, `stale_after` ─────────────────────────
//
// A past `stale_after` is never a finding: staleness is an advisory display
// signal, not a defect.

const LIFECYCLE: Family = Family {
    id: "okf-lifecycle",
    keys: &["status", "stale_after"],
    required: &[],
    rules: &[lifecycle_status, lifecycle_stale_after],
};

/// Where a finding about `pair`'s value goes: the value, or the key line when empty.
fn value_range(ctx: &Ctx, p: &super::Pair) -> super::tree::Range {
    if is_null(&p.value) {
        ctx.line_from(p.key.range.0)
    } else {
        p.value.range
    }
}

fn lifecycle_status(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("status") else { return vec![] };
    if p.value.str().is_some_and(|s| matches!(s, "draft" | "stable" | "deprecated")) {
        return vec![];
    }
    vec![ctx.at(value_range(ctx, p), Error, "`status` must be one of `draft`, `stable`, `deprecated` (OKF §5.4)")]
}

fn lifecycle_stale_after(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("stale_after") else { return vec![] };
    let raw = p.value.str();
    if raw.is_some_and(is_iso_datetime) {
        return vec![];
    }
    let message = if raw.is_some_and(is_offsetless_instant) {
        "`stale_after` has no UTC offset; it is read as UTC. Write it with one, e.g. `2026-09-23T00:00:00Z` (OKF §5.5)"
    } else {
        "`stale_after` should be an ISO 8601 datetime, e.g. `2026-09-23T00:00:00Z` (OKF §5.5)"
    };
    vec![ctx.at(value_range(ctx, p), Warning, message)]
}

/// An ISO 8601 date or datetime written without a UTC offset (`2026-09-23`,
/// `2026-09-23T00:00:00`), which `src/lib/instant.ts` reads as UTC.
fn is_offsetless_instant(s: &str) -> bool {
    let s = s.trim();
    if s.len() == 10 {
        return epoch_seconds(&format!("{s}T00:00Z")).is_some();
    }
    let t = s.replacen(' ', "T", 1);
    epoch_seconds(&format!("{t}Z")).is_some()
}

// ── computation (§10): the Attested Computation contract ────────────────────
//
// Opts in on `type`, not on a contract key: a computation with none of the
// contract keys still lacks `runtime`, and a Concept of another type may use
// `runtime` or `parameters` as an unrelated extension key (§4.1). Every rule
// is guarded by `is_attested_computation`, the reading the card uses.

const COMPUTATION: Family = Family {
    id: "okf-computation",
    keys: &["type"],
    required: &[],
    rules: &[computation_rules],
};

const PATH_HINT: &str = "a URL, a bundle path (`/…`) or a relative path (OKF §6.2)";

fn computation_rules(ctx: &Ctx) -> Vec<RawFinding> {
    if !is_attested_computation(ctx.yaml) {
        return vec![];
    }
    let rules: [Rule; 6] = [
        computation_runtime,
        computation_parameters,
        |ctx| path_text(ctx, ctx.root, "computation", "computation"),
        |ctx| endpoint(ctx, "executor", "executor: { resource: references/run.md, receipt: [job_id] }"),
        |ctx| endpoint(ctx, "attester", "attester: { resource: references/attest.py }"),
        computation_receipt,
    ];
    rules.iter().flat_map(|rule| rule(ctx)).collect()
}

fn computation_runtime(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("runtime") else {
        let at = ctx.root.pair("type").map_or((0, 0), |t| t.key.range);
        return vec![ctx.at(
            at,
            Error,
            "Missing required key `runtime` for an Attested Computation, e.g. `runtime: bigquery` (OKF §10.2)",
        )];
    };
    if p.value.is_empty_value() {
        return vec![ctx.at(pair_range(p), Error, "`runtime` is required but empty (OKF §10.2)")];
    }
    if !p.value.is_scalar() {
        return vec![ctx.at(pair_range(p), Warning, "`runtime` should be text, e.g. `bigquery` (OKF §10.2)")];
    }
    vec![]
}

/// A path-valued field (§6.2) that is set but is not text.
fn path_text(ctx: &Ctx, map: &Node, key: &str, label: &str) -> Vec<RawFinding> {
    let Some(p) = map.pair(key) else { return vec![] };
    if p.value.is_empty_value() || is_string(&p.value) {
        return vec![];
    }
    vec![ctx.at(pair_range(p), Warning, format!("`{label}` should be {PATH_HINT}"))]
}

fn computation_parameters(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair("parameters") else { return vec![] };
    if p.value.is_empty_value() {
        return vec![];
    }
    if !p.value.is_seq() {
        return vec![ctx.at(
            pair_range(p),
            Warning,
            "`parameters` should be a list of `{ name, type, required }` entries (OKF §10.2)",
        )];
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in p.value.items() {
        if item.is_empty_value() {
            continue;
        }
        let range = item.range;
        if !item.is_map() {
            out.push(ctx.at(range, Warning, "A parameter should be a map, e.g. `- { name: year, type: integer }` (OKF §10.2)"));
            continue;
        }
        for key in ["name", "type"] {
            match item.pair(key) {
                Some(kp) if !kp.value.is_empty_value() => {
                    if !kp.value.is_scalar() {
                        out.push(ctx.at(pair_range(kp), Warning, format!("A parameter's `{key}` should be text (OKF §10.2)")));
                    }
                }
                _ => out.push(ctx.at(range, Warning, format!("A parameter should have a `{key}` (OKF §10.2)"))),
            }
        }
        if let Some(req) = item.pair("required") {
            if !req.value.is_empty_value() && !matches!(req.value.scalar(), Some(Value::Bool(_))) {
                out.push(ctx.at(pair_range(req), Warning, "A parameter's `required` should be `true` or `false` (OKF §10.2)"));
            }
        }
        if let Some(name) = item.pair("name") {
            if name.value.is_scalar() && !name.value.is_empty_value() {
                let n = scalar_text(ctx, &name.value);
                if seen.contains(&n) {
                    out.push(ctx.at(name.value.range, Warning, format!("Duplicate parameter name `{n}` (OKF §10.2)")));
                }
                seen.insert(n);
            }
        }
    }
    out
}

/// `executor` / `attester`: a map whose `resource` is a path.
fn endpoint(ctx: &Ctx, key: &str, example: &str) -> Vec<RawFinding> {
    let Some(p) = ctx.root.pair(key) else { return vec![] };
    if p.value.is_empty_value() {
        return vec![];
    }
    if !p.value.is_map() {
        return vec![ctx.at(pair_range(p), Warning, format!("`{key}` should be a map, e.g. `{example}` (OKF §10.2)"))];
    }
    path_text(ctx, &p.value, "resource", &format!("{key}.resource"))
}

fn computation_receipt(ctx: &Ctx) -> Vec<RawFinding> {
    let Some(e) = ctx.root.pair("executor").filter(|e| e.value.is_map()) else { return vec![] };
    let Some(p) = e.value.pair("receipt") else { return vec![] };
    if p.value.is_empty_value() {
        return vec![];
    }
    let ok = p.value.is_seq() && p.value.items().iter().all(|n| n.is_scalar() && !n.is_empty_value());
    if ok {
        return vec![];
    }
    vec![ctx.at(
        pair_range(p),
        Warning,
        "`executor.receipt` should be a list of names, e.g. `[job_id, executed_sql, result]` (OKF §10.2)",
    )]
}
