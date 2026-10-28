---
type: Feature
title: Footnotes and sources
description: "Footnotes, cited sources and their hover cards."
tags: [editor, links, okf]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Footnotes and sources

## Footnotes

A `[^label]` reference renders as a superscript. Clicking it jumps to the matching `[^label]:` definition and briefly highlights it. A reference without a definition shows as broken.

## Sources

A Concept can list what it is based on under `sources` in its [frontmatter](/editing/frontmatter.md), as [OKF](/okf/okf-support.md) defines:

```yaml
sources:
  - id: ga4-schema
    resource: https://developers.google.com/analytics/bigquery/export-schema
    title: GA4 BigQuery Export schema
```

A footnote whose label matches a source's `id` cites that source. Sunstone then shows:

- a **Sources** list at the end of the page, numbered like the footnotes that cite them. Uncited sources follow without a number. The list is only displayed, never written to the file.
- a **hover card** on each citation and each Sources entry, with the source's title, resource, author and dates. Clicking it opens the source: another Concept, or a web address.
- for each entry: who wrote it, when it last changed, how often it was used, links back to every place in the text that cites it, and an **Edit** button that jumps to the entry in the frontmatter.

This page cites its own source the same way.[^changelog]

Inline `[n]` citations that follow a word also render as clickable superscripts.
