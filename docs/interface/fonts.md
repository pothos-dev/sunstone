---
type: Concept
title: Fonts — the three type roles and user overrides
description: The UI, content and code type roles, their default families and sizes, and how a user overrides each one, with optional font files, in config.json on the desktop and on Sunstone Web.
tags: [interface, theme, fonts, typography, config]
timestamp: 2026-10-08
---

# Fonts

Sunstone sets type in three **roles**. Each has a family and a base size, declared on `html` in `src/app.css`:

| Role | Used for | Family token | Default family | Size token | Default size |
| ---- | -------- | ------------ | -------------- | ---------- | ------------ |
| `ui` | Chrome: rails, Sidebars, menus, dialogs, the web reader's chrome | `--font-ui` | Jost | `--font-ui-size` | `16px` (the root size every `rem` derives from) |
| `content` | Concept prose in the editor, the rendered article, the Explorer tree, the print/PDF body | `--font-content` | Jost | `--font-content-size` | `14px` |
| `code` | Inline code and fenced code blocks | `--font-mono` | the system monospace stack | `--font-code-scale` | unset: `1` in the editor, `0.9` in the rendered article |

Each role also has a private family name (`'Sunstone UI'`, `'Sunstone Content'`, `'Sunstone Code'`) for its font files. It is put in front of the role's stack only when the config lists files for that role (see below). The default stacks never name it: WebKitGTK, the Linux desktop's engine, lets fontconfig substitute an unknown family rather than move on to the next one, so a private name with no `@font-face` behind it replaced Jost with the system's default sans.

## Overriding fonts

Set any role under `fonts` in the same `config.json` that holds the [colour overrides](theme-colors.md): `~/.config/sunstone/config.json` on the desktop (and under `sunstone serve`), and the file named by `SUNSTONE_CONFIG` on Sunstone Web ([deployment guide](../../docker/README.md#colours-and-fonts)).

```json
{
  "fonts": {
    "ui":      { "family": "Inter, system-ui, sans-serif", "size": 15, "files": ["fonts/Inter.woff2"] },
    "content": { "family": "Charter, Georgia, serif", "size": 16 },
    "code":    {
      "family": "JetBrains Mono, monospace",
      "size": 0.85,
      "files": [
        { "src": "fonts/JetBrainsMono.woff2", "weight": "100 800" },
        { "src": "fonts/JetBrainsMono-Italic.woff2", "weight": "100 800", "style": "italic" }
      ]
    }
  }
}
```

- Every key is optional. A role or field left out keeps its default. Roles do not inherit from each other: setting only `ui.family` leaves the content in Jost.
- `family` is a CSS `font-family` list: comma-separated names, quoted or not. Anything else (a `;`, a `url()`, an unterminated quote) is ignored.
- `size` for `ui` and `content` is in px at 100% zoom (`ui`: 8–32, `content`: 8–48). The UI zoom (Ctrl +/-) multiplies it. For `code` it is a factor of the surrounding text (0.5–2), so code in a heading stays in proportion.
- `files` lists font files relative to the config's directory: a path, or `{ "src", "weight", "style" }` for a family split across files. `weight` takes a number, a range like `"100 900"` for a variable font, `normal` or `bold`; `style` is `normal`, `italic` or `oblique`. Only `.woff2`, `.woff`, `.ttf` and `.otf` are accepted, and no path may leave the directory or pass through a hidden (`.`-prefixed) folder.
- With files, the role uses them before any installed font, even when `family` is not set. Without files, `family` only works if the viewer has the font installed. On the web that is the reader's machine, not the server, so a fallback list matters there.
- Invalid entries are dropped and the rest still applies. If the file is not valid JSON, Sunstone logs a warning and uses the defaults.
- On the desktop the config is read when a window opens, so reopen the Bundle (or restart) after editing it. Sunstone Web reads it on every page load.

## How it is applied

1. Rust returns `colors` and `fonts` from the config verbatim (`sunstone_native::appearance::load`): through the `load_appearance` command on the desktop, and `GET /_api/appearance` from [sunstone-server](/architecture/sunstone-server.md).
2. `appearanceCss` (`src/lib/state/appearance.ts`) validates them (`parseFonts` in `state/fonts.ts`, `parseThemeColors` in `state/themeColors.ts`) and builds one stylesheet: an `@font-face` per file under the role's private name, then a `:root` rule re-declaring the overridden tokens. `loadAppearance` (`state/theme.svelte.ts`) installs it as `<style id="sunstone-appearance">` after `app.css`.
3. On the web, `hooks.server.ts` already inlines that stylesheet into the SSR `<head>`, so the first paint has the configured fonts and colours. The client replaces it after mounting, this time checking colours with `CSS.supports`.
4. Each shell serves the font files itself: the desktop over the `sunstone-font://` scheme (`src-tauri/src/font.rs`), the web at `GET /_api/appearance/font?file=` (`Backend.fontUrl`). Both go through `appearance::font_file`, which serves a file only if the current config lists it, it has a font extension, and it resolves inside the config's directory.
5. The zoom store writes `calc(var(--font-ui-size) * zoom)` and the matching content sizes onto `<html>`, so zoom scales the configured sizes.
