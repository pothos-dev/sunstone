//! The OKF actor convention (v0.2 §7): the ONE reading of an identity-valued
//! field (`generated.by`, `verified[].by`, a source's `author`).
//!
//! - `human:<id>` — a person. The only kind trust classification (§5.3) keys
//!   off: [`Actor::is_human`].
//! - `process:<id>` — an automated process.
//! - `<producer>/<version>` — an agent or tool, split at the LAST `/` so a
//!   producer may itself contain slashes (`org/agent/1.2` → `org/agent`, `1.2`).
//! - Anything else — an empty string, a prefix the spec does not model
//!   (`team:analytics`, used by the spec's own `sources` example), a prefix with
//!   no id (`human:`), free text — is [`ActorKind::Unknown`] and is shown as the
//!   raw string. Parsing never fails, so no consumer can reject a Concept over
//!   an actor.
//!
//! Prefixes match case-sensitively, as written in the spec: `Human:x` is not a
//! person. `raw` always carries the input unchanged, so a re-serialised actor
//! round-trips byte for byte whatever its kind.

use serde::{Deserialize, Serialize};

/// What produced or confirmed something.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActorKind {
    /// `human:<id>` — a person.
    Human,
    /// `process:<id>` — an automated process.
    Process,
    /// `<producer>/<version>` — an agent or tool.
    Agent,
    /// Not one of the documented forms; display `raw`.
    Unknown,
}

/// A parsed actor string.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub kind: ActorKind,
    /// The person's or process's id, the agent's producer, or — for
    /// [`ActorKind::Unknown`] — the raw string.
    pub id: String,
    /// The agent's version; `None` for every other kind.
    pub version: Option<String>,
    /// The input, unchanged.
    pub raw: String,
}

impl Actor {
    /// Whether this is a `human:` actor — the trust-tier test (§5.3).
    pub fn is_human(&self) -> bool {
        self.kind == ActorKind::Human
    }
}

impl std::fmt::Display for Actor {
    /// The raw string: an actor round-trips unchanged.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.raw)
    }
}

/// Parse an actor string. Never fails; see the module docs for the forms.
pub fn parse_actor(raw: &str) -> Actor {
    let unknown = || Actor {
        kind: ActorKind::Unknown,
        id: raw.to_string(),
        version: None,
        raw: raw.to_string(),
    };
    let s = raw.trim();
    if s.is_empty() {
        return unknown();
    }
    if let Some((prefix, rest)) = s.split_once(':') {
        if is_prefix(prefix) {
            let kind = match prefix {
                "human" => ActorKind::Human,
                "process" => ActorKind::Process,
                _ => return unknown(),
            };
            let id = rest.trim();
            if id.is_empty() {
                return unknown();
            }
            return Actor { kind, id: id.to_string(), version: None, raw: raw.to_string() };
        }
    }
    if !s.contains(':') && !s.contains(char::is_whitespace) {
        if let Some((producer, version)) = s.rsplit_once('/') {
            if !producer.is_empty() && !version.is_empty() {
                return Actor {
                    kind: ActorKind::Agent,
                    id: producer.to_string(),
                    version: Some(version.to_string()),
                    raw: raw.to_string(),
                };
            }
        }
    }
    unknown()
}

/// A scheme-like prefix: a letter, then letters, digits, `-` or `_`.
fn is_prefix(p: &str) -> bool {
    let mut chars = p.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(s: &str) -> ActorKind {
        parse_actor(s).kind
    }

    #[test]
    fn human() {
        let a = parse_actor("human:ahormati");
        assert_eq!(a.kind, ActorKind::Human);
        assert_eq!(a.id, "ahormati");
        assert_eq!(a.version, None);
        assert!(a.is_human());
    }

    #[test]
    fn process() {
        let a = parse_actor("process:finance-nightly");
        assert_eq!(a.kind, ActorKind::Process);
        assert_eq!(a.id, "finance-nightly");
        assert!(!a.is_human());
    }

    #[test]
    fn agent() {
        let a = parse_actor("reference_agent/gemini-2.5-pro");
        assert_eq!(a.kind, ActorKind::Agent);
        assert_eq!(a.id, "reference_agent");
        assert_eq!(a.version.as_deref(), Some("gemini-2.5-pro"));
        assert!(!a.is_human());
    }

    #[test]
    fn agent_splits_at_last_slash() {
        let a = parse_actor("acme/llm-wiki/1.2.0");
        assert_eq!((a.id.as_str(), a.version.as_deref()), ("acme/llm-wiki", Some("1.2.0")));
    }

    #[test]
    fn prefixed_id_may_contain_slashes_and_colons() {
        let a = parse_actor("human:dept/ada:lovelace");
        assert_eq!(a.kind, ActorKind::Human);
        assert_eq!(a.id, "dept/ada:lovelace");
    }

    #[test]
    fn surrounding_whitespace_is_tolerated_and_raw_kept() {
        let a = parse_actor("  human: dan ");
        assert_eq!(a.kind, ActorKind::Human);
        assert_eq!(a.id, "dan");
        assert_eq!(a.raw, "  human: dan ");
    }

    #[test]
    fn unknown_prefix_round_trips_unchanged() {
        for s in ["team:analytics", "team:ops/v1", "https://example.com/bot/1"] {
            let a = parse_actor(s);
            assert_eq!(a.kind, ActorKind::Unknown, "{s}");
            assert_eq!(a.id, s);
            assert_eq!(a.raw, s);
            assert_eq!(a.to_string(), s);
        }
    }

    #[test]
    fn prefixes_are_case_sensitive() {
        assert_eq!(kind("Human:dan"), ActorKind::Unknown);
        assert_eq!(kind("PROCESS:x"), ActorKind::Unknown);
    }

    #[test]
    fn malformed_degrades_to_unknown() {
        for s in [
            "", "   ", "human:", "human:  ", "process:", "dan", "Daniel Allmer", "/1.0",
            "agent/", "/", "my agent/1.0", ":x",
        ] {
            let a = parse_actor(s);
            assert_eq!(a.kind, ActorKind::Unknown, "{s:?}");
            assert_eq!(a.raw, s);
            assert!(!a.is_human());
        }
    }

    #[test]
    fn every_kind_round_trips() {
        for s in ["human:a", "process:b", "x/1", "team:c", ""] {
            assert_eq!(parse_actor(s).to_string(), s);
        }
    }
}
