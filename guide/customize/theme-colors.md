---
type: Feature
title: Theme colours
description: "Override the base colours of the light and dark schemes."
tags: [customization]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
  - id: theme-doc
    resource: https://github.com/pothos-dev/sunstone/blob/main/docs/interface/theme-colors.md
    title: Theme colours (developer docs)
---

# Theme colours

Sunstone has a warm amber palette and follows your system's light or dark setting. Each scheme is built from twelve base colours, and you can override any of them per scheme. Every other colour is derived from them.

```json
{
  "colors": {
    "light": { "accent": "#2b7fd9", "bg": "#f4f7fb" },
    "dark":  { "accent": "#5aa2f0" }
  }
}
```

The full list of base colours is in the [theme colour reference](https://github.com/pothos-dev/sunstone/blob/main/docs/interface/theme-colors.md). The same file sets the [fonts](/customize/fonts.md).
