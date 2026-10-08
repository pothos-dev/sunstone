//! The trust family (OKF v0.2 §5.2, §5.3): `generated`, `verified` and the
//! derived trust tier, as the reader-facing trust line reads them.
//!
//! The ONE reading of these keys for the editor's trust line and the fake
//! render (over wasm, `src/lib/trust.ts`) and the native render
//! (`sunstone-native/src/render/trust.rs`), so every surface derives the same
//! tier from the same events (ADR 0006).
//!
//! - `verified` is a list of `{ by, at }` events. A bare `{ by, at }` mapping
//!   written without the list dash is a one-element list (§5.2, a MUST).
//! - The tier is derived from `verified` alone, never stored: no `verified` key
//!   (or no events in it) is unverified, events by non-`human:` actors only are
//!   machine-confirmed, any `human:` actor ([`Actor::is_human`]) is
//!   human-reviewed (§5.3).
//! - A `generated` block without `by` is kept, with `by: None`, so the reader
//!   sees it degrade instead of losing it. A `generated` that is not a mapping
//!   reads the same way.
//! - Legacy v0.1 `timestamp` stands in for `generated.at` when `generated` is
//!   absent (§13.1), flagged `legacy`.
//! - Datetimes are kept as written. [`is_iso_datetime`] says whether one is an
//!   ISO 8601 datetime with an explicit UTC offset, the form the spec requires
//!   (§5); any other value is still shown, never rejected.
//!
//! [`Actor::is_human`]: crate::actor::Actor::is_human

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::actor::parse_actor;

/// The derived trust tier (§5.3), lowest to highest.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrustTier {
    Unverified,
    MachineConfirmed,
    HumanReviewed,
}

/// One `{ by, at }`: the `generated` block or a verification event.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    /// The actor (§7), as written; `None` when missing or empty.
    pub by: Option<String>,
    /// The datetime, as written; `None` when missing or empty.
    pub at: Option<String>,
    /// Whether `at` is ISO 8601 with an explicit UTC offset.
    pub iso: bool,
}

/// A Concept's trust Frontmatter.
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trust {
    /// `generated`, or a legacy `timestamp` as its `at` (see `legacy`).
    pub generated: Option<Stamp>,
    /// `generated` is the legacy v0.1 `timestamp`, not a `generated` block.
    pub legacy: bool,
    /// The verification events, a bare mapping normalised to one.
    pub verified: Vec<Stamp>,
    /// The derived tier.
    pub tier: TrustTier,
    /// The most recent event's `at`, as written ("how recently", §5.2).
    pub last_verified: Option<String>,
    /// Whether the Concept carries `generated` or `verified` (not just a
    /// legacy `timestamp`): the trust line then shows the tier.
    pub trust_keys: bool,
}

/// The trust Frontmatter of a block (the inner YAML, without `---` fences), or
/// `None` when it carries none of `generated`, `verified`, `timestamp` (or does
/// not parse). `verified: []` and `verified:` read as no events: unverified.
pub fn trust(yaml: &str) -> Option<Trust> {
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(yaml) else {
        return None;
    };
    let generated_v = map.get(Value::from("generated"));
    let verified_v = map.get(Value::from("verified"));
    let timestamp = map.get(Value::from("timestamp")).and_then(scalar);
    if generated_v.is_none() && verified_v.is_none() && timestamp.is_none() {
        return None;
    }

    let (generated, legacy) = match generated_v {
        Some(v) => (Some(stamp(v.as_mapping())), false),
        None => match timestamp {
            Some(at) => (Some(stamp_of(None, Some(at))), true),
            None => (None, false),
        },
    };
    let verified = verified_v.map(verification_events).unwrap_or_default();
    let tier = trust_tier(&verified);
    let last_verified = latest(&verified);
    let trust_keys = generated_v.is_some() || verified_v.is_some();
    Some(Trust { generated, legacy, verified, tier, last_verified, trust_keys })
}

/// The verification events of a `verified` value: a list of mappings, or a
/// bare mapping as a one-element list. Items that are not mappings are
/// skipped; a scalar or null `verified` has no events.
pub fn verification_events(v: &Value) -> Vec<Stamp> {
    match v {
        Value::Mapping(m) => vec![stamp(Some(m))],
        Value::Sequence(items) => items.iter().filter_map(Value::as_mapping).map(|m| stamp(Some(m))).collect(),
        _ => Vec::new(),
    }
}

/// The tier `verified` earns (§5.3): derived from the events alone.
pub fn trust_tier(verified: &[Stamp]) -> TrustTier {
    if verified.is_empty() {
        TrustTier::Unverified
    } else if verified.iter().any(|s| s.by.as_deref().is_some_and(|b| parse_actor(b).is_human())) {
        TrustTier::HumanReviewed
    } else {
        TrustTier::MachineConfirmed
    }
}

/// Whether `s` is an ISO 8601 datetime with an explicit UTC offset:
/// `YYYY-MM-DDTHH:MM[:SS[.fff]]` then `Z` or `±HH:MM` (also `±HHMM`, `±HH`).
pub fn is_iso_datetime(s: &str) -> bool {
    epoch_seconds(s).is_some()
}

/// `s` as seconds since the Unix epoch, when it is [`is_iso_datetime`].
pub fn epoch_seconds(s: &str) -> Option<i64> {
    let b = s.trim().as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let at = |i: usize, c: u8| b.get(i) == Some(&c);
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if !(at(4, b'-') && at(7, b'-') && (at(10, b'T') || at(10, b't'))) {
        return None;
    }
    let (hour, minute) = (num(11, 2)?, num(14, 2)?);
    if !at(13, b':') {
        return None;
    }
    let mut i = 16;
    let mut second = 0;
    if at(i, b':') {
        second = num(i + 1, 2)?;
        i += 3;
        if at(i, b'.') || at(i, b',') {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return None;
            }
        }
    }
    let offset = match b.get(i)? {
        b'Z' | b'z' if i + 1 == b.len() => 0,
        sign @ (b'+' | b'-') => {
            let oh = num(i + 1, 2)?;
            let om = match b.len() - (i + 3) {
                0 => 0,
                2 => num(i + 3, 2)?,
                3 if at(i + 3, b':') => num(i + 4, 2)?,
                _ => return None,
            };
            if oh > 23 || om > 59 {
                return None;
            }
            let o = oh * 3600 + om * 60;
            if *sign == b'-' { -o } else { o }
        }
        _ => return None,
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&month) || day < 1 || day > days_in[(month - 1) as usize] {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The latest event's `at`: by instant among the ISO ones, else the last
/// non-empty one written.
fn latest(verified: &[Stamp]) -> Option<String> {
    verified
        .iter()
        .filter_map(|s| s.at.as_ref().and_then(|a| epoch_seconds(a).map(|t| (t, a))))
        .max_by_key(|(t, _)| *t)
        .map(|(_, a)| a.clone())
        .or_else(|| verified.iter().rev().find_map(|s| s.at.clone()))
}

fn stamp(m: Option<&Mapping>) -> Stamp {
    let field = |k: &str| m.and_then(|m| m.get(Value::from(k))).and_then(scalar);
    stamp_of(field("by"), field("at"))
}

fn stamp_of(by: Option<String>, at: Option<String>) -> Stamp {
    let iso = at.as_deref().is_some_and(is_iso_datetime);
    Stamp { by, at, iso }
}

/// A non-empty YAML scalar as text; `None` for null, empty, maps and lists.
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

    fn t(yaml: &str) -> Trust {
        trust(yaml).expect("trust keys present")
    }

    #[test]
    fn none_without_trust_keys() {
        assert_eq!(trust("type: x\ntitle: y\n"), None);
        assert_eq!(trust(""), None);
        assert_eq!(trust("type: [unclosed\n"), None);
    }

    #[test]
    fn generated_reads_by_and_at() {
        let tr = t("generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }\n");
        let g = tr.generated.clone().unwrap();
        assert_eq!(g.by.as_deref(), Some("reference_agent/gemini-2.5-pro"));
        assert_eq!(g.at.as_deref(), Some("2026-06-20T22:53:05Z"));
        assert!(g.iso);
        assert!(!tr.legacy);
        assert_eq!(tr.tier, TrustTier::Unverified);
        assert!(tr.trust_keys);
    }

    #[test]
    fn generated_without_by_degrades_rather_than_drops() {
        let g = t("generated:\n  at: 2026-06-20T22:53:05Z\n").generated.unwrap();
        assert_eq!(g.by, None);
        assert_eq!(g.at.as_deref(), Some("2026-06-20T22:53:05Z"));
        // Empty and non-mapping blocks are kept too.
        assert_eq!(t("generated:\n").generated, Some(Stamp { by: None, at: None, iso: false }));
        assert_eq!(t("generated: agent/1\n").generated.unwrap().by, None);
        assert_eq!(t("generated: { by: '', at: x }\n").generated.unwrap().by, None);
    }

    #[test]
    fn tiers_derive_from_verified_alone() {
        assert_eq!(t("generated: { by: human:a }\n").tier, TrustTier::Unverified);
        assert_eq!(t("verified: []\n").tier, TrustTier::Unverified);
        assert_eq!(t("verified:\n").tier, TrustTier::Unverified);
        assert_eq!(
            t("verified:\n  - { by: process:nightly, at: 2026-06-26T02:00:00Z }\n  - { by: agent/1 }\n").tier,
            TrustTier::MachineConfirmed
        );
        assert_eq!(
            t("verified:\n  - { by: process:nightly }\n  - { by: human:ahormati }\n").tier,
            TrustTier::HumanReviewed
        );
        // Case-sensitive prefix, and an event without `by`, are not human.
        assert_eq!(t("verified:\n  - { by: Human:x }\n  - { at: 2026-01-01T00:00:00Z }\n").tier, TrustTier::MachineConfirmed);
        // `generated.by` being human does not lift the tier.
        assert_eq!(t("generated: { by: human:a }\nverified: [{ by: process:p }]\n").tier, TrustTier::MachineConfirmed);
    }

    #[test]
    fn bare_verified_mapping_is_a_one_element_list() {
        let tr = t("verified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n");
        assert_eq!(tr.verified.len(), 1);
        assert_eq!(tr.verified[0].by.as_deref(), Some("human:ahormati"));
        assert_eq!(tr.tier, TrustTier::HumanReviewed);
        let block = t("verified:\n  by: process:p\n  at: 2026-06-25T09:00:00Z\n");
        assert_eq!(block.verified.len(), 1);
        assert_eq!(block.tier, TrustTier::MachineConfirmed);
        // Non-mapping items are skipped; a scalar `verified` has no events.
        assert_eq!(t("verified:\n  - human:x\n  - { by: process:p }\n").verified.len(), 1);
        assert_eq!(t("verified: human:x\n").tier, TrustTier::Unverified);
    }

    #[test]
    fn last_verified_is_the_latest_instant() {
        let tr = t(concat!(
            "verified:\n",
            "  - { by: human:a, at: 2026-06-26T01:00:00+02:00 }\n",
            "  - { by: process:p, at: 2026-06-25T23:30:00Z }\n",
            "  - { by: process:q, at: someday }\n",
        ));
        assert_eq!(tr.last_verified.as_deref(), Some("2026-06-25T23:30:00Z"));
        assert_eq!(t("verified: [{ by: a/1, at: later }]\n").last_verified.as_deref(), Some("later"));
        assert_eq!(t("verified: [{ by: a/1 }]\n").last_verified, None);
    }

    #[test]
    fn legacy_timestamp_stands_in_for_generated_at() {
        let tr = t("type: x\ntimestamp: '2026-05-28T22:53:05+00:00'\n");
        assert!(tr.legacy);
        let g = tr.generated.clone().unwrap();
        assert_eq!(g.at.as_deref(), Some("2026-05-28T22:53:05+00:00"));
        assert_eq!(g.by, None);
        assert!(g.iso);
        assert!(!tr.trust_keys);
        // `generated` wins over a legacy `timestamp`.
        let both = t("timestamp: 2020-01-01T00:00:00Z\ngenerated: { by: a/1, at: 2026-01-01T00:00:00Z }\n");
        assert!(!both.legacy);
        assert_eq!(both.generated.unwrap().at.as_deref(), Some("2026-01-01T00:00:00Z"));
        // A legacy timestamp alongside `verified` still has trust keys.
        assert!(t("timestamp: 2020-01-01\nverified: []\n").trust_keys);
    }

    #[test]
    fn non_iso_at_is_kept_as_written() {
        let g = t("generated: { by: a/1, at: 2026-06-20 }\n").generated.unwrap();
        assert_eq!(g.at.as_deref(), Some("2026-06-20"));
        assert!(!g.iso);
    }

    #[test]
    fn iso_datetimes() {
        for ok in [
            "2026-06-20T22:53:05Z",
            "2026-06-20T22:53Z",
            "2026-06-20T22:53:05.123Z",
            "2026-06-20T22:53:05+00:00",
            "2026-06-20T22:53:05-0530",
            "2026-06-20T22:53:05+02",
            "2024-02-29T00:00:00Z",
        ] {
            assert!(is_iso_datetime(ok), "{ok}");
        }
        for bad in [
            "",
            "2026-06-20",
            "2026-06-20T22:53:05",
            "2026-06-20 22:53:05Z",
            "2026-13-01T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-06-20T24:00:00Z",
            "2026-06-20T22:53:05.Z",
            "2026-06-20T22:53:05+2",
            "2026-06-20T22:53:05Zjunk",
            "yesterday",
        ] {
            assert!(!is_iso_datetime(bad), "{bad}");
        }
    }

    #[test]
    fn epoch_seconds_honours_the_offset() {
        assert_eq!(epoch_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_seconds("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(epoch_seconds("2000-03-01T00:00:00Z"), Some(951_868_800));
    }
}
