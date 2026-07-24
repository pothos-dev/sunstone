# 02 — Left activity rail (desktop)

**What to build:** A thin, always-visible activity rail down the far-left edge of the desktop shell, holding the application-global controls that don't belong to any open concept. From top: a menu button (☰, stub for now), quick-nav, and search — each a clickable icon that opens the existing QuickNav (⌘K) and SearchPanel (Ctrl+Shift+F) respectively. An avatar/login slot is reserved at the bottom but stays empty on desktop. Existing keybindings continue to work unchanged. The rail is additive in this ticket — the NavBar is still present.

**Blocked by:** None — can start immediately.

**Status:** done

- [ ] A rail component renders as a fixed-width vertical strip on the far left of the desktop shell, always visible (independent of sidebar open/closed state).
- [ ] Quick-nav icon opens the existing QuickNav palette; search icon opens the existing SearchPanel. Both still respond to their keyboard shortcuts.
- [ ] A menu (☰) button exists as a stub (no menu contents required yet).
- [ ] A bottom-pinned avatar/login slot exists but is empty on desktop.
- [ ] Icons have accessible labels/tooltips and stable `data-testid`s for Playwright.
- [ ] `bun test src/lib`, `bun run check`, `cargo test`, `cargo check` all green.

## Comments

- The rail becomes the future home for a real app menu and (on web) login/avatar; keep the layout extensible.
- This and 03 both restructure the App shell grid; 03 is sequenced after this one to avoid conflicting edits.
