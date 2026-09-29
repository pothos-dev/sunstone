// Pure state helpers for the web reader's narrow-screen (phone) layout. Below
// the `NARROW_MAX_WIDTH` breakpoint `WebReader.svelte` turns both Sidebars into
// slide-over drawers and folds the rails' controls into the concept strip and
// an overflow menu. The layout switch itself is pure CSS (so the SSR first
// paint is already right on a phone); this module owns the small transient
// state the drawers and the menu need. None of it is persisted — the desktop
// layout's `leftSidebarOpen` / `rightSidebarOpen` stay untouched.

/** Breakpoint (px) at or below which the reader uses the drawer layout. Keep in
 *  step with the `@media (max-width: …)` blocks in `WebReader.svelte`. */
export const NARROW_MAX_WIDTH = 768;

/** Which drawer is open, if any. At most one at a time. */
export type Drawer = 'left' | 'right' | null;

/** Tap on a drawer button: open that side, or close it when it is already
 *  open. Opening one side closes the other. */
export function toggleDrawer(current: Drawer, side: 'left' | 'right'): Drawer {
  return current === side ? null : side;
}

/** The layer an Escape press closes, innermost first: an open dialog (quick nav
 *  / search) handles Escape itself, so the reader leaves it alone; otherwise the
 *  overflow menu, then a drawer. `null` = nothing for the reader to close. */
export function escapeTarget(state: {
  dialogOpen: boolean;
  menuOpen: boolean;
  drawer: Drawer;
}): 'menu' | 'drawer' | null {
  if (state.dialogOpen) return null;
  if (state.menuOpen) return 'menu';
  if (state.drawer !== null) return 'drawer';
  return null;
}
