---
status: ready-for-agent
---

# 01: Switch Bundles without restarting

**What to build:** a user with a Bundle already open can jump to another one from inside the editor. Today the known-folder list only appears at startup when Sunstone launched with no path — once a Bundle is open, the only way to reach a different one is to quit and relaunch. This ticket gives that same list a second entry point: an overlay over the open editor, opened by a hotkey and by a visible affordance, offering the same most-recently-opened folders under the same auto-focused fuzzy filter.

The backend seam already supports this — opening a folder is an in-process operation followed by a webview reload, and that is exactly how the startup launcher already switches from no-Bundle to Bundle. What is missing is purely the entry point and the overlay presentation, so this is a frontend slice over an existing contract.

Two behaviours differ from the startup launcher and are the substance of the ticket. The currently-open Bundle must be identifiable in the list rather than offered as a destination that does nothing. And because switching reloads the webview, an open Concept with unsaved changes must not lose them — the switch either flushes pending writes first or is refused with a clear reason.

Present it as an overlay in the manner of quick-nav, not as a replacement shell: Escape dismisses it through the unified peel, and dismissing leaves the current Bundle and the active Tile exactly as they were. Note that the global hotkey router's branch order is load-bearing, so a new intent has to be placed deliberately rather than appended.

This is desktop-only. The web shell serves a single Bundle and has no known-folder list, so the affordance must not appear there.

- [ ] A hotkey and a visible affordance both open a Bundle switcher over the open editor
- [ ] The switcher lists previously-opened folders most-recently-opened first, filtered by the same fuzzy path matching and match highlighting as the startup launcher, with no duplicated row-building logic
- [ ] The currently-open Bundle is marked as current and selecting it is a no-op that closes the overlay
- [ ] Choosing another folder opens it and lands in the editor on that Bundle, with its own View state restored
- [ ] A Concept with unsaved changes never loses them across a switch
- [ ] A folder can be forgotten from the switcher, and "Open folder…" reaches the native picker, matching the startup launcher
- [ ] Escape dismisses the overlay through the unified Escape peel and restores focus to the Region that had it
- [ ] The switcher does not appear in the web shell
- [ ] Playwright covers open, filter, switch and dismiss over the fake backend
- [ ] All four gates green
