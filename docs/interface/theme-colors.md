---
type: Concept
title: Theme colours — the palette and user overrides
description: The twelve base colours each scheme is built from, the tokens derived from them, and how a user overrides any base colour per scheme in the desktop config store.
tags: [interface, theme, colours, config]
timestamp: 2026-09-30
---

# Theme colours

Sunstone's palette lives in `src/app.css` as CSS custom properties, one block for the light scheme and one for the dark. Each scheme sets **twelve base colours**. Every other colour token is derived from them with `color-mix()`, so changing a base colour carries through to everything built on it.

| Config key | Token | Derived from it |
| ---------- | ----- | --------------- |
| `bg` | `--bg` | `--bg-gradient` |
| `bgElevated` | `--bg-elevated` | `--bg-gradient` |
| `bgSunken` | `--bg-sunken` | `--bg-gradient` (dark) |
| `text` | `--text` | `--hover` |
| `textMuted` | `--text-muted` | |
| `textFaint` | `--text-faint` | |
| `border` | `--border` | |
| `borderStrong` | `--border-strong` | |
| `accent` | `--accent` | `--accent-soft`, `--accent-ring`, `--tag-bg`, `--bg-gradient` (light) |
| `accentContrast` | `--accent-contrast` | `--danger-contrast` |
| `danger` | `--danger` | |
| `tagText` | `--tag-text` | |

The `--atomic-editor-*` tokens the editor reads are aliases of these. What stays fixed per scheme and cannot be overridden: `--region-active` (a white wash), the shadows, the syntax-highlight colours (`--atomic-editor-hl-*`), and the CriticMarkup colours.

## Overriding colours

On desktop, set any base colour, per scheme, under `colors` in `~/.config/sunstone/config.json` (the OS config dir). This file is yours: Sunstone reads it and never writes it. Its session data lives separately in `state.json` ([View state](view-state.md)).

```json
{
  "colors": {
    "light": { "accent": "#2b7fd9", "bg": "#f4f7fb" },
    "dark": { "accent": "#5aa2f0" }
  }
}
```

- Every key is optional. A key left out keeps the default for that scheme, and an override for one scheme never touches the other.
- Values are any CSS colour (`#hex`, `rgb()`, `oklch()`, a colour name, …). Unknown keys and invalid values are ignored.
- Changes are read at startup, so restart Sunstone (or reopen a Bundle) to see them.
- If the file is not valid JSON, Sunstone logs a warning and uses the default palette.

The web build has no config store and always uses the default palette (see the [deployment guide](../../docker/README.md#theme-colours-not-configurable-on-the-web)).

## How it is applied

Rust returns the `colors` value of `config.json` as opaque JSON (`load_theme_colors`, `crates/sunstone-native/src/config.rs`). The frontend fetches it through `Backend.loadThemeColors`, validates it (`parseThemeColors` in `src/lib/state/themeColors.ts`, checking values with `CSS.supports('color', …)`), and `loadThemeColors` in `state/theme.svelte.ts` appends a `<style id="sunstone-theme-colors">` after `app.css` that re-declares the overridden tokens for each scheme.
