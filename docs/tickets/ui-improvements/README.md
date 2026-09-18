# UI improvements

Desktop-shell affordances that are missing rather than broken — capability the
backend already supports but that has no entry point in the open editor.

Decisions that bind the tickets here:

- **Overlay, not a replacement shell.** New surfaces present in the manner of
  quick-nav: an auto-focused filter over the open editor, dismissed through the
  unified peel, leaving the current Bundle and the active Tile as they were.
- **Desktop only unless stated.** The web shell serves a single Bundle and has
  no known-folder list, so affordances built on local state must not appear
  there.
- **The hotkey router's branch order is load-bearing.** A new intent is placed
  deliberately, not appended.

Out of scope: visual redesign, theming, and anything that changes the Bundle's
contents.
