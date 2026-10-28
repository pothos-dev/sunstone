---
type: Feature
title: Fonts
description: "Choose the fonts and sizes for the interface, text, headings and code, optionally from font files."
tags: [customization]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
  - id: fonts-doc
    resource: https://github.com/pothos-dev/sunstone/blob/main/docs/interface/fonts.md
    title: Fonts (developer docs)
---

# Fonts

Sunstone sets type in four roles, and you can override each one under `fonts` in `config.json`:

| Role | Used for | Default |
|------|----------|---------|
| `ui` | Rails, sidebars, menus, dialogs | Jost, 16 px |
| `content` | Concept text, the Explorer, PDF body | Jost, 14 px |
| `heading` | Headings | The content font |
| `code` | Inline code and code blocks | System monospace |

```json
{
  "fonts": {
    "content": { "family": "Charter, Georgia, serif", "size": 16 },
    "heading": { "family": "Fraunces, Georgia, serif", "files": ["fonts/Fraunces.woff2"] },
    "code":    { "family": "JetBrains Mono, monospace", "size": 0.85 }
  }
}
```

- Every key is optional. A role left out keeps its default.
- `files` are font files next to `config.json` (`.woff2`, `.woff`, `.ttf`, `.otf`). With files, readers don't need the font installed, which matters on the web.
- Zoom scales the configured sizes.

The full rules are in the [font reference](https://github.com/pothos-dev/sunstone/blob/main/docs/interface/fonts.md). The same file sets the [theme colours](/customize/theme-colors.md).
