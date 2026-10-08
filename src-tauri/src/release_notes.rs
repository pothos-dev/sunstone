//! "What's new" after an update.
//!
//! Every build embeds `CHANGELOG.md`. On launch the app records its version in
//! the state store ([`config::record_run_version`]); when the version that ran
//! before is older, the changelog sections between the two are rendered to HTML
//! and handed to the frontend ONCE (`take_release_notes`), which shows them in a
//! dialog. A fresh install shows nothing. A store from before the version was
//! recorded counts as an update and shows only this version's section.

use std::sync::Mutex;

use comrak::{markdown_to_html, Options};
use semver::Version;
use serde::Serialize;
use sunstone_native::config::{self, PreviousRun};

const CHANGELOG: &str = include_str!("../../CHANGELOG.md");

/// The notes the frontend shows once after an update.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    /// The version now running.
    pub version: String,
    /// The changelog sections since the previous version, rendered.
    pub html: String,
}

/// Release notes waiting for the frontend to take them.
#[derive(Default)]
pub struct PendingReleaseNotes(pub Mutex<Option<ReleaseNotes>>);

/// Record this run and work out what to show. Call once from `setup`.
pub fn on_launch() -> PendingReleaseNotes {
    let current = env!("CARGO_PKG_VERSION");
    let previous = config::record_run_version(current);
    PendingReleaseNotes(Mutex::new(notes_for(&previous, current, CHANGELOG)))
}

fn notes_for(previous: &PreviousRun, current: &str, changelog: &str) -> Option<ReleaseNotes> {
    let current_v = Version::parse(current).ok()?;
    let since = match previous {
        PreviousRun::FirstRun => return None,
        PreviousRun::Unrecorded => None,
        PreviousRun::Version(v) => {
            let v = Version::parse(v).ok()?;
            if v >= current_v {
                return None;
            }
            Some(v)
        }
    };
    let markdown = sections_between(changelog, since.as_ref(), &current_v);
    if markdown.trim().is_empty() {
        return None;
    }
    Some(ReleaseNotes {
        version: current.to_string(),
        html: markdown_to_html(&markdown, &Options::default()),
    })
}

/// The changelog sections for versions after `since` up to and including
/// `upto`, newest first, with each `## [x.y.z] - date` heading rewritten to a
/// plain `## x.y.z`. `since: None` takes `upto`'s section alone.
fn sections_between(changelog: &str, since: Option<&Version>, upto: &Version) -> String {
    let mut out = String::new();
    let mut keep = false;
    for line in changelog.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            let version = heading
                .trim_start_matches('[')
                .split(']')
                .next()
                .and_then(|v| Version::parse(v.trim()).ok());
            keep = version.as_ref().is_some_and(|v| {
                v <= upto && since.map_or(v == upto, |since| v > since)
            });
            if let (true, Some(v)) = (keep, version) {
                out.push_str(&format!("## {v}\n"));
            }
            continue;
        }
        if keep {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "# Changelog\n\nIntro.\n\n\
        ## [0.3.0] - 2026-01-03\n\n### Added\n\n- Three.\n\n\
        ## [0.2.0] - 2026-01-02\n\n### Fixed\n\n- Two.\n\n\
        ## [0.1.0] - 2026-01-01\n\n- One.\n";

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn takes_the_sections_after_the_previous_version() {
        let md = sections_between(LOG, Some(&v("0.1.0")), &v("0.3.0"));
        assert!(md.starts_with("## 0.3.0\n"));
        assert!(md.contains("- Three.") && md.contains("## 0.2.0") && md.contains("- Two."));
        assert!(!md.contains("One.") && !md.contains("Intro."));
    }

    #[test]
    fn an_unrecorded_previous_version_takes_the_current_section_only() {
        let md = sections_between(LOG, None, &v("0.2.0"));
        assert_eq!(md.trim(), "## 0.2.0\n\n### Fixed\n\n- Two.");
    }

    #[test]
    fn notes_only_after_an_update() {
        let up = notes_for(&PreviousRun::Version("0.2.0".into()), "0.3.0", LOG).unwrap();
        assert_eq!(up.version, "0.3.0");
        assert!(up.html.contains("<li>Three.</li>") && !up.html.contains("Two."));

        assert_eq!(notes_for(&PreviousRun::FirstRun, "0.3.0", LOG), None);
        assert_eq!(notes_for(&PreviousRun::Version("0.3.0".into()), "0.3.0", LOG), None);
        // A downgrade shows nothing.
        assert_eq!(notes_for(&PreviousRun::Version("0.4.0".into()), "0.3.0", LOG), None);
        // A version with no changelog section shows nothing.
        assert_eq!(notes_for(&PreviousRun::Version("0.3.0".into()), "0.3.1", LOG), None);
        assert!(notes_for(&PreviousRun::Unrecorded, "0.1.0", LOG).is_some());
    }

    #[test]
    fn the_embedded_changelog_has_a_section_for_this_version() {
        let md = sections_between(CHANGELOG, None, &v(env!("CARGO_PKG_VERSION")));
        assert!(!md.trim().is_empty());
    }
}
