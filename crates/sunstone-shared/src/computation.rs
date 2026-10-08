//! The Attested Computation contract (OKF v0.2 §10, ov-12): the one Concept
//! type v0.2 adds. A Concept whose `type` is `Attested Computation` carries a
//! sanctioned way to compute a value in five top-level keys:
//!
//! - `runtime`: how to run it (`bigquery`, `python`, …); REQUIRED for the type.
//! - `parameters`: the typed, named holes, each `{ name, type, required }`.
//! - `computation`: a path (§6.2) to a file holding the computation; absent,
//!   the body's `# Computation` fence is the computation.
//! - `executor`: `resource` (run instructions or code) and `receipt` (the
//!   names of the fields a run must return).
//! - `attester`: `resource` (deterministic code that checks a receipt).
//!
//! The ONE reading of these keys for the editor's contract card and the fake
//! render (over wasm, `src/lib/computation.ts`) and the native render
//! (`sunstone-native/src/render/computation.rs`), so every surface shows the
//! same contract (ADR 0006).
//!
//! Sunstone models and displays the contract only. Nothing here (or anywhere)
//! executes, runs or verifies a computation: v0.2 defers the runtime protocol,
//! the receipt and verdict formats and the attester ABI.
//!
//! Reading is permissive (§11): every key is optional here, a key of the wrong
//! shape reads as absent (or as much of it as makes sense), and nothing is
//! ever an error. The language service (`src/lib/okf/families/computation.ts`)
//! is where shape problems are reported.
//!
//! The path-valued fields (`computation`, `executor.resource`,
//! `attester.resource`) are kept as written. They resolve like any in-Bundle
//! link, through [`crate::links::resolve_link`] / [`crate::paths::resolve_location`]:
//! a URL is external, `/x` is bundle-absolute under the detected root, and
//! anything else is relative to the Concept.

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::paths::is_external;

/// The `type` value that marks an Attested Computation (§10.1).
pub const ATTESTED_COMPUTATION: &str = "Attested Computation";

/// One `parameters` entry: a typed, named hole the agent may fill.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parameter {
    /// `name`, as written; `None` when missing or empty.
    pub name: Option<String>,
    /// `type`, as written (its meaning follows `runtime`); `None` when missing.
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// `required`, when it is a boolean; `None` when absent (or not a boolean).
    pub required: Option<bool>,
}

/// How a path-valued field is read: an absolute URL or a path (§6.2).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathKind {
    Url,
    Path,
}

/// A path-valued field (§6.2), as written, with its kind.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathField {
    pub value: String,
    pub kind: PathKind,
}

/// The `executor` block.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Executor {
    /// `executor.resource`: run instructions or code.
    pub resource: Option<PathField>,
    /// `executor.receipt`: the names a run must return, in order. A bare name
    /// written without a list reads as a one-element list.
    pub receipt: Vec<String>,
}

/// The `attester` block.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attester {
    /// `attester.resource`: the deterministic check.
    pub resource: Option<PathField>,
}

/// An Attested Computation's contract (§10.2).
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub runtime: Option<String>,
    /// The `parameters` entries that are maps, in order.
    pub parameters: Vec<Parameter>,
    /// `computation`: a path to the file holding it; `None` means the body's
    /// `# Computation` fence is the computation (§10.3).
    pub computation: Option<PathField>,
    pub executor: Option<Executor>,
    pub attester: Option<Attester>,
}

impl Contract {
    /// Whether the contract carries nothing at all to show.
    pub fn is_empty(&self) -> bool {
        self.runtime.is_none()
            && self.parameters.is_empty()
            && self.computation.is_none()
            && self.executor.is_none()
            && self.attester.is_none()
    }

    /// The path-valued fields that are set, labelled by their key path, in
    /// display order: what resolves like an in-Bundle link.
    pub fn path_fields(&self) -> Vec<(&'static str, &PathField)> {
        let mut out = Vec::new();
        if let Some(c) = &self.computation {
            out.push(("computation", c));
        }
        if let Some(r) = self.executor.as_ref().and_then(|e| e.resource.as_ref()) {
            out.push(("executor.resource", r));
        }
        if let Some(r) = self.attester.as_ref().and_then(|a| a.resource.as_ref()) {
            out.push(("attester.resource", r));
        }
        out
    }
}

/// Whether a `type` value names an Attested Computation (case and surrounding
/// space aside: `type` values are free text, §4.1).
pub fn is_attested_computation_type(ty: &str) -> bool {
    ty.trim().eq_ignore_ascii_case(ATTESTED_COMPUTATION)
}

/// Whether a Frontmatter block (inner YAML, no fences) is an Attested
/// Computation's.
pub fn is_attested_computation(yaml: &str) -> bool {
    match serde_yaml::from_str::<Value>(yaml) {
        Ok(Value::Mapping(map)) => is_ac_map(&map),
        _ => false,
    }
}

fn is_ac_map(map: &Mapping) -> bool {
    map.get(Value::from("type"))
        .and_then(Value::as_str)
        .is_some_and(is_attested_computation_type)
}

/// The contract of a Frontmatter block (inner YAML, no fences), or `None` when
/// the Concept is not an Attested Computation (or the block does not parse).
/// An Attested Computation with none of the contract keys has an empty
/// [`Contract`], never `None`.
pub fn contract(yaml: &str) -> Option<Contract> {
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(yaml) else {
        return None;
    };
    if !is_ac_map(&map) {
        return None;
    }
    let get = |k: &str| map.get(Value::from(k));
    let parameters = match get("parameters") {
        Some(Value::Sequence(items)) => items.iter().filter_map(Value::as_mapping).map(parameter).collect(),
        Some(Value::Mapping(m)) => vec![parameter(m)],
        _ => Vec::new(),
    };
    let executor = get("executor").and_then(Value::as_mapping).map(|m| Executor {
        resource: m.get(Value::from("resource")).and_then(path_field),
        receipt: m.get(Value::from("receipt")).map(names).unwrap_or_default(),
    });
    let attester = get("attester").and_then(Value::as_mapping).map(|m| Attester {
        resource: m.get(Value::from("resource")).and_then(path_field),
    });
    Some(Contract {
        runtime: get("runtime").and_then(scalar),
        parameters,
        computation: get("computation").and_then(path_field),
        executor,
        attester,
    })
}

fn parameter(m: &Mapping) -> Parameter {
    Parameter {
        name: m.get(Value::from("name")).and_then(scalar),
        kind: m.get(Value::from("type")).and_then(scalar),
        required: m.get(Value::from("required")).and_then(Value::as_bool),
    }
}

/// A path-valued field: a non-empty string, classified URL or path.
fn path_field(v: &Value) -> Option<PathField> {
    let value = v.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    let kind = if is_external(value) { PathKind::Url } else { PathKind::Path };
    Some(PathField { value: value.to_string(), kind })
}

/// A list of names (scalars), or a bare scalar as one name.
fn names(v: &Value) -> Vec<String> {
    match v {
        Value::Sequence(items) => items.iter().filter_map(scalar).collect(),
        other => scalar(other).into_iter().collect(),
    }
}

/// A scalar as text (numbers and booleans too), `None` when empty or not one.
fn scalar(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => return None,
    };
    (!s.is_empty()).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle_root::find_bundle_root;
    use crate::links::{resolve_link, ResolvedLink};

    /// The §10.2 example contract.
    const REVENUE: &str = "type: Attested Computation
title: Revenue for fiscal year
status: stable
runtime: bigquery
parameters:
  - { name: year, type: integer, required: true }
executor:
  resource: references/skills/run-on-bq.md
  receipt: [job_id, executed_sql, result]
attester:
  resource: references/attesters/revenue.py
";

    fn path(value: &str) -> PathField {
        PathField { value: value.into(), kind: PathKind::Path }
    }

    #[test]
    fn reads_the_spec_example_contract() {
        let c = contract(REVENUE).expect("an Attested Computation");
        assert_eq!(c.runtime.as_deref(), Some("bigquery"));
        assert_eq!(
            c.parameters,
            vec![Parameter { name: Some("year".into()), kind: Some("integer".into()), required: Some(true) }]
        );
        assert_eq!(c.computation, None);
        assert_eq!(
            c.executor,
            Some(Executor {
                resource: Some(path("references/skills/run-on-bq.md")),
                receipt: vec!["job_id".into(), "executed_sql".into(), "result".into()],
            })
        );
        assert_eq!(c.attester, Some(Attester { resource: Some(path("references/attesters/revenue.py")) }));
    }

    #[test]
    fn only_an_attested_computation_has_a_contract() {
        assert_eq!(contract("type: Metric\nruntime: bigquery\n"), None);
        assert_eq!(contract("title: no type\nruntime: bigquery\n"), None);
        assert_eq!(contract("- not a map\n"), None);
        assert_eq!(contract("type: [\n"), None);
        assert!(contract("type: attested computation\n").is_some());
        assert!(contract("type: '  Attested Computation '\n").is_some());
        assert!(is_attested_computation(REVENUE));
        assert!(!is_attested_computation("type: Playbook\n"));
    }

    #[test]
    fn missing_contract_keys_read_as_an_empty_contract() {
        let c = contract("type: Attested Computation\n").unwrap();
        assert!(c.is_empty());
        assert!(c.path_fields().is_empty());
        let c = contract("type: Attested Computation\nruntime:\nparameters:\nexecutor:\nattester:\n").unwrap();
        assert!(c.is_empty());
    }

    #[test]
    fn parameters_keep_name_and_type_with_required_optional() {
        let c = contract(
            "type: Attested Computation
parameters:
  - name: year
    type: integer
  - { name: region, type: string, required: false }
  - { name: n, type: 3, required: 'yes' }
  - just a string
  - { type: date }
",
        )
        .unwrap();
        assert_eq!(
            c.parameters,
            vec![
                Parameter { name: Some("year".into()), kind: Some("integer".into()), required: None },
                Parameter { name: Some("region".into()), kind: Some("string".into()), required: Some(false) },
                Parameter { name: Some("n".into()), kind: Some("3".into()), required: None },
                Parameter { name: None, kind: Some("date".into()), required: None },
            ]
        );
        // A single map written without the list dash is one entry.
        let c = contract("type: Attested Computation\nparameters: { name: year, type: integer }\n").unwrap();
        assert_eq!(c.parameters.len(), 1);
    }

    #[test]
    fn receipt_is_a_list_of_names() {
        let c = contract("type: Attested Computation\nexecutor:\n  receipt:\n    - job_id\n    - 42\n    - { x: 1 }\n").unwrap();
        let e = c.executor.unwrap();
        assert_eq!(e.receipt, vec!["job_id".to_string(), "42".to_string()]);
        assert_eq!(e.resource, None);
        let c = contract("type: Attested Computation\nexecutor: { receipt: job_id }\n").unwrap();
        assert_eq!(c.executor.unwrap().receipt, vec!["job_id".to_string()]);
    }

    #[test]
    fn path_fields_are_classified_url_or_path() {
        let c = contract(
            "type: Attested Computation
computation: /references/computations/lib/revenue.sql
executor: { resource: 'https://runner.example/run' }
attester: { resource: ../attesters/revenue.py }
",
        )
        .unwrap();
        assert_eq!(
            c.path_fields(),
            vec![
                ("computation", &path("/references/computations/lib/revenue.sql")),
                ("executor.resource", &PathField { value: "https://runner.example/run".into(), kind: PathKind::Url }),
                ("attester.resource", &path("../attesters/revenue.py")),
            ]
        );
        // A non-string (or blank) path is absent, not an error.
        let c = contract("type: Attested Computation\ncomputation: [a]\nattester: { resource: '' }\n").unwrap();
        assert_eq!(c.computation, None);
        assert_eq!(c.attester, Some(Attester { resource: None }));
    }

    /// The path-valued fields resolve through the SAME link resolution as an
    /// in-Bundle link: relative to the Concept, bundle-absolute under the
    /// detected root, a URL external.
    #[test]
    fn path_fields_resolve_like_in_bundle_links() {
        // A Bundle detected at `kb/` (its index.md declares okf_version) inside
        // the opened folder.
        let paths: Vec<String> = [
            "kb/index.md",
            "kb/computations/revenue.md",
            "kb/computations/references/skills/run-on-bq.md",
            "kb/references/skills/shared.md",
            "notes.md",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let markers = vec![crate::bundle_root::OkfMarker { index_path: "kb/index.md".into(), okf_version: "0.2".into() }];
        let root = find_bundle_root(&paths, &markers, None, None);
        assert_eq!(root.dir, "kb");
        let exists = |p: &str| paths.iter().any(|x| x == p);
        let at = "kb/computations/revenue.md";
        let c = contract(
            "type: Attested Computation
computation: https://git.example/revenue.sql
executor: { resource: references/skills/run-on-bq.md }
attester: { resource: /references/skills/shared.md }
",
        )
        .unwrap();
        let resolved: Vec<ResolvedLink> =
            c.path_fields().iter().map(|(_, f)| resolve_link(at, &f.value, &root, exists)).collect();
        assert_eq!(
            resolved,
            vec![
                ResolvedLink::External { href: "https://git.example/revenue.sql".into() },
                ResolvedLink::Internal {
                    path: "kb/computations/references/skills/run-on-bq.md".into(),
                    anchor: None,
                    exists: true,
                },
                ResolvedLink::Internal { path: "kb/references/skills/shared.md".into(), anchor: None, exists: true },
            ]
        );
    }
}
