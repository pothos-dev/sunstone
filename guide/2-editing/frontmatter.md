---
type: Feature
title: Frontmatter
description: "Edit a Concept's YAML frontmatter in place, with folding and OKF-aware checks."
tags: [editor, okf]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Frontmatter

A Concept's frontmatter is the YAML block at the top of the file. Sunstone shows it as a YAML editor above the text, so what you see is exactly what's in the file.

```yaml
---
type: Playbook
title: Rollout plan
tags: [release, ops]
---
```

## Folding

Nested blocks fold, and a folded block says what it hides ("3 entries", "2 keys"). Long blocks such as `sources` and `verified` start folded when a Concept opens.

## Checks and completion

In a Bundle that declares an [OKF](/6-okf/okf-support.md) version, the editor knows the spec. It flags missing required fields and wrongly typed values, and completes keys and values as you type. In a plain folder of markdown it only checks YAML syntax.

## Dates

Dates in the frontmatter read as relative times ("3 days ago"). Hover one for the exact date and time.
