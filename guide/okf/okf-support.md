---
type: Feature
title: OKF support
description: "What Sunstone understands about OKF bundles: validation, trust, lifecycle, sources and attested computations."
tags: [okf, frontmatter, trust]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# OKF support

The [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) is an open standard for markdown bundles that humans and agents read the same way: markdown with YAML frontmatter and links. If you can `cat` a file you can read it; if you can `git clone` you can ship it.

Sunstone supports OKF v0.2. A Bundle opts in by declaring `okf_version` in its root `index.md`, as this guide does. A plain folder of markdown works too: it just doesn't get the OKF-specific help.

## What you get

- **[Frontmatter](/editing/frontmatter.md) checks.** Missing required fields and wrongly typed values are flagged, and keys and values are completed.
- **New Bundle…** in the launcher and the Bundle switcher creates a Bundle that declares `okf_version`.
- **Trust at a glance.** A Concept's trust, lifecycle and sources show as one compact pill next to its title. Hover it to see who generated and verified the Concept and when, its status, whether it's stale, and its sources.
- **Actors.** Authors, generators and verifiers are shown as a person, a process, or an agent with its version.
- **Lifecycle.** `status: draft`, `status: deprecated` and an expired `stale_after` are marked in the [Explorer](/navigating/explorer.md) and the page header.
- **Sources.** Cited sources become a numbered list with hover cards (see [Footnotes and sources](/editing/footnotes-and-sources.md)).
- **Attested computations.** A Concept of type Attested Computation shows its contract (runtime, parameters, executor, attester) in a card, with its `# Computation` section set apart.
- **Index and log files.** `index.md` and `log.md` are recognised as reserved files.

Sunstone's handling of a few spec details is documented in [the OKF notes](https://github.com/pothos-dev/sunstone/tree/main/docs/okf) in the repository.
