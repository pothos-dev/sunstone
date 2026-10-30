---
type: Concept
title: Settings page
description: The desktop settings dialog, the store behind it, how its changes reach config.json one edited key at a time, and the rebindable keyboard shortcuts.
tags: [interface, settings, config, keyboard]
---

# Settings page

The desktop has a settings dialog, opened from the gear at the bottom of the left
[Activity Rail](activity-rail.md) or with Ctrl/Cmd+, (itself rebindable). It is a sidebar of
sections, each a component under `src/lib/components/settings/`:

| Section | Component | config.json keys |
| ------- | --------- | ---------------- |
| Appearance | `AppearancePage` | `theme` (`light` / `dark`; absent = follow the system) |
| Appearance › Colour theme | `ColorThemePage` | `colorTheme`, `colors.<light\|dark>.<key>` |
| Fonts | `FontsPage` | `fonts.<role>.family`, `fonts.<role>.size` |
| Layout | `LayoutPage` | `defaults.<toggle>`, `defaults.editorMode` |
| Keyboard | `KeyboardPage` | `keybindings.<command>` |

The web and `sunstone serve` have no settings page (`SETTINGS_EDITABLE` in
`state/settings.svelte.ts`); they keep reading their config as before.

## Saving: only what was changed

`state/settings.svelte.ts` holds `config.json` as loaded (`Backend.loadConfig`) and the edits
not yet written. Each control sets or resets one leaf: `settings.set(path, value)` or
`settings.reset(path)` (remove the key, back to the built-in default). Setting a leaf to what the
file already holds drops the edit. A debounced flush sends the batch to
`Backend.saveConfigEdits`, and `sunstone_native::settings` applies those `ConfigEdit`s to the
file and nothing else ([ADR-0018](/adr/0018-settings-page-writes-only-the-keys-it-changes.md)).
Closing the dialog flushes at once. A failed write shows above the section and keeps the edits
pending.

`settings.config` is the file with the pending edits applied, and everything reads it, so a
change shows before it is written: the theme mode feeds `theme.mode`, `installAppearance`
re-applies colours and fonts, the keyboard router reads `settings.keybindings`.

## Colour themes

`state/themePresets.ts` lists the themes (Sunstone, Solarized, Nord, Gruvbox, Catppuccin,
Rosé Pine, GitHub, Tokyo Night), each a full set of the twelve base colours for both schemes.
`appearanceCss` lays the chosen preset under the user's own `colors`, so a single changed colour
still wins. Sunstone is `app.css` itself: choosing it removes `colorTheme` and emits nothing.
See [Theme colours](theme-colors.md).

## Layout defaults

`settings/panelDefaults.ts`: which Sidebars and Sections are expanded, whether frontmatter and
titles show, and the editor mode, for a Bundle opened the first time. `sessionFromBundleState`
uses them only for fields the Bundle's [View state](view-state.md) lacks, so a Bundle opened
before keeps its own layout.

## Keyboard shortcuts

`settings/keybindings.ts` lists the rebindable commands, each with a scope (`app`: the window
router in `appHotkeys.ts`; `editor`: the formatting keys, only while an editor has focus) and a
default chord written the CodeMirror way (`Mod-Shift-f`). In the editor `Mod` is the platform's key only, Cmd on macOS and Ctrl elsewhere, so macOS keeps Ctrl+E and Ctrl+B for moving the cursor; the app's global shortcuts accept either, as they always have.
`keybindings.<id>` in config.json overrides one: a chord, or `null` to unbind. Both the router
and the editor match at keydown time, so a rebinding applies at once.

A recorded shortcut needs Ctrl, Cmd or Alt (function keys excepted): a bare letter or Space would fire while typing. Recording the default again, in either spelling (`Ctrl-Alt-ArrowLeft` and `Mod-Alt-ArrowLeft` are one chord off macOS), removes the override. Tooltips that name a shortcut read the current binding.

Zoom, undo/redo, Escape and Alt+arrows are fixed. They are listed on the page, and a rebinding
onto one of them (or onto another command) is flagged, not refused. Paragraph ships unbound:
Mod-0 is Reset zoom, and a heading key pressed on its own level already turns it back into a
paragraph.

The dialog owns its keys while it has focus: App's global handler skips events from inside it
(`data-settings-dialog`), so recording Ctrl+K rebinds instead of opening Quick open. Escape
cancels a recording, then leaves the subpage, then closes the dialog.
