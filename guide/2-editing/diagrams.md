---
type: Feature
title: Diagrams
description: "Mermaid, D2 and PlantUML code blocks rendered as diagrams."
tags: [editor]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Diagrams

Fenced code blocks in three diagram languages render as diagrams. They work in Live and Read mode, in [Sunstone Web](/5-web/sunstone-web.md) and in [PDF export](/2-editing/pdf-export.md).

| Language | Fence | Notes |
|----------|-------|-------|
| [Mermaid](https://mermaid.js.org/) | ` ```mermaid ` | Flowcharts, sequence diagrams, state diagrams and more. |
| [D2](https://d2lang.com/) | ` ```d2 ` | External icons are never fetched. |
| [PlantUML](https://plantuml.com/) | ` ```plantuml ` | `@startuml` is optional. Including from the standard library (`!include <C4/…>`) isn't supported yet. |

Diagrams are drawn in the app's colours and follow a switch between light and dark. Colours you set in the diagram yourself are kept. Each renderer loads only when a Concept actually contains such a block, and everything renders on your machine: nothing is sent to a server.

Double-click a diagram (or switch to Source) to edit it. An invalid diagram shows the error inline, next to its source.

```d2
direction: right
write: Write a d2 block
render: Sunstone renders it
write -> render
```
