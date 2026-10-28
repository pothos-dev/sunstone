---
type: Feature
title: Links
description: "Wikilinks and markdown links, heading anchors, folder links, and links that follow a rename."
tags: [editor, links]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Links

Links are what turn a folder of files into a wiki. Sunstone understands both styles:

```markdown
[[Rollout plan]]              wikilink, resolved by name across the Bundle
[[Rollout plan#Risks]]        to a heading
[[Rollout plan|the plan]]     with display text
[the plan](/plans/rollout.md) markdown link, from the Bundle root
[guide](guide/)               a folder: opens its index.md
```

## Heading anchors

Anchors resolve by slug, GitHub style: `[[Page#deep-section]]` jumps to a `## Deep Section` heading.

## Links follow renames

Renaming or moving a Concept rewrites the links that point to it, everywhere in the Bundle. Renaming a heading rewrites the anchors that point to it and shows a short summary. Deleting a heading leaves its anchors alone, so they show as broken rather than silently pointing somewhere else.

## Broken links

A link whose target doesn't exist is styled as broken but stays clickable. Broken links are allowed: they're a natural way to mark a page you haven't written yet.

## Backlinks

The [Backlinks](/navigating/outline-and-backlinks.md) panel lists every Concept that links to the one you're reading.

External `http(s)`, `mailto` and `tel` links open in your default browser.
