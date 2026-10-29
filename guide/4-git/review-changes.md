---
type: Feature
title: Review changes
description: "Compare your edits with the last commit and step through a file's history."
tags: [git]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Review changes

Turn on **Review** to see the open Concept's working copy compared with the last commit (`HEAD`), as inline track changes. Scattered word edits show as [CriticMarkup](/2-editing/comments.md) insertions and deletions.

A history stepper walks back through the file's commits one revision at a time.

Review works wherever the Bundle is a git repository: on the desktop, under [`sunstone serve`](/1-getting-started/run-in-browser.md) and, for signed-in users, on [Sunstone Web](/5-web/sunstone-web.md).
