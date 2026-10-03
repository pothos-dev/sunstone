---
status: done
---

# ui-1: Switch Bundles without restarting

**What to build:** a user with a Bundle already open can jump to another one from inside the editor. Today the known-folder list only appears at startup when Sunstone launched with no path — once a Bundle is open, the only way to reach a different one is to quit and relaunch. This ticket gives that same list a second entry point: an overlay over the open editor, opened by a hotkey and by a visible affordance, offering the same most-recently-opened folders under the same auto-focused fuzzy filter.

The backend seam already supports this — opening a folder is an in-process operation followed by a webview reload, and that is exactly how the startup launcher already switches from no-Bundle to Bundle. What is missing is purely the entry point and the overlay presentation, so this is a frontend slice over an existing contract.

Two behaviours differ from the startup launcher and are the substance of the ticket. The currently-open Bundle must be identifiable in the list rather than offered as a destination that does nothing. And because switching reloads the webview, an open Concept with unsaved changes must not lose them — the switch either flushes pending writes first or is refused with a clear reason.

Present it as an overlay in the manner of quick-nav, not as a replacement shell: Escape dismisses it through the unified peel, and dismissing leaves the current Bundle and the active Tile exactly as they were. Note that the global hotkey router's branch order is load-bearing, so a new intent has to be placed deliberately rather than appended.

This is desktop-only. The web shell serves a single Bundle and has no known-folder list, so the affordance must not appear there.

- [x] A hotkey and a visible affordance both open a Bundle switcher over the open editor
- [x] The switcher lists previously-opened folders most-recently-opened first, filtered by the same fuzzy path matching and match highlighting as the startup launcher, with no duplicated row-building logic
- [x] The currently-open Bundle is marked as current and selecting it is a no-op that closes the overlay
- [x] Choosing another folder opens it and lands in the editor on that Bundle, with its own View state restored
- [x] A Concept with unsaved changes never loses them across a switch
- [x] A folder can be forgotten from the switcher, and "Open folder…" reaches the native picker, matching the startup launcher
- [x] Escape dismisses the overlay through the unified Escape peel and restores focus to the Region that had it
- [x] The switcher does not appear in the web shell
- [x] Playwright covers open, filter, switch and dismiss over the fake backend
- [x] All four gates green

## Decisions

- Presentation → a popover anchored to a new icon at the top of the left
  activity rail, in the shape of the startup launcher (auto-focused fuzzy
  filter, ↑/↓/Enter, title over path, forget ×, "Open folder…"). Chosen from a
  three-variant prototype (Menu / Palette / Panel) on the throwaway branch
  `prototype/bundle-switcher`; the user picked Palette.
- Hotkey → Ctrl/Cmd+O ("open folder"), routed right after quick-nav and Search
  so it cannot shadow any later branch.
- Unsaved changes → every open Document is flushed through the save gate
  before switching; if one still cannot be written (frontmatter that does not
  parse holds the write), the switch is refused and names the Concept.
- The current Bundle cannot be forgotten from the switcher (no × on its row).


## Comments

- 2026-10-02 — Prototype on the throwaway branch `prototype/bundle-switcher`
  (`src/lib/components/BundleSwitcher.prototype.svelte`): a left-rail icon
  opening one of three dropdowns via `?variant=A|B|C` — A Menu (compact, no
  filter), B Palette (the launcher as a popover), C Panel (full-height flyout
  with a current card and Recent / Missing groups).
- 2026-10-03 — Verdict: B, Palette. Built as `BundleSwitcher.svelte`; the
  title-over-path row label is shared with the launcher as
  `KnownBundleLabel.svelte`. The rail button does not take focus on mousedown,
  so a cancel returns focus to the Region that had it. The fake backend's
  `bundleRoot` now reports the folder opened this session so the switcher can
  mark it current; it does not model per-Bundle View state (the Rust store
  keys it by root, as before).
