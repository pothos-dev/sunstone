//! The trust line (OKF v0.2 §5.2, §5.3, ov-9): who wrote the Concept, who
//! confirmed it and how recently, with the derived trust tier first. Rendered
//! above the body; it exists only in the render, never in the file.
//!
//! The reading of the keys is `sunstone_shared::trust`; this module only
//! builds the markup, which is the same markup as the editor's and the fake's
//! (`src/lib/trust.ts`, which asserts the same goldens). Actors use the
//! `.actor*` shape of `src/lib/actor.ts` through `sunstone_shared::actor`.

use sunstone_shared::actor::{parse_actor, ActorKind};
use sunstone_shared::trust::{trust, Trust, TrustTier};

use super::attr_escape;

/// The trust line for a Frontmatter block (inner YAML), or `""` when it has none.
pub(super) fn trust_line_html(yaml: &str) -> String {
    trust(yaml).map(|t| trust_html(&t)).unwrap_or_default()
}

fn tier_parts(tier: TrustTier) -> (&'static str, &'static str, &'static str) {
    match tier {
        TrustTier::Unverified => (
            "unverified",
            "Unverified",
            "Trust tier (OKF §5.3): nobody has confirmed this Concept",
        ),
        TrustTier::MachineConfirmed => (
            "machine-confirmed",
            "Machine-confirmed",
            "Trust tier (OKF §5.3): confirmed by processes or agents only",
        ),
        TrustTier::HumanReviewed => (
            "human-reviewed",
            "Human-reviewed",
            "Trust tier (OKF §5.3): confirmed by a person",
        ),
    }
}

fn trust_html(t: &Trust) -> String {
    let (class, label, hint) = tier_parts(t.tier);
    let mut parts: Vec<String> = Vec::new();
    if t.trust_keys {
        parts.push(format!(r#"<span class="trust-tier" title="{}">{label}</span>"#, attr_escape(hint)));
    }
    if let Some(g) = &t.generated {
        let by = if t.legacy {
            String::new()
        } else {
            match &g.by {
                Some(b) => format!(" by {}", actor_html(b)),
                None => format!(
                    r#" <span class="trust-missing" title="{}">by unknown</span>"#,
                    attr_escape("`generated` has no `by` (OKF §5.2)")
                ),
            }
        };
        let at = g.at.as_deref().map(|a| format!(" {}", time_html(a, g.iso))).unwrap_or_default();
        let title = if t.legacy {
            format!(r#" title="{}""#, attr_escape("From the legacy `timestamp` (OKF §13.1)"))
        } else {
            String::new()
        };
        parts.push(format!(
            r#"<span class="trust-generated"{title}><span class="trust-label">Generated</span>{by}{at}</span>"#
        ));
    }
    if !t.verified.is_empty() {
        let events: Vec<String> = t
            .verified
            .iter()
            .map(|e| {
                let by = e
                    .by
                    .as_deref()
                    .map(actor_html)
                    .unwrap_or_else(|| r#"<span class="trust-missing">unknown</span>"#.to_string());
                let at = e.at.as_deref().map(|a| format!(" {}", time_html(a, e.iso))).unwrap_or_default();
                format!(r#"<span class="trust-event">{by}{at}</span>"#)
            })
            .collect();
        parts.push(format!(
            r#"<span class="trust-verified"><span class="trust-label">Verified</span> {}</span>"#,
            events.join(" ")
        ));
    }
    let tier = if t.trust_keys { format!(" trust-{class}") } else { String::new() };
    format!(r#"<div class="trust{tier}" data-testid="trust">{}</div>"#, parts.join(" "))
}

/// An actor in the `.actor*` shape `src/lib/actor.ts` builds.
fn actor_html(raw: &str) -> String {
    let a = parse_actor(raw);
    let chip = match a.kind {
        ActorKind::Human => Some("person"),
        ActorKind::Process => Some("process"),
        ActorKind::Agent => Some("agent"),
        ActorKind::Unknown => None,
    };
    let kind = match a.kind {
        ActorKind::Human => "human",
        ActorKind::Process => "process",
        ActorKind::Agent => "agent",
        ActorKind::Unknown => "unknown",
    };
    let text = if chip.is_some() { a.id.as_str() } else { a.raw.as_str() };
    let full = match &a.version {
        Some(v) => format!("{text} {v}"),
        None => text.to_string(),
    };
    let title = match chip {
        Some(c) => format!("{}{}: {full}", c[..1].to_uppercase(), &c[1..]),
        None => text.to_string(),
    };
    let chip_html = chip.map(|c| format!(r#"<span class="actor-kind">{c}</span>"#)).unwrap_or_default();
    let version = a
        .version
        .as_deref()
        .map(|v| format!(r#"<span class="actor-version">{}</span>"#, attr_escape(v)))
        .unwrap_or_default();
    format!(
        r#"<span class="actor actor-{kind}" title="{}">{chip_html}<span class="actor-id">{}</span>{version}</span>"#,
        attr_escape(&title),
        attr_escape(text)
    )
}

/// A datetime: its date when ISO with an offset, else verbatim; full text on hover.
fn time_html(at: &str, iso: bool) -> String {
    let shown = if iso { at.get(..10).unwrap_or(at) } else { at };
    let datetime = if iso { format!(r#" datetime="{}""#, attr_escape(at)) } else { String::new() };
    format!(
        r#"<time class="trust-at"{datetime} title="{}">{}</time>"#,
        attr_escape(at),
        attr_escape(shown)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // The same goldens as `src/lib/trust.test.ts`.
    const GOLDEN_FULL: &str = concat!(
        r#"<div class="trust trust-human-reviewed" data-testid="trust">"#,
        r#"<span class="trust-tier" title="Trust tier (OKF §5.3): confirmed by a person">Human-reviewed</span> "#,
        r#"<span class="trust-generated"><span class="trust-label">Generated</span> by "#,
        r#"<span class="actor actor-agent" title="Agent: reference_agent gemini-2.5-pro"><span class="actor-kind">agent</span>"#,
        r#"<span class="actor-id">reference_agent</span><span class="actor-version">gemini-2.5-pro</span></span> "#,
        r#"<time class="trust-at" datetime="2026-06-20T22:53:05Z" title="2026-06-20T22:53:05Z">2026-06-20</time></span> "#,
        r#"<span class="trust-verified"><span class="trust-label">Verified</span> "#,
        r#"<span class="trust-event"><span class="actor actor-human" title="Person: ahormati"><span class="actor-kind">person</span>"#,
        r#"<span class="actor-id">ahormati</span></span> "#,
        r#"<time class="trust-at" datetime="2026-06-25T09:00:00Z" title="2026-06-25T09:00:00Z">2026-06-25</time></span> "#,
        r#"<span class="trust-event"><span class="actor actor-process" title="Process: nightly"><span class="actor-kind">process</span>"#,
        r#"<span class="actor-id">nightly</span></span> <time class="trust-at" title="soon">soon</time></span></span></div>"#,
    );

    const GOLDEN_NO_BY: &str = concat!(
        r#"<div class="trust trust-unverified" data-testid="trust">"#,
        r#"<span class="trust-tier" title="Trust tier (OKF §5.3): nobody has confirmed this Concept">Unverified</span> "#,
        r#"<span class="trust-generated"><span class="trust-label">Generated</span> "#,
        r#"<span class="trust-missing" title="`generated` has no `by` (OKF §5.2)">by unknown</span> "#,
        r#"<time class="trust-at" title="2026-06-20">2026-06-20</time></span></div>"#,
    );

    const GOLDEN_LEGACY: &str = concat!(
        r#"<div class="trust" data-testid="trust">"#,
        r#"<span class="trust-generated" title="From the legacy `timestamp` (OKF §13.1)"><span class="trust-label">Generated</span> "#,
        r#"<time class="trust-at" datetime="2026-06-15T10:00:00Z" title="2026-06-15T10:00:00Z">2026-06-15</time></span></div>"#,
    );

    #[test]
    fn nothing_without_trust_keys() {
        assert_eq!(trust_line_html("type: x\ntitle: y\n"), "");
    }

    #[test]
    fn full_line_matches_the_editor() {
        let yaml = "generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }\n\
                    verified:\n  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n  - { by: process:nightly, at: soon }\n";
        assert_eq!(trust_line_html(yaml), GOLDEN_FULL);
    }

    #[test]
    fn generated_without_by_degrades_visibly() {
        assert_eq!(trust_line_html("generated:\n  at: 2026-06-20\n"), GOLDEN_NO_BY);
    }

    #[test]
    fn legacy_timestamp_is_the_generation_time() {
        assert_eq!(trust_line_html("timestamp: 2026-06-15T10:00:00Z\n"), GOLDEN_LEGACY);
    }

    #[test]
    fn actor_text_is_escaped() {
        assert!(trust_line_html("verified: { by: \"<b>x\" }\n").contains(r#"<span class="actor-id">&lt;b&gt;x</span>"#));
    }
}
