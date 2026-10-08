---
type: Concept
title: Theme colours — the palette and user overrides
description: The twelve base colours each scheme is built from, the tokens derived from them, and how a user overrides any base colour per scheme in config.json, on the desktop and on Sunstone Web.
tags: [interface, theme, colours, config]
timestamp: 2026-10-08
---

# Theme colours

Sunstone's palette lives in `src/app.css` as CSS custom properties, one block for the light scheme and one for the dark. Each scheme sets **twelve base colours**. Every other colour token is derived from them with `color-mix()`, so changing a base colour carries through to everything built on it.

| Config key | Token | Derived from it |
| ---------- | ----- | --------------- |
| `bg` | `--bg` | `--bg-gradient` |
| `bgElevated` | `--bg-elevated` | `--bg-gradient` |
| `bgSunken` | `--bg-sunken` | `--bg-gradient` |
| `text` | `--text` | `--hover` |
| `textMuted` | `--text-muted` | |
| `textFaint` | `--text-faint` | |
| `border` | `--border` | |
| `borderStrong` | `--border-strong` | |
| `accent` | `--accent` | `--accent-soft`, `--accent-ring`, `--tag-bg` |
| `accentContrast` | `--accent-contrast` | `--danger-contrast` |
| `danger` | `--danger` | |
| `tagText` | `--tag-text` | |

The `--atomic-editor-*` tokens the editor reads are aliases of these. What stays fixed per scheme and cannot be overridden: `--region-active` (a white wash), the shadows, the syntax-highlight colours (`--atomic-editor-hl-*`), and the CriticMarkup colours.

## Overriding colours

Set any base colour, per scheme, under `colors` in `config.json`. On the desktop (and under `sunstone serve`) that is `~/.config/sunstone/config.json` in the OS config dir; on Sunstone Web it is the file named by `SUNSTONE_CONFIG` ([deployment guide](../../docker/README.md#colours-and-fonts)). The same file sets the [fonts](fonts.md). It is yours: Sunstone reads it and never writes it. Its session data lives separately in `state.json` ([View state](view-state.md)).

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
- The desktop reads the file when a window opens, so restart Sunstone (or reopen a Bundle) to see changes. Sunstone Web reads it on every page load.
- If the file is not valid JSON, Sunstone logs a warning and uses the default palette.

## How it is applied

Rust returns the `colors` and `fonts` values of `config.json` as opaque JSON (`sunstone_native::appearance::load`; the `load_appearance` command on the desktop, `GET /_api/appearance` on the web). The frontend fetches them through `Backend.loadAppearance`, and `appearanceCss` (`src/lib/state/appearance.ts`) validates the colours (`parseThemeColors` in `src/lib/state/themeColors.ts`, checking values with `CSS.supports('color', …)`). `loadAppearance` in `state/theme.svelte.ts` then appends a `<style id="sunstone-appearance">` after `app.css` that re-declares the overridden tokens for each scheme. On the web the SSR hook inlines the same stylesheet into the page first, with a syntax-only colour check (`isSafeColorSyntax`), and the client replaces it after mounting. See [Fonts](fonts.md#how-it-is-applied) for the shared pipeline.
