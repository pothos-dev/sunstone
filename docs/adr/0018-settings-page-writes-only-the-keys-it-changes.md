---
type: Decision
title: "The settings page writes config.json, but only the keys the user changes"
description: "Sunstone now writes the user's config.json from the settings page, one edited leaf at a time, so hand-written keys, values and key order survive."
tags: [adr, decision, config]
---

# The settings page writes config.json, but only the keys the user changes

Until now `config.json` (`~/.config/sunstone/config.json`) was the user's file: Sunstone read
`colors` and `fonts` from it and never wrote it. Its own state went to `state.json`. The desktop
now has a settings page (theme mode, colour theme, single colours, fonts, how a Bundle opens the
first time, keyboard shortcuts), and its changes are saved to `config.json`.

The page records one edit per leaf it changes (`["fonts", "code", "family"]` → `"Inter"`, or a
removal for "reset to default"), and `sunstone_native::settings` applies exactly those edits to
the file. Every other key, every value the user wrote by hand (font `files`, a `$comment`, keys
Sunstone does not know) and the order of the keys survive. A reset removes the key, then any
object the removal left empty. Only the settings keys (`theme`, `colorTheme`, `colors`, `fonts`,
`defaults`, `keybindings`) can be edited, and a file that is not valid JSON is never overwritten.

## Considered Options

- **Write only the edited leaves into config.json (chosen).** One file the user can still edit
  by hand and read, and the settings page shows the same values. The cost is that Sunstone now
  writes the file: `serde_json` must keep key order (`preserve_order`), and the file is
  re-indented with two spaces when it is written.
- **Write the page's settings to a second file and layer config.json over it.** Rejected: two
  sources for one setting, and a value set in config.json would silently beat the page, so the
  page could show one thing while the app did another.
- **Keep the settings in `state.json`.** Rejected for the same reason, and `state.json` is
  Sunstone's own store, rewritten wholesale; its values are not meant to be edited by hand.
- **Rewrite the whole file from the page's state.** Rejected: it would drop or reorder whatever
  the user wrote that the page does not show.

## Consequences

- Formatting is not preserved byte for byte: a save re-indents the file. Comments are not
  possible in JSON. The file is parsed and written back whole, so a few spellings change even
  in keys the page never touches: a number is written in `serde_json`'s form (`1e3` becomes
  `1000.0`, an integer beyond 64 bits loses precision) and a duplicated key keeps its last value.
  Values Sunstone's own keys use are unaffected.
- A symlinked config.json (as dotfile managers make it) is written through to its target, and
  the file keeps its permissions.
- `theme` (System / Light / Dark) moves from `state.json`'s `AppConfig.theme`, which nothing
  read, to `config.json`.
- A colour theme is stored as its id (`"colorTheme": "nord"`), not as twelve colours, so the
  file says which theme was picked; `colors` still overrides single colours on top of it.
- The web and `sunstone serve` keep reading their config and have no settings page.
