---
type: Feature
title: Settings
description: "Change the theme, colours, fonts, how a Bundle first opens, and keyboard shortcuts from the settings page."
tags: [customization]
sources:
  - id: settings-doc
    resource: https://github.com/pothos-dev/sunstone/blob/main/docs/interface/settings.md
    title: Settings page (developer docs)
---

# Settings

Open the settings with the gear at the bottom of the left rail, or press Ctrl+, (Cmd+, on a Mac). The settings page is part of the desktop app. Under `sunstone serve` and on Sunstone Web, the colour theme, colours and fonts from `config.json` still apply; the mode, layout defaults and shortcuts are desktop only.

Changes apply as you make them and are saved straight away. There is no Save button. Each setting you have changed has a dot next to it, and the reset arrow takes it back to the default.

- **Appearance:** follow the system's light or dark setting, or always use one. Pick a colour theme: Sunstone, Solarized, Nord, Gruvbox, Catppuccin, Rosé Pine, GitHub or Tokyo Night. Under the themes, *Your own colours* changes single colours on top of the theme, separately for light and dark.
- **Fonts:** the font and size for the interface, the text of a Concept, and code, and the font for headings. Type any font installed on your computer.
- **Layout:** which sidebars and sections are open, whether frontmatter and titles show, and whether Concepts open in Read or Editing mode, for a Bundle you open for the first time. A Bundle you have opened before keeps the layout you left it in.
- **Keyboard:** click a shortcut and press the new keys. Backspace removes a shortcut, Escape cancels. If the keys are already used by something else, the page says so. Zoom, undo and redo, Escape and moving between areas with Alt+arrows can't be changed.

## Where the settings are saved

The settings page writes `~/.config/sunstone/config.json`, the same file you can [edit by hand](/7-customize/index.md). It only changes the settings you change on the page. Anything else in the file stays as you wrote it, including font files you listed yourself.
